/**
 * @file Shared types for the esbuild service components.
 */

/**
 * Represents the successfully acquired esbuild assets, ready for initialization.
 */
export interface EsbuildAssets {
    /** The string content of the esbuild JavaScript file. */
    jsContent: string;
    /** The compiled WebAssembly module for esbuild. */
    wasmModule: WebAssembly.Module;
}
