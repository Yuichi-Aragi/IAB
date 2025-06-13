/**
 * @file This file contains all global, immutable constants used throughout the In-App Builder plugin.
 *       Centralizing constants improves maintainability, prevents "magic" strings/numbers, and ensures
 *       a single source of truth for configuration defaults and fixed values.
 *
 *       Core Principle: DEEP IMMUTABILITY
 *       All exported values are deeply immutable. For objects and arrays, this is enforced using
 *       TypeScript's `as const` assertion, which provides compile-time safety against accidental
 *       modification of default configurations.
 */

import { LogLevel, BuildOptions } from '../types';

// --- Service & API Constants ---

/** Default CDN URL for the esbuild browser JavaScript file. */
export const DEFAULT_ESBUILD_JS_CDN_URL = "https://cdn.jsdelivr.net/npm/esbuild-wasm@latest/lib/browser.min.js";

/** Default CDN URL for the esbuild WebAssembly file. */
export const DEFAULT_ESBUILD_WASM_CDN_URL = "https://cdn.jsdelivr.net/npm/esbuild-wasm@latest/esbuild.wasm";

/** HTML element ID for the dynamically injected esbuild script tag. */
export const INJECTED_ESBUILD_SCRIPT_ID = 'in-app-builder-injected-esbuild-script';

/** Custom esbuild namespace for files originating from the Obsidian vault project. */
export const ESBUILD_NAMESPACE_PROJECTFILE = 'in-app-builder:projectfile';

/** Custom esbuild namespace for external dependencies fetched by the plugin. */
export const ESBUILD_NAMESPACE_EXTERNALDEP = 'in-app-builder:externaldep';


// --- Timing and Limits ---

/** Default timeout duration for network requests in milliseconds. */
export const DEFAULT_REQUEST_TIMEOUT_MS = 30000; // 30 seconds

/** Timeout for the main esbuild.build() call in milliseconds. */
export const ESBUILD_BUILD_TIMEOUT_MS = 300000; // 300 seconds (5 minutes)

/** Maximum depth for serializing objects in logs to prevent circular structure errors and overly verbose output. */
export const MAX_LOG_SERIALIZE_DEPTH = 5;

/** Maximum source file size in bytes before a warning is logged. */
export const MAX_SOURCE_FILE_SIZE_BYTES = 5 * 1024 * 1024; // 5 MB


// --- Configuration Defaults ---

/** Directory name for caching esbuild assets within the vault root. */
export const CACHE_DIR = '.in-app-builder-cache';

/** The size of each binary chunk for the cached WASM file. 4MB is a safe value for most file systems and APIs. */
export const CACHE_CHUNK_SIZE_BYTES = 2 * 1024 * 1024; // 4 MB

/** Default setting for enabling the asset cache. */
export const DEFAULT_ENABLE_CACHE = true;

/** Default global log level for the plugin. */
export const DEFAULT_GLOBAL_LOG_LEVEL: LogLevel = 'info';

/** Default log level for new projects. */
export const DEFAULT_PROJECT_LOG_LEVEL: LogLevel = 'info';

/**
 * A deeply immutable mapping from `LogLevel` strings to numerical values for comparison.
 * Lower numbers indicate higher verbosity (more logs). This is used to filter logs based on the
 * current log level setting.
 */
export const LOG_LEVEL_MAP = {
    'verbose': 0,
    'info': 1,
    'warn': 2,
    'error': 3,
    'silent': 4
} as const satisfies Readonly<Record<LogLevel, number>>;

/**
 * Deeply immutable default build options for new projects.
 * Using `as const` ensures that this object and all its properties cannot be mutated at runtime,
 * preventing accidental modification of the plugin's baseline configuration.
 * This provides sensible defaults that users can override on a per-project basis.
 */
export const DEFAULT_PROJECT_BUILD_OPTIONS = {
    bundle: true,
    sourcemap: false,
    minify: false,
    minifyWhitespace: true,
    minifyIdentifiers: true,
    minifySyntax: true,
    target: 'es2018',
    format: 'cjs',
    platform: 'browser',
    define: {},
    resolveExtensions: ['.ts', '.tsx', '.js', '.jsx', '.json'],
    loader: {},
    external: ['obsidian'],
} as const satisfies BuildOptions;


// --- Static Messages ---

/**
 * The warning message to be logged when the secure Web Crypto API is unavailable for hashing.
 * The logic for logging this message only once is handled by the service that performs the hashing.
 */
export const DEFAULT_HASH_FALLBACK_WARNING_MESSAGE =
    "[FileContentUtils] Web Crypto API (subtle.digest) not available. " +
    "Falling back to synchronous FNV-1a hashing for initial content integrity checks. " +
    "This is less secure than SHA-256.";
