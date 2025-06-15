/**
 * @file This file contains all custom TypeScript type and interface definitions
 *       used throughout the In-App Builder plugin. It is the single source of truth
 *       for the plugin's data model.
 *
 *       Core Principle: IMMUTABILITY
 *       All plugin-specific settings types (`PluginSettings`, `ProjectSettings`, etc.) are
 *       defined with `readonly` properties. This is a critical architectural choice to
 *       prevent accidental state mutation. Settings objects should be treated as immutable
 *       snapshots of the configuration. All modifications MUST go through the designated
 *       services (`SettingsService`, `ProjectManager`), which ensures validation, consistency,
 *       and proper event publication. This design eliminates an entire class of state-related bugs.
 */

// --- General Plugin Types ---

/**
 * Defines the verbosity level for logging throughout the plugin.
 * - `verbose`: Most detailed logs, including esbuild debug output if project log level is also verbose.
 * - `info`: Standard operational messages. (Default for global, recommended for projects)
 * - `warn`: Potential issues or non-critical errors.
 * - `error`: Critical errors that prevent functionality.
 * - `silent`: No logging output from the plugin.
 */
export type LogLevel = 'verbose' | 'info' | 'warn' | 'error' | 'silent';

/**
 * Defines the source of a build trigger.
 * - `settings-tab`: Build was triggered by a user clicking a button in the settings tab.
 * - `command`: Build was triggered from the command palette or another automated process.
 */
export type BuildInitiator = 'settings-tab' | 'command';

/**
 * Options for the esbuild build process related to sourcemaps and minification.
 * These are configured per project and are treated as immutable.
 */
export interface BuildOptions {
    /**
     * If true, combines all imported files into a single output file.
     * Almost always true for Obsidian plugins.
     */
    readonly bundle?: boolean;
    /**
     * Specifies sourcemap generation.
     * - `false`: No sourcemap.
     * - `true`: Generate a separate `.map` file.
     * - `'inline'`: Embed sourcemap directly in the output JavaScript file.
     * - `'external'`: Generate a separate `.map` file but do not link to it in the output. (esbuild specific)
     */
    readonly sourcemap: EsbuildSourceMap;
    /**
     * If `true`, the output JavaScript will be minified to reduce file size.
     * This is a general flag; specific minification aspects can be controlled by other options.
     */
    readonly minify: boolean;
    /**
     * If `true`, whitespace will be minified.
     * Requires `minify: true` to be effective.
     */
    readonly minifyWhitespace?: boolean;
    /**
     * If `true`, identifiers (variable and function names) will be minified.
     * Requires `minify: true` to be effective.
     */
    readonly minifyIdentifiers?: boolean;
    /**
     * If `true`, syntax will be minified (e.g., `()=>{}` to `()=>{}`, `true` to `!0`).
     * Requires `minify: true` to be effective.
     */
    readonly minifySyntax?: boolean;

    /**
     * Target environment(s) for the output code.
     * Examples: 'es2018', ['chrome58', 'firefox57'].
     * @see https://esbuild.github.io/api/#target
     */
    readonly target?: string | readonly string[];
    /**
     * Output format for the bundled code.
     * @see https://esbuild.github.io/api/#format
     */
    readonly format?: EsbuildFormat;
    /**
     * Target platform for the build.
     * @see https://esbuild.github.io/api/#platform
     */
    readonly platform?: EsbuildPlatform;
    /**
     * Defines global constants to be replaced during the build.
     * Keys are identifiers, values are strings to be substituted.
     * Example: `{ 'process.env.NODE_ENV': '"production"' }`.
     * @see https://esbuild.github.io/api/#define
     */
    readonly define?: Readonly<Record<string, string>>;
    /**
     * Array of file extensions to resolve when importing modules without extensions.
     * Example: `['.ts', '.tsx', '.js', '.jsx']`.
     * @see https://esbuild.github.io/api/#resolve-extensions
     */
    readonly resolveExtensions?: readonly string[];
    /**
     * Maps file extensions to specific esbuild loaders.
     * Example: `{ '.svg': 'text', '.wasm': 'binary' }`.
     * @see https://esbuild.github.io/api/#loader
     */
    readonly loader?: Readonly<Record<string, EsbuildLoader>>;
    /**
     * Array of module names to be treated as external and not bundled.
     * Example: `['obsidian', 'react']`.
     * @see https://esbuild.github.io/api/#external
     */
    readonly external?: readonly string[];
}

