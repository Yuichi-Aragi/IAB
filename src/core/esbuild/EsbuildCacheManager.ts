/**
 * @file Manages all file system interactions for the esbuild asset cache.
 *       This class is responsible for reading, writing, and clearing cached assets.
 *       It uses a chunking strategy with a manifest file to handle large WASM assets
 *       and ensure data integrity, overcoming file size limitations in Obsidian's APIs.
 */

import { FileService } from '../../services/FileService';
import { Logger } from '../../utils/Logger';
import { VaultPathResolver } from '../../utils/VaultPathResolver';
import { CACHE_DIR, CACHE_CHUNK_SIZE_BYTES } from '../../constants';
import { EsbuildAssets } from './types';
import { calculateStringHashSHA256, calculateStringHashFNV1aSync, calculateArrayBufferHashFNV1aSync } from '../../utils/FileContentUtils';

// --- New Cache Structure and Constants ---

/** The current version of the cache file format. Incrementing this will invalidate old caches. */
const CACHE_FORMAT_VERSION = '2.0.0';
const MANIFEST_FILE_NAME = 'cache-manifest.json';
const JS_FILE_NAME = 'esbuild.js';
const WASM_CHUNK_PREFIX = 'esbuild.wasm.part';

/**
 * Defines the structure of the manifest file used for caching esbuild assets.
 * Includes versioning for future-proofing and hashes for data integrity.
 */
interface CacheManifest {
    version: string;
    createdAt: string;
    js: {
        fileName: string;
        hash: string; // Hash of the JS content string
    };
    wasm: {
        totalSize: number;
        chunkSize: number;
        assemblyHash: string; // Hash of the complete, reassembled WASM file
        chunks: {
            fileName: string;
            hash: string; // Hash of this specific chunk
        }[];
    };
}

export class EsbuildCacheManager {
    private fileService: FileService;
    private logger: Logger;

    private readonly cacheDir = CACHE_DIR;
    private readonly manifestFilePath = VaultPathResolver.join(this.cacheDir, MANIFEST_FILE_NAME);

    constructor(fileService: FileService, logger: Logger) {
        this.fileService = fileService;
        this.logger = logger;
    }

    /**
     * Returns the path to the cache directory.
     */
    public getCacheDir(): string {
        return this.cacheDir;
    }

    /**
     * Attempts to load esbuild assets from the local vault cache using the chunking strategy.
     * @param generationChecker A function to call to check if the initialization is stale.
     * @param logPrefix A prefix for log messages.
     * @returns The loaded assets, or null if the cache is invalid, missing, or corrupt.
     */
    public async loadFromCache(generationChecker: (stage: string) => void, logPrefix: string): Promise<EsbuildAssets | null> {
        this.logger.log('info', `${logPrefix} Attempting to load assets from cache manifest: ${this.manifestFilePath}`);
        generationChecker("Before cache check");

        if (!(await this.fileService.exists(this.manifestFilePath))) {
            this.logger.log('info', `${logPrefix} Cache manifest not found. Proceeding to CDN.`);
            return null;
        }

        try {
            // 1. Read and validate the manifest
            const manifestJson = await this.fileService.readFile(this.manifestFilePath);
            generationChecker("After manifest read");
            const manifest = JSON.parse(manifestJson) as CacheManifest;
            this._validateManifest(manifest);

            // 2. Read and verify JS file
            const jsFilePath = VaultPathResolver.join(this.cacheDir, manifest.js.fileName);
            const jsContent = await this.fileService.readFile(jsFilePath);
            const jsHash = await this._calculateHash(jsContent);
            if (jsHash !== manifest.js.hash) {
                throw new Error(`JS content hash mismatch. Expected ${manifest.js.hash}, found ${jsHash}.`);
            }
            this.logger.log('verbose', `${logPrefix} JS cache file verified successfully.`);

            // 3. Read, verify, and reassemble WASM chunks
            const wasmBuffer = await this._reassembleWasm(manifest, logPrefix, generationChecker);
            this.logger.log('verbose', `${logPrefix} WASM chunks reassembled and verified successfully.`);

            // 4. Compile the final WASM module
            const wasmModule = await WebAssembly.compile(wasmBuffer);
            this.logger.log('info', `${logPrefix} Successfully loaded and compiled assets from cache.`);
            return { jsContent, wasmModule };

        } catch (cacheError) {
            this.logger.log('warn', `${logPrefix} Failed to load assets from cache. It may be missing, incomplete, or corrupt. Falling back to CDN.`, cacheError);
            // DO NOT clear the cache. A transient file read error shouldn't wipe out the cache.
            // The user can use the "Renew Cache" button to manually clear it if it's truly corrupt.
            return null;
        }
    }

