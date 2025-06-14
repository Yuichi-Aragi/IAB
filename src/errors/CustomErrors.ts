/**
 * @file Defines custom error classes for the In-App Builder plugin
 *       to provide more specific error handling and context.
 */

/**
 * Base class for all custom errors in the plugin.
 * Allows for consistent error handling and identification.
 */
export class PluginError extends Error {
    public readonly cause?: Error | unknown; // Allow unknown for non-Error causes
    public readonly context?: Record<string, any>; // For additional contextual information

    constructor(message: string, cause?: Error | unknown, context?: Record<string, any>) {
        super(message);
        this.name = this.constructor.name; // Set the error name to the class name
        this.cause = cause;
        this.context = context;

        // Maintains proper stack trace for where our error was thrown (only available on V8)
        if (Error.captureStackTrace) {
            Error.captureStackTrace(this, this.constructor);
        }
    }
}

/**
 * Error thrown during project configuration validation.
 */
export class ProjectValidationError extends PluginError {
    constructor(message: string, cause?: Error | unknown, context?: Record<string, any>) {
        super(message, cause, context);
    }
}

/**
 * Error thrown during the build process in BuildService.
 */
export class BuildProcessError extends PluginError {
    constructor(message: string, cause?: Error | unknown, context?: Record<string, any>) {
        super(message, cause, context);
    }
}

/**
 * Error thrown when a build process is intentionally cancelled.
 * This is not a failure state but a controlled termination.
 */
export class BuildCancelledError extends PluginError {
    constructor(message: string = "Build was cancelled.", context?: Record<string, any>) {
        super(message, undefined, { ...context, cancelled: true });
    }
}

/**
 * Error thrown during esbuild service initialization.
 */
export class EsbuildInitializationError extends PluginError {
    constructor(message: string, cause?: Error | unknown, context?: Record<string, any>) {
        super(message, cause, context);
    }
}

/**
 * Error thrown by FileService for vault file system operations.
 */
export class FileSystemError extends PluginError {
    constructor(message: string, cause?: Error | unknown, context?: Record<string, any>) {
        super(message, cause, context);
    }
}

/**
 * Error thrown by NetworkService for external network requests.
 */
export class NetworkError extends PluginError {
    constructor(message: string, cause?: Error | unknown, context?: Record<string, any>) {
        super(message, cause, context);
    }
}

/**
 * Helper function to create a more informative error message,
 * including the original error's message if available.
 * @param baseMessage The base message for the new error.
 * @param originalError The original error that was caught.
 * @returns A combined error message string.
 */
export function createChainedMessage(baseMessage: string, originalError?: Error | unknown): string {
    let chainedMessage = baseMessage;
    if (originalError instanceof Error && originalError.message) {
        // Take first line of cause's message to keep it concise
        chainedMessage += `\n> Caused by: ${originalError.message.split('\n')[0]}`; 
    } else if (originalError) { // If originalError is not undefined/null but not an Error instance
        chainedMessage += `\n> Caused by: ${String(originalError).split('\n')[0]}`;
    }
    return chainedMessage;
}