/**
 * Represents an external JavaScript dependency to be made available during the build.
 * These are typically fetched from CDNs. This type is immutable.
 */
export interface Dependency {
    /**
     * The module name used to import this dependency (e.g., 'moment', 'lodash').
     * This is how esbuild will recognize it as an external module if configured.
     */
    readonly name: string;
    /**
     * The full URL (HTTP or HTTPS) from which to fetch the dependency's content.
     */
    readonly url: string;
}

/**
 * Defines the settings for a single build project within the plugin.
 * Each project represents a distinct, immutable build configuration.
 */
export interface ProjectSettings {
    /**
     * A unique identifier for the project, generated automatically.
     */
    readonly id: string;
    /**
     * A user-defined, descriptive name for the project (e.g., "My Plugin Build").
     */
    readonly name: string;
    /**
     * Path to the project's root folder within the Obsidian vault.
     * Use "." for the vault root itself. Example: "MyPlugins/ProjectA".
     */
    readonly path: string;
    /**
     * The main TypeScript/JavaScript entry point file for the build,
     * relative to the project's `path`. Example: "main.ts", "src/index.js".
     */
    readonly entryPoint: string;
    /**
     * The path for the bundled JavaScript output file,
     * relative to the project's `path`. Example: "main.js", "dist/bundle.js".
     */
    readonly outputFile: string;
    /**
     * An array of external JavaScript dependencies for this project.
     * Note: 'obsidian' is typically handled by the `external` build option.
     */
    readonly dependencies: readonly Dependency[];
    /**
     * The log level specific to this project's build process.
     * Affects esbuild's internal logging verbosity and detailed plugin logs for this build.
     */
    readonly logLevel: LogLevel;
    /**
     * The Obsidian command ID associated with this project for triggering builds.
     * This is managed internally by the plugin.
     */
    readonly commandId: string | null;
    /**
     * Build-specific options like sourcemap generation and minification for this project.
     */
    readonly buildOptions: BuildOptions;
}

/**
 * Defines the global settings for the In-App Builder plugin.
 * This is an immutable snapshot of the configuration stored in Obsidian's data store.
 */
export interface PluginSettings {
    /**
     * An array of all configured build projects.
     */
    readonly projects: readonly ProjectSettings[];
    /**
     * The global log level for general plugin operations, distinct from per-project build logs.
     */
    readonly globalLogLevel: LogLevel;
    /**
     * The CDN URL for the main esbuild JavaScript file (e.g., `browser.min.js`).
     * Users can override the default.
     */
    readonly esbuildJsCdnUrl: string;
    /**
     * The CDN URL for the esbuild WebAssembly file (`esbuild.wasm`).
     * Users can override the default.
     */
    readonly esbuildWasmCdnUrl: string;
    /**
     * If true, enables the real-time analysis view in the sidebar.
     */
    readonly realTimeAnalysisEnabled: boolean;
    /**
     * The update speed (throttle delay) for rendering logs in the analysis view, in milliseconds.
     */
    readonly realTimeAnalysisUpdateSpeed: number;
}

/**
 * Defines the settings for a new project before it's fully added and assigned an ID.
 * Used by `ProjectModal` when creating a new project.
 * Note: This type automatically inherits the `readonly` nature of the properties from `ProjectSettings`.
 */
export type NewProjectSettings = Omit<ProjectSettings, 'id' | 'commandId'>;


// --- esbuild related types ---
// These types are based on esbuild's official type definitions.
// They are included here to avoid a direct dependency on the 'esbuild-wasm' package types
// in all files, and to provide a single source of truth for esbuild interactions.
// All instances of `any` have been replaced with `unknown` for enhanced type safety.

