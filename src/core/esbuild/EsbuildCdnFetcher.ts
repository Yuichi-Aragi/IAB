/**
 * @file Handles fetching esbuild assets from configured CDN URLs.
 */

import { NetworkService } from '../../services/NetworkService';
import { Logger } from '../../utils/Logger';
import { PluginSettings } from '../../types';
import { DEFAULT_ESBUILD_JS_CDN_URL, DEFAULT_ESBUILD_WASM_CDN_URL } from '../../constants';
import { NetworkError, EsbuildInitializationError } from '../../errors/CustomErrors';

export class EsbuildCdnFetcher {
    private networkService: NetworkService;
    private logger: Logger;

    constructor(networkService: NetworkService, logger: Logger) {
        this.networkService = networkService;
        this.logger = logger;
    }

    /**
     * Fetches both the JS and WASM assets from their respective CDN URLs.
     * @param settings The current plugin settings containing the CDN URLs.
     * @param generationChecker A function to call to check if the initialization is stale.
     * @param logPrefix A prefix for log messages.
     * @returns An object containing the JS content string and the WASM ArrayBuffer.
     */
    public async fetchAssets(settings: PluginSettings, generationChecker: (stage: string) => void, logPrefix: string): Promise<{ jsContent: string, wasmBuffer: ArrayBuffer }> {
        this.logger.log('info', `${logPrefix} Fetching assets from CDN.`);
        
        const jsContentPromise = this._fetchJsFromCdn(settings, logPrefix, generationChecker);
        const wasmBufferPromise = this._fetchWasmFromCdn(settings, logPrefix, generationChecker);

        const [jsContent, wasmBuffer] = await Promise.all([jsContentPromise, wasmBufferPromise]);
        generationChecker("After CDN asset fetch");

        this.logger.log('info', `${logPrefix} Successfully fetched assets from CDN.`);
        return { jsContent, wasmBuffer };
    }

    private async _fetchJsFromCdn(settings: PluginSettings, logPrefix: string, generationChecker: (stage: string) => void): Promise<string> {
        const url = settings.esbuildJsCdnUrl || DEFAULT_ESBUILD_JS_CDN_URL;
        this.logger.log('info', `${logPrefix} Fetching JS from CDN: ${url}`);
        generationChecker("Before CDN JS fetch");
        try {
            const response = await this.networkService.requestUrlWithTimeout({ url, method: 'GET' });
            if (response.status === 200) return response.text;
            throw new NetworkError(`CDN fetch failed (status ${response.status}) for ${url}`);
        } catch (error) {
            throw new EsbuildInitializationError(`Failed to fetch esbuild.min.js from CDN: ${url}`, error, { assetName: 'esbuild.min.js' });
        }
    }

    private async _fetchWasmFromCdn(settings: PluginSettings, logPrefix: string, generationChecker: (stage: string) => void): Promise<ArrayBuffer> {
        const url = settings.esbuildWasmCdnUrl || DEFAULT_ESBUILD_WASM_CDN_URL;
        this.logger.log('info', `${logPrefix} Fetching WASM from CDN: ${url}`);
        generationChecker("Before CDN WASM fetch");
        try {
            const response = await this.networkService.requestUrlWithTimeout({ url, method: 'GET' });
            if (response.status === 200) return response.arrayBuffer;
            throw new NetworkError(`CDN fetch failed (status ${response.status}) for WASM ${url}`);
        } catch (error) {
            throw new EsbuildInitializationError(`Failed to fetch esbuild.wasm from CDN: ${url}`, error, { assetName: 'esbuild.wasm' });
        }
    }
}
