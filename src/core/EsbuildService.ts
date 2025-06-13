/**
 * @file Manages the lifecycle of the esbuild WebAssembly service.
 *       This service acts as a facade, orchestrating several helper components to
 *       fetch, cache, and initialize esbuild. It handles complex race conditions
 *       and provides a stable API to the rest of the plugin.
 */

import { App, Notice } from 'obsidian';
import { EsbuildAPI, PendingInitializeCallback, PluginSettings } from '../types';
import { Logger } from '../utils/Logger';
import { SettingsService } from '../services/SettingsService';
import { EsbuildInitializationError, PluginError, createChainedMessage } from '../errors/CustomErrors';
import { container, ServiceTokens } from '../utils/DIContainer';
import { EventBus } from '../services/EventBus';
import { EsbuildStatus } from '../types/events';
import { InAppBuilderPlugin } from './InAppBuilderPlugin';

// --- New Decomposed Component Imports ---
import { EsbuildAssetManager } from './esbuild/EsbuildAssetManager';
import { EsbuildCacheManager } from './esbuild/EsbuildCacheManager';
import { EsbuildCdnFetcher } from './esbuild/EsbuildCdnFetcher';
import { EsbuildInitializer } from './esbuild/EsbuildInitializer';

interface ExtendedPendingInitializeCallback extends PendingInitializeCallback {
    targetGeneration: number;
}

export class EsbuildService {
    private app: App;
    private plugin: InAppBuilderPlugin;
    private get logger(): Logger { return container.resolve<Logger>(ServiceTokens.Logger); }
    private get settingsService(): SettingsService { return container.resolve<SettingsService>(ServiceTokens.SettingsService); }
    private get eventBus(): EventBus { return container.resolve<EventBus>(ServiceTokens.EventBus); }

    // --- Decomposed Components ---
    private cacheManager: EsbuildCacheManager;
    private assetManager: EsbuildAssetManager;
    private initializer: EsbuildInitializer;

    // --- State Management ---
    private esbuild: EsbuildAPI | null = null;
    private status: EsbuildStatus = 'uninitialized';
    private initializingEsbuildPromise: Promise<void> | null = null;
    private pendingInitializeCallbacks: ExtendedPendingInitializeCallback[] = [];
    private lastInitializationError: EsbuildInitializationError | null = null;

    // --- Generation-based Locking ---
    private promiseGeneration: number = 0;
    private masterGeneration: number = 0;

    constructor(app: App, plugin: InAppBuilderPlugin) {
        this.app = app;
        this.plugin = plugin;

        // Instantiate the new components, passing their dependencies from the DI container.
        this.cacheManager = new EsbuildCacheManager(
            container.resolve(ServiceTokens.FileService),
            this.logger
        );
        const cdnFetcher = new EsbuildCdnFetcher(
            container.resolve(ServiceTokens.NetworkService),
            this.logger
        );
        this.assetManager = new EsbuildAssetManager(
            this.cacheManager,
            cdnFetcher,
            this.logger
        );
        this.initializer = new EsbuildInitializer(this.logger);
    }

    // --- Public API (Unchanged) ---

    public getEsbuildAPI(): EsbuildAPI | null {
        return this.esbuild;
    }

    public isInitialized(): boolean {
        return this.status === 'initialized';
    }

    public isInitializing(): boolean {
        return this.status === 'initializing';
    }

    public getLastInitializationError(): EsbuildInitializationError | null {
        return this.lastInitializationError;
    }

    public async clearCacheAndReinitialize(initiatorId: string = 'CacheClear'): Promise<void> {
        this.logger.log('info', `Clearing esbuild asset cache triggered by: ${initiatorId}.`);
        try {
            await this.cacheManager.clearCache();
            new Notice(`Cache directory "${this.cacheManager.getCacheDir()}" moved to trash.`);
        } catch (e: unknown) {
            const errorMessage = `Failed to delete cache directory "${this.cacheManager.getCacheDir()}".`;
            this.logger.log('error', errorMessage, e);
            new Notice(`Error clearing cache. Check console for details.`, 7000);
        }
        
        this.unload();
        await this.initializeEsbuild(initiatorId, true);
    }