/**
 * Represents a location in a source file as reported by esbuild.
 * @see https://esbuild.github.io/api/#location-object
 */
export interface EsbuildLocation {
    file: string;
    namespace: string;
    line: number; // 1-based
    column: number; // 0-based, UTF-16 code units
    length: number; // UTF-16 code units
    lineText: string;
    suggestion?: string;
}

/**
 * Represents a diagnostic note associated with an esbuild message (error or warning).
 * @see https://esbuild.github.io/api/#note-object
 */
export interface EsbuildNote {
    text: string;
    location: EsbuildLocation | null;
}

/**
 * Base interface for esbuild diagnostic messages (errors or warnings).
 * @see https://esbuild.github.io/api/#message-object
 */
export interface EsbuildMessage {
    id: string;
    pluginName: string;
    text: string;
    location: EsbuildLocation | null;
    notes: EsbuildNote[];
    /**
     * Arbitrary data, often an Error object or other diagnostic information.
     * Using `unknown` is safer than `any`, forcing consumers to perform type checks.
     */
    detail?: unknown;
}

/** Represents an esbuild error message. */
export type EsbuildError = EsbuildMessage;

/** Represents an esbuild warning message. */
export type EsbuildWarning = EsbuildMessage;

/**
 * Represents an output file generated by esbuild.
 * @see https://esbuild.github.io/api/#output-file-object
 */
export interface EsbuildOutputFile {
    path: string;
    /** Raw byte content of the output file. */
    contents: Uint8Array;
    /** Text content of the output file (decoded from `contents`). */
    text: string;
    /** Hash of the file contents (esbuild v0.17+). */
    hash?: string; // Optional as it depends on esbuild version
}

/**
 * Represents the metadata file generated by esbuild (if `metafile: true` is used).
 * This interface is a simplified version. For full details, refer to esbuild documentation.
 * @see https://esbuild.github.io/api/#metafile-object
 */
export interface EsbuildMetafile {
    inputs: {
        [path: string]: {
            bytes: number;
            imports: {
                path: string;
                kind: EsbuildResolveKind;
                external?: boolean;
                original?: string;
            }[];
            format?: 'cjs' | 'esm';
        };
    };
    outputs: {
        [path: string]: {
            bytes: number;
            inputs: {
                [path: string]: {
                    bytesInOutput: number;
                };
            };
            imports: {
                path: string;
                kind: EsbuildResolveKind;
                external?: boolean;
            }[];
            exports: string[];
            entryPoint?: string;
            cssBundle?: string;
        };
    };
}

/**
 * Represents the result object returned by esbuild's `build` function.
 * @see https://esbuild.github.io/api/#build-result
 */
export interface EsbuildResult {
    errors: EsbuildError[];
    warnings: EsbuildWarning[];
    outputFiles?: EsbuildOutputFile[];
    metafile?: EsbuildMetafile;
    /**
     * A cache for mangled property names, used if `mangleProps` is enabled
     * and `mangleCache` is provided in options.
     */
    mangleCache?: Record<string, string | false>;
    /**
     * If `write: false` and `incremental: true`, this is a function to rebuild.
     * Not directly used by this plugin currently.
     */
    rebuild?: (options?: EsbuildBuildOptions) => Promise<EsbuildResult>;
    /**
     * If `incremental: true`, this function must be called to free resources.
     * Not directly used by this plugin currently.
     */
    stop?: () => void;
}

/**
 * Options for initializing the esbuild WebAssembly service.
 * @see https://esbuild.github.io/api/#initialize
 */
export interface EsbuildInitializeOptions {
    /** URL to the `esbuild.wasm` file. */
    wasmURL?: string;
    /** Pre-compiled WebAssembly module. */
    wasmModule?: WebAssembly.Module;
    /**
     * If `true` (default), esbuild runs in a web worker for better performance and isolation.
     * Recommended for browser environments.
     */
    worker?: boolean;
}

