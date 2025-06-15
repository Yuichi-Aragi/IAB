import { App, Notice } from 'obsidian';
import { BuildInitiator, ProjectSettings } from '../types';
import { container, ServiceTokens } from '../utils/DIContainer';
import { EventBus } from '../services/EventBus';
import { Logger } from '../utils/Logger';
import { SettingsService } from '../services/SettingsService';
import { EsbuildService } from './EsbuildService';
import { PluginError, BuildProcessError, BuildCancelledError, ProjectValidationError, EsbuildInitializationError, createChainedMessage } from '../errors/CustomErrors';

import { BuildContext } from './build/BuildContext';
import { DiagnosticManager } from './build/DiagnosticManager';
import { ProjectAssetCollector } from './build/ProjectAssetCollector';
import { DependencyFetcher } from './build/DependencyFetcher';
import { Compiler } from './build/Compiler';
import { OutputWriter } from './build/OutputWriter';
import { FileService } from '../services/FileService';
import { NetworkService } from '../services/NetworkService';
import { BuildStateService } from '../services/BuildStateService';
import { InAppBuilderPlugin } from './InAppBuilderPlugin';

export class BuildService {
    private app: App;

    // --- Service Accessors ---
    private get logger(): Logger { return container.resolve<Logger>(ServiceTokens.Logger); }
    private get settingsService(): SettingsService { return container.resolve<SettingsService>(ServiceTokens.SettingsService); }
    private get esbuildService(): EsbuildService { return container.resolve<EsbuildService>(ServiceTokens.EsbuildService); }
    private get eventBus(): EventBus { return container.resolve<EventBus>(ServiceTokens.EventBus); }
    private get fileService(): FileService { return container.resolve<FileService>(ServiceTokens.FileService); }
    private get networkService(): NetworkService { return container.resolve<NetworkService>(ServiceTokens.NetworkService); }
    private get buildStateService(): BuildStateService { return container.resolve<BuildStateService>(ServiceTokens.BuildStateService); }
    private get plugin(): InAppBuilderPlugin { return container.resolve<InAppBuilderPlugin>(ServiceTokens.Plugin); }

    // --- Build Pipeline Components ---
    private readonly diagnosticManager: DiagnosticManager;
    private readonly assetCollector: ProjectAssetCollector;
    private readonly dependencyFetcher: DependencyFetcher;
    private readonly compiler: Compiler;
    private readonly outputWriter: OutputWriter;

    private currentBuildContext: BuildContext | null = null;

    constructor(app: App) {
        this.app = app;

        // Instantiate the build pipeline components, passing their dependencies.
        this.diagnosticManager = new DiagnosticManager(this.plugin);
        this.assetCollector = new ProjectAssetCollector(this.fileService, this.logger);
        this.dependencyFetcher = new DependencyFetcher(this.networkService, this.logger);
        this.compiler = new Compiler(this.esbuildService, this.logger, this.networkService);
        this.outputWriter = new OutputWriter(this.app, this.fileService, this.logger);
    }

    public async triggerBuild(projectId: string, initiator: BuildInitiator = 'command'): Promise<void> {
        this._acquireBuildLock(projectId, initiator);
        const context = this.currentBuildContext!; // Lock acquisition ensures this is non-null

        try {
            if (initiator === 'settings-tab') new Notice(`Build started for '${context.diagnostics.projectName}'...`, 4000);
            context.logAnalysis('info', `Build started for project '${context.diagnostics.projectName}'.`, { initiator });

            await this._ensureEsbuildInitialized(context);
            context.cancellationToken.throwIfCancelled();

            await this.assetCollector.collect(context);
            context.cancellationToken.throwIfCancelled();

            await this.dependencyFetcher.fetch(context);
            context.cancellationToken.throwIfCancelled();

            const { outputCode, sourceMapContent } = await this.compiler.compile(context);
            context.cancellationToken.throwIfCancelled();

            const outputPath = await this.outputWriter.write(context, outputCode, sourceMapContent);

            this.eventBus.publish({ type: 'BUILD_SUCCEEDED', payload: { projectId, outputPath, initiator } });
            this.logger.log('info', `[${context.diagnostics.projectName}] Build process completed successfully!`);
            context.logAnalysis('info', 'Build process completed successfully!', { outputPath });
            this.buildStateService.clear(projectId);

        } catch (error: unknown) {
            const buildError = error instanceof PluginError ? error : new BuildProcessError(createChainedMessage('Unknown critical error during build process.', error), error instanceof Error ? error : undefined);
            
            if (error instanceof BuildCancelledError) {
                this.logger.log('warn', `[${context.diagnostics.projectName}] Build process was cancelled.`);
                context.logAnalysis('warn', 'Build process was cancelled.');
            } else {
                this.logger.log('error', `[${context.diagnostics.projectName}] Critical error during build:`, buildError);
                context.logAnalysis('error', `Critical error during build: ${buildError.message}`, buildError);
                this.eventBus.publish({ type: 'BUILD_FAILED', payload: { projectId, error: buildError.message, initiator } });
            }

            context.diagnostics.finalError = {
                message: buildError.message,
                stack: buildError.stack,
                context: buildError.context,
                cause: buildError.cause ? String(buildError.cause) : undefined,
            };
            const finalDiagnosticInfo = this.diagnosticManager.formatFinalDiagnosticString(context.diagnostics);
            this.buildStateService.set(projectId, finalDiagnosticInfo);

        } finally {
            this._releaseBuildLock();
        }
    }