    public initializeEsbuild(initiatorId: string = 'Unknown', showNotices: boolean = false): Promise<void> {
        const currentGeneration = ++this.masterGeneration;
        const logPrefix = `[EsbuildInit:${initiatorId}|Gen:${currentGeneration}]`;
        this.logger.log('info', `${logPrefix} Initialization requested.`);

        if (this.status === 'initialized' && this.promiseGeneration >= currentGeneration) {
            this.logger.log('info', `${logPrefix} Esbuild already initialized. Resolving immediately.`);
            return Promise.resolve();
        }

        if (this.status === 'initializing' && this.initializingEsbuildPromise) {
            this.logger.log('info', `${logPrefix} Initialization (active gen ${this.promiseGeneration}) already in progress. Queuing callback.`);
            return new Promise<void>((resolve, reject) => {
                this.pendingInitializeCallbacks.push({ resolve, reject, projectId: initiatorId, targetGeneration: this.promiseGeneration });
            });
        }

        this.logger.log('info', `${logPrefix} Starting new esbuild initialization process...`);
        this._resetStateForNewInit(currentGeneration);
        this.publishStatus('initializing');

        this.initializingEsbuildPromise = this._performInitialization(currentGeneration, logPrefix, showNotices);
        return this.initializingEsbuildPromise;
    }

    public unload(): void {
        const unloadGeneration = ++this.masterGeneration;
        const logPrefix = `[EsbuildUnload|Gen:${unloadGeneration}]`;
        this.logger.log('info', `${logPrefix} Unloading and cleaning up resources.`);

        if (this.esbuild && typeof this.esbuild.stop === 'function' && this.status === 'initialized') {
            this.logger.log('info', `${logPrefix} Stopping esbuild service.`);
            try {
                this.esbuild.stop();
            } catch (e: unknown) {
                this.logger.log('warn', `${logPrefix} Error stopping esbuild service during unload:`, e);
            }
        }

        this.initializer.cleanup(logPrefix);

        this.rejectPendingCallbacks(
            new EsbuildInitializationError("EsbuildService unloaded.", undefined, { unloaded: true }),
            logPrefix,
            true // Force reject all generations.
        );
        
        this._resetStateForNewInit(unloadGeneration);
        this.publishStatus('uninitialized');
        
        this.logger.log('info', `${logPrefix} EsbuildService cleanup complete.`);
    }

    // --- Private Implementation (Refactored) ---

    private async _performInitialization(generation: number, logPrefix: string, showNotices: boolean): Promise<void> {
        try {
            if (!this.app.workspace.layoutReady) {
                this.logger.log('info', `${logPrefix} Obsidian workspace not yet ready. Waiting...`);
                await new Promise<void>((resolve, reject) => {
                    const eventRef = this.app.workspace.on('layout-ready', () => {
                        this.app.workspace.offref(eventRef);
                        try {
                            this._checkStaleInitialization(generation, logPrefix, "After layout-ready");
                            this.logger.log('info', `${logPrefix} Workspace is ready. Proceeding.`);
                            resolve();
                        } catch (error) {
                            reject(error);
                        }
                    });
                    this.plugin.registerEvent(eventRef);
                });
            }
            this._checkStaleInitialization(generation, logPrefix, "After workspace ready check");

            const settings = this.settingsService.getSettings();
            if (showNotices) new Notice('Acquiring esbuild assets...', 3000);

            const generationChecker = (stage: string) => this._checkStaleInitialization(generation, logPrefix, stage);

            // Delegate asset acquisition to the AssetManager
            const assets = await this.assetManager.getAssets(settings, generationChecker, logPrefix, showNotices);
            this._checkStaleInitialization(generation, logPrefix, "After asset acquisition");

            if (showNotices) new Notice('Starting esbuild service...', 3000);

            // Delegate initialization to the Initializer
            this.esbuild = await this.initializer.initialize(assets, generationChecker, logPrefix);

            // --- Success ---
            this.status = 'initialized';
            this.lastInitializationError = null;
            this.logger.log('info', `${logPrefix} esbuild initialized successfully.`);
            this.publishStatus('initialized');
            if (showNotices) new Notice('esbuild service initialized successfully.', 3000);
            this.resolvePendingCallbacks(generation, logPrefix);

        } catch (error: unknown) {
            const initError = error instanceof EsbuildInitializationError ? error :
                              error instanceof PluginError ? new EsbuildInitializationError(createChainedMessage('Esbuild initialization failed.', error), error.cause || error, error.context) :
                              new EsbuildInitializationError(createChainedMessage('Unknown error during esbuild initialization.', error), error instanceof Error ? error : undefined);
            
            this.logger.log('error', `${logPrefix} Initialization failed:`, initError);
            
            if (this.promiseGeneration === generation && !initError.context?.aborted) {
                this.lastInitializationError = initError;
                this.status = 'error';
                this.publishStatus('error', initError);
                if (showNotices) {
                    new Notice(`${initError.message.substring(0, 150)}... Check console.`, 15000);
                }
            } else {
                 this.logger.log('info', `${logPrefix} This initialization attempt was aborted or superseded. Error not shown to user.`);
            }
            
            this.rejectPendingCallbacks(initError, logPrefix, false, generation);
            
            if (this.promiseGeneration === generation) {
                this._resetStateForNewInit(generation + 1);
            }
            throw initError;
        } finally {
            if (this.promiseGeneration === generation) {
                this.initializingEsbuildPromise = null;
            }
        }
    }