/** Supported platforms for esbuild builds. @see https://esbuild.github.io/api/#platform */
export type EsbuildPlatform = 'browser' | 'node' | 'neutral';
/** Supported output formats for esbuild builds. @see https://esbuild.github.io/api/#format */
export type EsbuildFormat = 'iife' | 'cjs' | 'esm';
/** Supported loaders for different file types in esbuild. @see https://esbuild.github.io/api/#loader */
export type EsbuildLoader = 'js' | 'jsx' | 'ts' | 'tsx' | 'css' | 'json' | 'text' | 'base64' | 'dataurl' | 'file' | 'binary';
/** Supported log levels for esbuild's internal logging. @see https://esbuild.github.io/api/#log-level */
export type EsbuildLogLevel = 'verbose' | 'debug' | 'info' | 'warning' | 'error' | 'silent';
/** Supported character sets for esbuild output. @see https://esbuild.github.io/api/#charset */
export type EsbuildCharset = 'ascii' | 'utf8';
/** Supported sourcemap types for esbuild. @see https://esbuild.github.io/api/#sourcemap */
export type EsbuildSourceMap = boolean | 'inline' | 'linked' | 'external';

/**
 * Options for esbuild's `build` function. This is a comprehensive interface.
 * Not all options are directly exposed or used by this plugin, but they are defined for completeness.
 * @see https://esbuild.github.io/api/#build-api
 */
export interface EsbuildBuildOptions extends BuildOptions {
    absWorkingDir?: string;
    allowOverwrite?: boolean;
    analyze?: boolean; // metafile must be true
    assetNames?: string;
    banner?: { [type: string]: string; }; // More general: e.g. { css: '...', js: '...' }
    chunkNames?: string;
    color?: boolean;
    conditions?: string[];
    drop?: ('console' | 'debugger')[];
    entryNames?: string;
    entryPoints?: string[] | Record<string, string>;
    footer?: { [type: string]: string; };
    globalName?: string;
    ignoreAnnotations?: boolean;
    inject?: string[];
    jsx?: 'transform' | 'preserve' | 'automatic';
    jsxDev?: boolean;
    jsxFactory?: string;
    jsxFragment?: string;
    jsxImportSource?: string;
    jsxSideEffects?: boolean;
    keepNames?: boolean;
    legalComments?: 'none' | 'inline' | 'eof' | 'linked' | 'external';
    logLimit?: number;
    logOverride?: Record<string, EsbuildLogLevel>;
    mainFields?: string[];
    mangleCache?: Record<string, string | false>;
    mangleProps?: RegExp;
    mangleQuoted?: boolean;
    metafile?: boolean;
    nodePaths?: string[];
    outbase?: string;
    outdir?: string;
    outfile?: string;
    packages?: 'external';
    preserveSymlinks?: boolean;
    publicPath?: string;
    pure?: string[];
    reserveProps?: RegExp;
    sourcesContent?: boolean;
    splitting?: boolean;
    stdin?: EsbuildStdinOptions;
    supported?: { [feature: string]: boolean; };
    treeShaking?: boolean;
    tsconfig?: string;
    tsconfigRaw?: string | Tsconfig;
    write?: boolean;
}

/**
 * A simplified representation of a tsconfig.json structure.
 * Used for `tsconfigRaw` option if providing a parsed object.
 */
export interface Tsconfig {
    compilerOptions?: Record<string, unknown>;
    extends?: string;
    [key: string]: unknown;
}

/**
 * Options for esbuild's `stdin` input.
 * @see https://esbuild.github.io/api/#stdin
 */
export interface EsbuildStdinOptions {
    contents: string;
    resolveDir?: string;
    sourcefile?: string;
    loader?: EsbuildLoader;
}

/**
 * Interface for an esbuild plugin.
 * @see https://esbuild.github.io/plugins/
 */
export interface EsbuildPlugin {
    name: string;
    setup: (build: EsbuildPluginBuild) => void | Promise<void>;
}

/**
 * Kinds of resolution attempts in esbuild, used in `onResolve` callbacks and metafile.
 * @see https://esbuild.github.io/plugins/#resolve-results (kind property)
 */
