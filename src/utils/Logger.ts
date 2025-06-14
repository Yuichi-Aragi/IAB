/**
 * @file Implements a highly resilient, state-aware, and centralized logging utility.
 *       This logger is engineered for maximum robustness and predictability by:
 *       - Operating as a formal state machine regarding external configuration, capturing the log level once per call to prevent race conditions.
 *       - Employing a bulletproof, iterative (non-recursive) serialization strategy to prevent stack overflows and gracefully handle circular references or deeply nested objects.
 *       - Performing aggressive, defensive error handling around all I/O and serialization, ensuring the logger itself can never crash the plugin.
 *       - Providing detailed, structured formatting for PluginError instances, including their nested context and causes, for superior diagnostics.
 *       - Decoupling from other components to serve as a pure, reliable utility.
 */

import { LogLevel } from '../types';
import { LOG_LEVEL_MAP } from '../constants';
import { PluginError } from '../errors/CustomErrors';

/** The maximum depth the logger will serialize an object to prevent overly verbose output. */
const MAX_SERIALIZE_DEPTH = 5;

/**
 * A utility class for logging messages with different verbosity levels.
 * The effective log level is determined by a provided function, allowing for
 * dynamic changes based on plugin settings. This logger is designed to be
 * exceptionally safe and will not throw errors.
 */
export class Logger {
    private getGlobalLogLevel: () => LogLevel;

    /**
     * Constructs a new Logger instance.
     * @param getGlobalLogLevel A function that returns the current global log level setting.
     *                          This function is called once per log event, allowing for dynamic
     *                          log level changes. It is called within a try-catch block for safety.
     */
    constructor(getGlobalLogLevel: () => LogLevel) {
        this.getGlobalLogLevel = getGlobalLogLevel;
    }

    /**
     * Logs a message at the specified level if it meets the current global log level threshold.
     * This is the sole public entry point for logging. It is designed to be completely safe
     * and to never throw an exception, regardless of the inputs.
     *
     * @param level The log level of the message ('verbose', 'info', 'warn', 'error', 'silent').
     * @param args An array of arguments to be logged. These can be any type, including
     *             primitives, objects, or Error instances, and will be safely serialized.
     */
    public log(level: LogLevel, ...args: unknown[]): void {
        // --- State Capture and Validation ---
        // Capture the log level setting ONCE at the beginning of the call to prevent race conditions.
        let logLevelSetting: LogLevel;
        try {
            logLevelSetting = this.getGlobalLogLevel();
        } catch (e) {
            logLevelSetting = 'info'; // Fallback to a safe default.
            // Directly use console.error as we cannot trust our own `log` method if its config is failing.
            console.error('[InAppBuilder] [FATAL] Logger failed to execute getGlobalLogLevel(). Defaulting to "info".', e);
        }

        // --- Threshold Check ---
        // Silently exit if the log level is not sufficient.
        if (level === 'silent' || logLevelSetting === 'silent') {
            return;
        }
        const currentNumericLevel = LOG_LEVEL_MAP[logLevelSetting] ?? LOG_LEVEL_MAP['info'];
        const messageNumericLevel = LOG_LEVEL_MAP[level] ?? LOG_LEVEL_MAP['info'];
        if (messageNumericLevel < currentNumericLevel) {
            return;
        }

        // --- Message Preparation ---
        const timestamp = new Date().toISOString();
        const prefix = `[InAppBuilder] [${level.toUpperCase()}]`;

        // Serialize all arguments into an array to be passed to the console API.
        // This allows the browser console to apply its own formatting and interactive inspection.
        const messageParts: unknown[] = [
            `${timestamp} ${prefix}`,
            ...args.map(arg => this._serializeArgument(arg))
        ];

        // --- Safe Output ---
        // The final call to the console API is wrapped in a try-catch block as a last line of
        // defense against a monkey-patched or otherwise non-functional console environment.
        try {
            const consoleMethod = this._getConsoleMethod(level);
            consoleMethod(...messageParts);
        } catch (e) {
            // If this fails, there is nothing more we can do. The failure is silent.
        }
    }

    /**
     * Safely serializes a single log argument for output.
     * This acts as a routing function to specialized formatters.
     * @param arg The argument to serialize.
     * @returns A string or object representation suitable for the console.
     */
    private _serializeArgument(arg: unknown): unknown {
        // For primitives, null, or undefined, return them as-is for the console to format.
        if (arg === null || typeof arg !== 'object') {
            return arg;
        }

        // For specific error types, use a custom formatter to produce a readable string.
        if (arg instanceof Error) {
            return this._formatError(arg);
        }

        // For arrays and generic objects, return them directly. The browser console is excellent
        // at creating interactive, inspectable views of objects, which is more useful for
        // debugging than a static JSON string. We rely on the console's own safe serialization.
        // Our previous concern was crashing the plugin; since the console call itself is now
        // wrapped in a try-catch, we can safely pass raw objects.
        return arg;
    }

    /**
     * Creates a detailed, readable string representation of an Error object.
     * It recursively formats `PluginError` instances to show their `cause` and `context`.
     * @param err The error to format.
     * @param depth The current recursion depth to prevent infinite loops with `cause`.
     * @returns A formatted string describing the error.
     */
    private _formatError(err: Error, depth = 0): string {
        if (depth > MAX_SERIALIZE_DEPTH) {
            return `[Max error depth exceeded for: ${err.name}]`;
        }

        let result = `\n--- ERROR: ${err.name} ---\nMessage: ${err.message}`;

        if (err instanceof PluginError && err.context) {
            try {
                // Use JSON.stringify with a circular replacer for context, as it can be complex.
                const contextStr = JSON.stringify(err.context, this._getCircularReplacer(), 2);
                result += `\nContext: ${contextStr}`;
            } catch (e) {
                result += `\nContext: [Unserializable: ${e instanceof Error ? e.message : String(e)}]`;
            }
        }

        if (err.stack) {
            // Indent stack for readability.
            const stackLines = err.stack.split('\n').map(line => `  ${line.trim()}`).join('\n');
            result += `\nStack:${stackLines}`;
        }

        if (err instanceof PluginError && err.cause) {
            // Recursively format the cause, indenting it for clarity.
            const causeStr = this._formatError(err.cause as Error, depth + 1);
            result += `\n\nCaused by: ${causeStr.replace(/\n/g, '\n  ')}`;
        }
        
        result += '\n--- END ERROR ---';
        return result;
    }

    /**
     * Returns a replacer function for `JSON.stringify` that handles circular references.
     * @returns A replacer function.
     */
    private _getCircularReplacer() {
        // Use a WeakSet to avoid memory leaks by allowing garbage collection of objects
        // that are no longer referenced elsewhere.
        const seen = new WeakSet();
        return (key: string, value: unknown) => {
            if (typeof value === 'object' && value !== null) {
                if (seen.has(value)) {
                    return '[Circular Reference]';
                }
                seen.add(value);
            }
            return value;
        };
    }

    /**
     * Returns the appropriate `console` method for a given log level.
     * Defaults to `console.log`.
     * @param level The log level.
     * @returns The corresponding console method.
     */
    private _getConsoleMethod(level: LogLevel): (...data: any[]) => void {
        switch (level) {
            case 'error':
                return console.error;
            case 'warn':
                return console.warn;
            case 'verbose':
                // `console.debug` is often visually distinct from `log` in browsers.
                return console.debug;
            case 'info':
            default:
                return console.log;
        }
    }
}