    private _resetStateForNewInit(generation: number): void {
        this.promiseGeneration = generation;
        this.esbuild = null;
        this.status = 'uninitialized';
        this.lastInitializationError = null;
        this.initializingEsbuildPromise = null;
    }

    private _checkStaleInitialization(currentTaskGeneration: number, logPrefix: string, stage: string): void {
        if (this.masterGeneration !== currentTaskGeneration) {
            const message = `Initialization task (gen ${currentTaskGeneration}) aborted at stage "${stage}" due to newer request (latest gen ${this.masterGeneration}).`;
            this.logger.log('warn', `${logPrefix} ${message}`);
            throw new EsbuildInitializationError(message, undefined, { aborted: true, stage });
        }
    }

    private resolvePendingCallbacks(completedGeneration: number, logPrefix: string): void {
        const callbacksToRun = this.pendingInitializeCallbacks.filter(cb => cb.targetGeneration === completedGeneration);
        this.pendingInitializeCallbacks = this.pendingInitializeCallbacks.filter(cb => cb.targetGeneration !== completedGeneration);

        if (callbacksToRun.length > 0) {
            this.logger.log('verbose', `${logPrefix} Resolving ${callbacksToRun.length} pending callbacks for generation ${completedGeneration}.`);
            callbacksToRun.forEach(cb => {
                try {
                    cb.resolve();
                } catch (e) {
                    this.logger.log('error', `${logPrefix} Error in pendingInitializeCallback (resolve) for ${cb.projectId || 'N/A'}:`, e);
                }
            });
        }
    }

    private rejectPendingCallbacks(reason: Error, logPrefix: string, forceRejectAll: boolean, failedGeneration?: number): void {
        let callbacksToReject: ExtendedPendingInitializeCallback[];

        if (forceRejectAll) {
            callbacksToReject = [...this.pendingInitializeCallbacks];
            this.pendingInitializeCallbacks = [];
            if (callbacksToReject.length > 0) {
                this.logger.log('warn', `${logPrefix} Force rejecting all ${callbacksToReject.length} pending callbacks.`);
            }
        } else {
            callbacksToReject = this.pendingInitializeCallbacks.filter(cb => cb.targetGeneration === failedGeneration);
            this.pendingInitializeCallbacks = this.pendingInitializeCallbacks.filter(cb => cb.targetGeneration !== failedGeneration);
            if (callbacksToReject.length > 0) {
                this.logger.log('verbose', `${logPrefix} Rejecting ${callbacksToReject.length} pending callbacks for generation ${failedGeneration}.`);
            }
        }
        
        callbacksToReject.forEach(cb => {
            try {
                cb.reject(reason);
            } catch (e) {
                this.logger.log('error', `${logPrefix} Error in pendingInitializeCallback (reject) for ${cb.projectId || 'N/A'}:`, e);
            }
        });
    }

    private publishStatus(status: EsbuildStatus, error?: EsbuildInitializationError | null): void {
        this.status = status;
        this.eventBus.publish({ type: 'ESBUILD_STATUS_CHANGED', payload: { status, error } });
    }
}