export type EsbuildResolveKind =
    | 'entry-point'
    | 'import-statement'
    | 'require-call'
    | 'dynamic-import'
    | 'require-resolve'
    | 'import-rule' // CSS @import
    | 'url-token';  // CSS url()

/**
 * Options for esbuild's `onResolve` callback.
 * @see https://esbuild.github.io/plugins/#on-resolve
 */
export interface EsbuildOnResolveOptions {
    filter: RegExp;
    namespace?: string;
}

/**
 * Arguments passed to esbuild's `onResolve` callback.
 * @see https://esbuild.github.io/plugins/#on-resolve-arguments
 */
export interface EsbuildOnResolveArgs {
    path: string;
    importer: string;
    namespace: string;
    resolveDir: string;
    kind: EsbuildResolveKind;
    /** User-defined data passed from one plugin callback to another. Using `unknown` for type safety. */
    pluginData: unknown;
}

/**
 * Result object returned by esbuild's `onResolve` callback.
 * @see https://esbuild.github.io/plugins/#on-resolve-results
 */
export interface EsbuildOnResolveResult {
    path?: string;
    external?: boolean;
    namespace?: string;
    /** User-defined data passed to `onLoad` for this path. Using `unknown` for type safety. */
    pluginData?: unknown;
    errors?: EsbuildMessage[];
    warnings?: EsbuildMessage[];
    watchFiles?: string[];
    watchDirs?: string[];
    sideEffects?: boolean;
}

/**
 * Options for esbuild's `onLoad` callback.
 * @see https://esbuild.github.io/plugins/#on-load
 */
export interface EsbuildOnLoadOptions {
    filter: RegExp;
    namespace?: string;
}

/**
 * Arguments passed to esbuild's `onLoad` callback.
 * @see https://esbuild.github.io/plugins/#on-load-arguments
 */
export interface EsbuildOnLoadArgs {
    path: string;
    namespace: string;
    /** For query suffixes like `?foo` in import paths. */
    suffix?: string;
    /** User-defined data passed from `onResolve`. Using `unknown` for type safety. */
    pluginData: unknown;
}

/**
 * Result object returned by esbuild's `onLoad` callback.
 * @see https://esbuild.github.io/plugins/#on-load-results
 */
export interface EsbuildOnLoadResult {
    contents?: string | Uint8Array;
    loader?: EsbuildLoader;
    resolveDir?: string;
    /** User-defined data passed to other plugin callbacks for this path. Using `unknown` for type safety. */
    pluginData?: unknown;
    errors?: EsbuildMessage[];
    warnings?: EsbuildMessage[];
    watchFiles?: string[];
    watchDirs?: string[];
}

/**
 * Result object returned by esbuild's `onStart` callback.
 * @see https://esbuild.github.io/plugins/#on-start
 */
export interface EsbuildOnStartResult {
    errors?: EsbuildMessage[];
    warnings?: EsbuildMessage[];
}

/**
 * Result object returned by esbuild's `onEnd` callback.
 * @see https://esbuild.github.io/plugins/#on-end
 */
export interface EsbuildOnEndResult {
    errors?: EsbuildMessage[];
    warnings?: EsbuildMessage[];
}


/**
 * The build API object passed to an esbuild plugin's `setup` function.
 * @see https://esbuild.github.io/plugins/#build-object
 */