    /**
     * Saves the provided assets to the local vault cache using a chunking strategy.
     * @param jsContent The JavaScript content string.
     * @param wasmBuffer The raw WebAssembly binary data.
     * @param generationChecker A function to call to check if the initialization is stale.
     * @param logPrefix A prefix for log messages.
     */
    public async saveToCache(jsContent: string, wasmBuffer: ArrayBuffer, generationChecker: (stage: string) => void, logPrefix: string): Promise<void> {
        generationChecker("Before cache write");
        try {
            // Start with a clean slate
            await this.clearCache(logPrefix);
            await this.fileService.createFolder(this.cacheDir);

            // 1. Handle JS file
            const jsFilePath = VaultPathResolver.join(this.cacheDir, JS_FILE_NAME);
            await this.fileService.writeFile(jsFilePath, jsContent);
            const jsHash = await this._calculateHash(jsContent);
            this.logger.log('verbose', `${logPrefix} Wrote JS file to cache.`);

            // 2. Handle WASM chunks
            const wasmChunksInfo: CacheManifest['wasm']['chunks'] = [];
            const numChunks = Math.ceil(wasmBuffer.byteLength / CACHE_CHUNK_SIZE_BYTES);
            for (let i = 0; i < numChunks; i++) {
                const start = i * CACHE_CHUNK_SIZE_BYTES;
                const end = Math.min(start + CACHE_CHUNK_SIZE_BYTES, wasmBuffer.byteLength);
                const chunkBuffer = wasmBuffer.slice(start, end);

                const chunkFileName = `${WASM_CHUNK_PREFIX}${i}`;
                const chunkFilePath = VaultPathResolver.join(this.cacheDir, chunkFileName);
                await this.fileService.writeBinaryFile(chunkFilePath, chunkBuffer);
                const chunkHash = await this._calculateHash(chunkBuffer);

                wasmChunksInfo.push({ fileName: chunkFileName, hash: chunkHash });
            }
            this.logger.log('verbose', `${logPrefix} Wrote ${numChunks} WASM chunk(s) to cache.`);

            // 3. Create and write the manifest
            const wasmAssemblyHash = await this._calculateHash(wasmBuffer);
            const manifest: CacheManifest = {
                version: CACHE_FORMAT_VERSION,
                createdAt: new Date().toISOString(),
                js: { fileName: JS_FILE_NAME, hash: jsHash },
                wasm: {
                    totalSize: wasmBuffer.byteLength,
                    chunkSize: CACHE_CHUNK_SIZE_BYTES,
                    assemblyHash: wasmAssemblyHash,
                    chunks: wasmChunksInfo,
                },
            };

            const manifestJson = JSON.stringify(manifest, null, 2); // Pretty-print for debuggability
            await this.fileService.writeFile(this.manifestFilePath, manifestJson);
            this.logger.log('info', `${logPrefix} Wrote cache manifest file successfully.`);

        } catch (e) {
            this.logger.log('warn', `${logPrefix} Failed to write assets to cache. Caching may not work for next load.`, e);
            // This is a non-critical failure. The plugin can still function by fetching from CDN next time.
        }
    }

