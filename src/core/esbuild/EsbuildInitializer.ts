/**
 * @file Handles the final stage of esbuild initialization: script injection and service startup.
 */

import { Logger } from '../../utils/Logger';
import { EsbuildAssets } from './types';
import { EsbuildAPI, EsbuildInitializeOptions } from '../../types';
import { INJECTED_ESBUILD_SCRIPT_ID } from '../../constants';
import { EsbuildInitializationError } from '../../errors/CustomErrors';

export class EsbuildInitializer {
    private logger: Logger;

    constructor(logger: Logger) {
        this.logger = logger;
    }

    /**
     * Injects the esbuild script, waits for the API to be available, and initializes the service.
     * @param assets The acquired esbuild JS and WASM assets.
     * @param generationChecker A function to check for stale initializations.
     * @param logPrefix A prefix for log messages.
     * @returns The initialized esbuild API object.
     */
    public async initialize(assets: EsbuildAssets, generationChecker: (stage: string) => void, logPrefix: string): Promise<EsbuildAPI> {
        this._injectScript(assets.jsContent, logPrefix);
        generationChecker("After script injection");

        await this._waitForEsbuildApi(logPrefix, generationChecker);
        generationChecker("After API appeared on window");

        if (typeof window === 'undefined' || !window.esbuild) {
            throw new EsbuildInitializationError('window.esbuild not found after waiting.', undefined, { stage: 'api_assignment' });
        }
        const esbuild = window.esbuild;
        this.logger.log('info', `${logPrefix} esbuild API (v${esbuild.version || 'unknown'}) available. Initializing service...`);

        const initializeOptions: EsbuildInitializeOptions = { wasmModule: assets.wasmModule, worker: true };
        const initializePromise = esbuild.initialize(initializeOptions);
        const timeoutPromise = new Promise<void>((_, reject) => {
            setTimeout(() => {
                reject(new EsbuildInitializationError(`esbuild.initialize() timed out after 30s.`, undefined, { stage: 'service_initialize_timeout' }));
            }, 30000);
        });

        await Promise.race([initializePromise, timeoutPromise]);
        generationChecker("After esbuild.initialize() call");

        return esbuild;
    }

    /**
     * Cleans up resources created by the initializer, such as the injected script tag.
     * @param logPrefix A prefix for log messages.
     */
    public cleanup(logPrefix: string): void {
        if (typeof window !== 'undefined' && window.esbuild) {
            try {
                window.esbuild = undefined;
                this.logger.log('verbose', `${logPrefix} Cleared window.esbuild reference.`);
            } catch (e: unknown) {
                this.logger.log('warn', `${logPrefix} Error cleaning up window.esbuild (minor):`, e);
            }
        }

        const injectedScript = document.getElementById(INJECTED_ESBUILD_SCRIPT_ID);
        if (injectedScript) {
            try {
                injectedScript.remove();
                this.logger.log('verbose', `${logPrefix} Removed injected esbuild script tag.`);
            } catch (e: unknown) {
                this.logger.log('warn', `${logPrefix} Error removing injected esbuild script (minor):`, e);
            }
        }
    }

    private _injectScript(scriptContent: string, logPrefix: string): void {
        this.logger.log('verbose', `${logPrefix} Injecting and executing esbuild.min.js content...`);
        try {
            document.getElementById(INJECTED_ESBUILD_SCRIPT_ID)?.remove();
            const script = document.createElement('script');
            script.id = INJECTED_ESBUILD_SCRIPT_ID;
            script.type = 'text/javascript';
            script.textContent = scriptContent;
            document.head.appendChild(script);
        } catch (domError) {
            this.logger.log('error', `${logPrefix} Critical DOM error during script injection.`, domError);
            throw new EsbuildInitializationError('Failed to inject esbuild script into the DOM.', domError, { stage: 'script_injection' });
        }
    }

    private async _waitForEsbuildApi(logPrefix: string, generationChecker: (stage: string) => void): Promise<void> {
        this.logger.log('verbose', `${logPrefix} Waiting for window.esbuild to become available...`);
        for (let i = 0; i < 100; i++) {
            generationChecker(`Waiting for API, attempt ${i + 1}`);
            if (typeof window !== 'undefined' && window.esbuild && typeof window.esbuild.initialize === 'function') {
                this.logger.log('verbose', `${logPrefix} window.esbuild API is now available.`);
                return;
            }
            await new Promise(resolve => setTimeout(resolve, 100));
        }
        throw new EsbuildInitializationError('window.esbuild API not available after script injection and 10s delay.', undefined, { source: 'apiWaitFail' });
    }
}