    public cancelCurrentBuild(): void {
        if (this.currentBuildContext) {
            this.logger.log('warn', `[${this.currentBuildContext.diagnostics.projectName}] Build cancellation requested.`);
            this.currentBuildContext.logAnalysis('warn', 'Build cancellation requested by user.');
            this.currentBuildContext.cancellationToken.cancel();
        }
    }

    private _acquireBuildLock(projectId: string, initiator: BuildInitiator): void {
        if (this.currentBuildContext) {
            const otherProjectName = this.currentBuildContext.diagnostics.projectName;
            throw new BuildProcessError(`Another build is already in progress: "${otherProjectName}".`, undefined, { activeProjectId: this.currentBuildContext.projectId, attemptedProjectId: projectId, concurrent: true });
        }
        
        const project = this.settingsService.getSettings().projects.find(p => p.id === projectId);
        if (!project) throw new ProjectValidationError(`Project not found for build with ID: ${projectId}.`);

        this.buildStateService.clear(projectId);
        this.eventBus.publish({ type: 'BUILD_STARTED', payload: { projectId, initiator } });

        this.currentBuildContext = new BuildContext(
            project,
            initiator,
            this.diagnosticManager.createInitialDiagnostics(project, initiator),
            this.eventBus
        );

        this.logger.log('info', `[${project.name}] Build lock acquired. State transitioned to 'preparing'.`);
        this.currentBuildContext.logAnalysis('verbose', 'Build lock acquired. State: preparing.');
    }

    private _releaseBuildLock(): void {
        if (this.currentBuildContext) {
            const projectName = this.currentBuildContext.diagnostics.projectName;
            this.logger.log('info', `[${projectName}] Releasing build lock. Build process finished.`);
            this.currentBuildContext.logAnalysis('verbose', 'Build lock released. Build process finished.');
            this.currentBuildContext = null;
        }
    }

    private async _ensureEsbuildInitialized(context: BuildContext): Promise<void> {
        if (this.esbuildService.isInitialized() && this.esbuildService.getEsbuildAPI()) {
            context.logAnalysis('verbose', 'esbuild service already initialized.');
            return;
        }

        this.logger.log('warn', `[${context.diagnostics.projectName}] Esbuild not initialized. Attempting initialization...`);
        context.logAnalysis('info', 'Esbuild not initialized. Attempting on-demand initialization...');
        try {
            const showNotices = context.initiator === 'settings-tab';
            await this.esbuildService.initializeEsbuild(context.projectId, showNotices);
            if (!this.esbuildService.isInitialized() || !this.esbuildService.getEsbuildAPI()) {
                throw new EsbuildInitializationError(`Esbuild failed to initialize for project "${context.diagnostics.projectName}" despite attempt.`);
            }
            this.logger.log('info', `[${context.diagnostics.projectName}] Esbuild initialized successfully for build.`);
            context.logAnalysis('info', 'Esbuild initialized successfully.');
        } catch (err: unknown) {
            const initError = err instanceof EsbuildInitializationError ? err : new EsbuildInitializationError(createChainedMessage(`On-demand esbuild initialization failed for "${context.diagnostics.projectName}".`, err), err instanceof Error ? err : undefined);
            context.logAnalysis('error', 'On-demand esbuild initialization failed.', initError);
            throw initError;
        }
    }
}