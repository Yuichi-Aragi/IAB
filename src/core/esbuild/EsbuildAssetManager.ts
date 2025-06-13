/**
 * @file Orchestrates the acquisition of esbuild assets, using a cache-first strategy.
 */

import { EsbuildCacheManager } from './EsbuildCacheManager';
import { EsbuildCdnFetcher } from './EsbuildCdnFetcher';
import { Logger } from '../../utils/Logger';
import { PluginSettings } from '../../types';
import { EsbuildAssets } from './types';
import { Notice } from 'obsidian';

export class EsbuildAssetManager {
    private cacheManager: EsbuildCacheManager;
    private cdnFetcher: EsbuildCdnFetcher;
    private logger: Logger;

    constructor(cacheManager: EsbuildCacheManager, cdnFetcher: EsbuildCdnFetcher, logger: Logger) {
        this.cacheManager = cacheManager;
        this.cdnFetcher = cdnFetcher;
        this.logger = logger;
    }

    /**
     * Gets the esbuild assets, trying the cache first and falling back to CDN.
     * @param settings The current plugin settings.
     * @param generationChecker A function to check for stale initializations.
     * @param logPrefix A prefix for log messages.
     * @param showNotices Whether to show Obsidian notices during the process.
     * @returns The acquired esbuild assets.
     */
    public async getAssets(settings: PluginSettings, generationChecker: (stage: string) => void, logPrefix: string, showNotices: boolean): Promise<EsbuildAssets> {
        // --- Stage 1: Attempt to load from cache ---
        if (settings.enableCache) {
            const cachedAssets = await this.cacheManager.loadFromCache(generationChecker, logPrefix);
            if (cachedAssets) {
                return cachedAssets;
            }
        } else {
            this.logger.log('info', `${logPrefix} Cache is disabled. Skipping cache check.`);
        }

        // --- Stage 2: Fallback to CDN ---
        if (showNotices) new Notice('Fetching esbuild from CDN...', 3000);
        const { jsContent, wasmBuffer } = await this.cdnFetcher.fetchAssets(settings, generationChecker, logPrefix);

        if (showNotices) new Notice('Compiling esbuild WebAssembly...', 3000);
        const wasmModule = await WebAssembly.compile(wasmBuffer);

        // --- Stage 3: Save to cache if enabled ---
        if (settings.enableCache) {
            await this.cacheManager.saveToCache(jsContent, wasmBuffer, generationChecker, logPrefix);
        }

        return { jsContent, wasmModule };
    }
}
