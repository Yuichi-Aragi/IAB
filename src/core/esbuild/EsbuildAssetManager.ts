/**
 * @file Orchestrates the acquisition of esbuild assets by fetching them from CDN.
 */

import { EsbuildCdnFetcher } from './EsbuildCdnFetcher';
import { Logger } from '../../utils/Logger';
import { PluginSettings } from '../../types';
import { EsbuildAssets } from './types';
import { Notice } from 'obsidian';

export class EsbuildAssetManager {
    private cdnFetcher: EsbuildCdnFetcher;
    private logger: Logger;

    constructor(cdnFetcher: EsbuildCdnFetcher, logger: Logger) {
        this.cdnFetcher = cdnFetcher;
        this.logger = logger;
    }

    /**
     * Gets the esbuild assets by fetching them from the configured CDN.
     * @param settings The current plugin settings.
     * @param generationChecker A function to check for stale initializations.
     * @param logPrefix A prefix for log messages.
     * @param showNotices Whether to show Obsidian notices during the process.
     * @returns The acquired esbuild assets.
     */
    public async getAssets(settings: PluginSettings, generationChecker: (stage: string) => void, logPrefix: string, showNotices: boolean): Promise<EsbuildAssets> {
        // --- Stage 1: Fetch from CDN ---
        if (showNotices) new Notice('Fetching esbuild from CDN...', 3000);
        const { jsContent, wasmBuffer } = await this.cdnFetcher.fetchAssets(settings, generationChecker, logPrefix);

        // --- Stage 2: Compile WASM ---
        if (showNotices) new Notice('Compiling esbuild WebAssembly...', 3000);
        const wasmModule = await WebAssembly.compile(wasmBuffer);
        generationChecker("After WASM compilation");

        return { jsContent, wasmModule };
    }
}