    /**
     * Deletes the entire esbuild cache directory.
     * @param logPrefix A prefix for log messages.
     */
    public async clearCache(logPrefix: string = '[CacheClear]'): Promise<void> {
        try {
            if (await this.fileService.exists(this.cacheDir)) {
                await this.fileService.delete(this.cacheDir);
                this.logger.log('info', `${logPrefix} Cache directory "${this.cacheDir}" moved to trash.`);
            } else {
                this.logger.log('info', `${logPrefix} Cache directory "${this.cacheDir}" does not exist. No action needed.`);
            }
        } catch (e: unknown) {
            this.logger.log('error', `${logPrefix} Failed to delete cache directory "${this.cacheDir}".`, e);
            throw e; // Re-throw to be handled by the caller
        }
    }

    private _validateManifest(manifest: CacheManifest): void {
        if (manifest.version !== CACHE_FORMAT_VERSION) {
            throw new Error(`Cache format version mismatch. Expected ${CACHE_FORMAT_VERSION}, found ${manifest.version}.`);
        }
        if (!manifest.js?.fileName || !manifest.js?.hash) {
            throw new Error('Manifest is missing required JS fields.');
        }
        if (!manifest.wasm?.chunks?.length || !manifest.wasm?.assemblyHash) {
            throw new Error('Manifest is missing required WASM fields.');
        }
    }

    private async _reassembleWasm(manifest: CacheManifest, logPrefix: string, generationChecker: (stage: string) => void): Promise<ArrayBuffer> {
        const totalSize = manifest.wasm.totalSize;
        const reassembledBuffer = new ArrayBuffer(totalSize);
        const reassembledView = new Uint8Array(reassembledBuffer);
        let offset = 0;

        for (const chunkInfo of manifest.wasm.chunks) {
            generationChecker(`Reassembling WASM chunk ${chunkInfo.fileName}`);
            const chunkFilePath = VaultPathResolver.join(this.cacheDir, chunkInfo.fileName);
            const chunkBuffer = await this.fileService.readBinaryFile(chunkFilePath);

            const chunkHash = await this._calculateHash(chunkBuffer);
            if (chunkHash !== chunkInfo.hash) {
                throw new Error(`WASM chunk ${chunkInfo.fileName} hash mismatch. Cache is corrupt.`);
            }

            reassembledView.set(new Uint8Array(chunkBuffer), offset);
            offset += chunkBuffer.byteLength;
        }

        if (offset !== totalSize) {
            throw new Error(`Reassembled WASM size mismatch. Expected ${totalSize}, got ${offset}.`);
        }

        const finalHash = await this._calculateHash(reassembledBuffer);
        if (finalHash !== manifest.wasm.assemblyHash) {
            throw new Error(`Final reassembled WASM hash mismatch. Cache is corrupt.`);
        }

        return reassembledBuffer;
    }

    /**
     * Calculates a hash for the given content, preferring SHA-256 and falling back to FNV-1a.
     * This method is designed to be fully resilient and never throw an error for hashing.
     */
    private async _calculateHash(content: string | ArrayBuffer): Promise<string> {
        const cryptoAvailable = typeof window !== 'undefined' && window.crypto?.subtle?.digest;

        if (cryptoAvailable) {
            try {
                if (typeof content === 'string') {
                    return await calculateStringHashSHA256(content);
                } else {
                    const hashBuffer = await window.crypto.subtle.digest('SHA-256', content);
                    const hashArray = Array.from(new Uint8Array(hashBuffer));
                    return hashArray.map(b => b.toString(16).padStart(2, '0')).join('');
                }
            } catch (e) {
                this.logger.log('warn', 'Web Crypto API failed during hash calculation. Falling back to FNV-1a.', e);
            }
        }

        // Fallback logic if crypto is not available or failed.
        if (typeof content === 'string') {
            return calculateStringHashFNV1aSync(content);
        } else {
            return calculateArrayBufferHashFNV1aSync(content);
        }
    }
}