export interface EsbuildPluginBuild {
    /** The initial options passed to the `build` call. */
    initialOptions: EsbuildBuildOptions;
    /**
     * Programmatically run esbuild's resolver.
     * @param path The path to resolve.
     * @param options Options for resolution (e.g., `kind`, `importer`, `namespace`, `resolveDir`, `pluginData`).
     */
    resolve: (path: string, options?: Partial<EsbuildOnResolveArgs>) => Promise<EsbuildOnResolveResult>;
    /** Registers an `onResolve` callback. */
    onResolve: (options: EsbuildOnResolveOptions, callback: (args: EsbuildOnResolveArgs) => EsbuildOnResolveResult | null | undefined | Promise<EsbuildOnResolveResult | null | undefined>) => void;
    /** Registers an `onLoad` callback. */
    onLoad: (options: EsbuildOnLoadOptions, callback: (args: EsbuildOnLoadArgs) => EsbuildOnLoadResult | null | undefined | Promise<EsbuildOnLoadResult | null | undefined>) => void;
    /** Registers an `onStart` callback, run at the beginning of each build. */
    onStart: (callback: () => (EsbuildOnStartResult | null | undefined | Promise<EsbuildOnStartResult | null | undefined>)) => void;
    /**
     * Registers an `onEnd` callback, run at the end of each build.
     * The callback receives the `EsbuildResult` of the build.
     */
    onEnd: (callback: (result: EsbuildResult) => (void | Promise<void> | EsbuildOnEndResult | Promise<EsbuildOnEndResult>)) => void;
    /** Provides access to the main esbuild namespace, e.g., for calling `esbuild.transform`. */
    esbuild?: EsbuildAPI;
}

/**
 * Options for esbuild's `transform` function.
 * @see https://esbuild.github.io/api/#transform
 */
export interface EsbuildTransformOptions extends Omit<EsbuildBuildOptions, 'write' | 'bundle' | 'entryPoints' | 'outdir' | 'outfile'> {
    sourcefile?: string;
    sourcemap?: boolean | 'inline' | 'external';
    banner?: string;
    footer?: string;
}

/**
 * Result object returned by esbuild's `transform` function.
 * @see https://esbuild.github.io/api/#transform-result
 */
export interface EsbuildTransformResult {
    code: string;
    map: string;
    warnings: EsbuildWarning[];
    mangleCache?: Record<string, string | false>;
    legalComments?: string;
}

/**
 * Options for esbuild's `formatMessages` function.
 * @see https://esbuild.github.io/api/#format-messages
 */
export interface EsbuildFormatMessagesOptions {
    kind: 'error' | 'warning';
    color?: boolean;
    terminalWidth?: number;
}

/**
 * The main esbuild API object, typically available as `window.esbuild` after initialization.
 * @see https://esbuild.github.io/api/
 */
export interface EsbuildAPI {
    /** Initializes the esbuild service (e.g., loads WASM). Must be called before other API methods. */
    initialize: (options: EsbuildInitializeOptions) => Promise<void>;
    /** Performs a build operation. */
    build: (options: EsbuildBuildOptions) => Promise<EsbuildResult>;
    /** Transforms a single string of source code. */
    transform: (input: string, options?: EsbuildTransformOptions) => Promise<EsbuildTransformResult>;
    /** Formats an array of esbuild messages (errors/warnings) into printable strings. */
    formatMessages: (messages: Array<EsbuildError | EsbuildWarning>, options: EsbuildFormatMessagesOptions) => Promise<string[]>;
    /** Stops the esbuild service, releasing associated resources (e.g., worker threads). */
    stop: () => void;
    buildSync?: (options: EsbuildBuildOptions) => EsbuildResult;
    transformSync?: (input: string, options?: EsbuildTransformOptions) => EsbuildTransformResult;
    formatMessagesSync?: (messages: Array<EsbuildError | EsbuildWarning>, options: EsbuildFormatMessagesOptions) => string[];
    version?: string;
}

/**
 * Extends the global Window interface to include the esbuild API
 * and ensure `crypto` is recognized for `IdGenerator`.
 */
declare global {
    interface Window {
        /** The esbuild API, available after successful initialization. */
        esbuild?: EsbuildAPI;
        /** Standard Crypto API, used by IdGenerator. */
        crypto: Crypto;
    }
}

/**
 * Represents a callback (resolve/reject pair) waiting for esbuild initialization to complete.
 * Used internally by `EsbuildService` to manage concurrent initialization requests.
 */
export interface PendingInitializeCallback {
    resolve: () => void;
    reject: (reason?: unknown) => void;
    /** Optional: ID of the project that triggered or is waiting for this initialization. */
    projectId?: string;
}