/**
 * @file Provides aggressively robust, secure, and efficient utility functions for validating
 *       various input types, primarily paths and project-related configurations. This module
 *       is engineered for maximum mitigation against common and subtle issues by enforcing
 *       strict data integrity and security rules.
 *
 *       Core Principles:
 *       - **Defense-in-Depth:** Validation is multi-layered, checking for type, format, security,
 *         and platform-compatibility issues.
 *       - **Purity and Statelessness:** All functions are pure, ensuring no side effects and
 *         predictable, repeatable behavior.
 *       - **Clarity and Explicitness:** Validation rules are explicit and documented to explain
 *         the "why" behind each check, particularly for security and compatibility.
 *       - **Performance:** Uses efficient data structures (Sets, pre-compiled Regex) for all checks
 *         to ensure minimal performance overhead.
 */

import { VaultPathResolver } from './VaultPathResolver';
import { Dependency, ProjectSettings, LogLevel, BuildOptions, EsbuildFormat, EsbuildPlatform, EsbuildLoader, EsbuildSourceMap } from '../types';

// --- Constants for Validation ---

/** A regular expression to detect characters that are broadly invalid in file/folder names across Windows, macOS, and Linux. */
const INVALID_PATH_CHARS_REGEX = /[<>:"\\|?*\x00-\x1F]/;

/** A Set of reserved filenames on Windows. Case-insensitive. Used for fast lookups. */
const RESERVED_WINDOWS_FILENAMES = new Set([
    'CON', 'PRN', 'AUX', 'NUL',
    'COM1', 'COM2', 'COM3', 'COM4', 'COM5', 'COM6', 'COM7', 'COM8', 'COM9',
    'LPT1', 'LPT2', 'LPT3', 'LPT4', 'LPT5', 'LPT6', 'LPT7', 'LPT8', 'LPT9'
]);

/** A reasonable maximum path length to prevent issues with file systems and OS APIs. */
const MAX_PATH_LENGTH = 1024;

/**
 * Validates a path intended to be a root folder or subfolder within the Obsidian vault.
 * This is a critical security and stability function.
 *
 * @param path The path string to validate.
 * @returns `true` if the path is a valid vault path, `false` otherwise.
 */
export function isValidVaultPath(path: string): boolean {
    // 1. Aggressive upfront type and emptiness check.
    if (typeof path !== 'string' || path.trim() === '') {
        return false;
    }

    // 2. Security: Disallow OS-absolute paths immediately.
    if (VaultPathResolver.isPathAbsolute(path)) {
        return false;
    }
    
    // 3. Check path length limit before normalization.
    if (path.length > MAX_PATH_LENGTH) {
        return false;
    }

    const normalized = VaultPathResolver.normalize(path);

    // 4. Allow the vault root, represented as ".".
    if (normalized === '.') {
        return true;
    }

    // 5. Security: After normalization, ".." should not exist. This prevents path traversal.
    if (normalized.includes('..')) {
        return false;
    }

    // 6. Security & Consistency: Paths should not start or end with slashes after normalization.
    if (normalized.startsWith('/') || normalized.endsWith('/')) {
        return false;
    }

    // 7. Cross-Platform Compatibility: Check each segment for invalid characters and reserved names.
    const segments = normalized.split('/');
    for (const segment of segments) {
        if (INVALID_PATH_CHARS_REGEX.test(segment)) {
            return false;
        }
        // Check against reserved names (case-insensitive).
        if (RESERVED_WINDOWS_FILENAMES.has(segment.toUpperCase())) {
            return false;
        }
    }

    return true;
}

/**
 * Validates a path intended to be a relative file path within a project structure.
 * This is stricter than `isValidVaultPath` as it must point to a file.
 *
 * @param path The path string to validate.
 * @returns `true` if the path is a valid relative file path, `false` otherwise.
 */
export function isValidRelativeFilePath(path: string): boolean {
    // 1. Aggressive upfront type and emptiness check.
    if (typeof path !== 'string' || path.trim() === '') {
        return false;
    }

    // 2. Security: Disallow OS-absolute paths.
    if (VaultPathResolver.isPathAbsolute(path)) {
        return false;
    }

    // 3. Check path length limit.
    if (path.length > MAX_PATH_LENGTH) {
        return false;
    }

    const normalized = VaultPathResolver.normalize(path);

    // 4. Security & Consistency: Must not be a directory-like path.
    if (normalized === '.' || normalized.endsWith('/')) {
        return false;
    }

    // 5. Security: Must be relative, so it cannot start with a slash.
    if (normalized.startsWith('/')) {
        return false;
    }

    // 6. Security: Path traversal is disallowed.
    if (normalized.includes('..')) {
        return false;
    }

    // 7. Cross-Platform Compatibility: Check each segment.
    const segments = normalized.split('/');
    for (const segment of segments) {
        if (INVALID_PATH_CHARS_REGEX.test(segment)) {
            return false;
        }
        // The filename part (last segment) can have a dot, but other segments shouldn't be just a dot.
        const filename = segments[segments.length - 1];
        const filenameWithoutExt = filename.split('.')[0];
        if (RESERVED_WINDOWS_FILENAMES.has(segment.toUpperCase()) || RESERVED_WINDOWS_FILENAMES.has(filenameWithoutExt.toUpperCase())) {
            return false;
        }
    }

    return true;
}

/**
 * Validates a single external dependency object.
 *
 * @param dependency The `Dependency` object to validate.
 * @returns An object with `valid: true` if valid, or `valid: false` and an `error` message string if invalid.
 */
export function validateDependency(dependency: Dependency): { valid: boolean; error?: string } {
    if (!dependency || typeof dependency !== 'object') {
        return { valid: false, error: 'Dependency must be an object.' };
    }
    const { name, url } = dependency;

    if (typeof name !== 'string' || name.trim() === '') {
        return { valid: false, error: 'Dependency name cannot be empty.' };
    }
    if (/[/\\:]/.test(name)) {
        return { valid: false, error: `Dependency name "${name}" contains invalid characters.` };
    }

    if (typeof url !== 'string' || url.trim() === '') {
        return { valid: false, error: `URL for dependency "${name}" cannot be empty.` };
    }
    try {
        const parsedUrl = new URL(url);
        if (parsedUrl.protocol !== 'http:' && parsedUrl.protocol !== 'https:') {
            return { valid: false, error: `Invalid URL protocol for "${name}". Only HTTP/HTTPS is allowed.` };
        }
    } catch (e) {
        return { valid: false, error: `Invalid URL format for "${name}": ${url}` };
    }
    return { valid: true };
}

/**
 * Exhaustively validates a `BuildOptions` object against the esbuild API contract.
 *
 * @param buildOptions The build options to validate. Can be `any` to handle potentially malformed data.
 * @param issues Optional array to push detailed error messages into.
 * @returns `true` if valid, `false` otherwise.
 */
export function isValidBuildOptions(buildOptions: any, issues?: string[]): buildOptions is BuildOptions {
    if (!buildOptions || typeof buildOptions !== 'object' || Array.isArray(buildOptions)) {
        issues?.push("BuildOptions must be a non-array object.");
        return false;
    }
    let valid = true;

    const checkOptionalBoolean = (key: keyof BuildOptions) => {
        if (buildOptions[key] !== undefined && typeof buildOptions[key] !== 'boolean') {
            issues?.push(`Build option '${key}' must be a boolean if provided, but got type ${typeof buildOptions[key]}.`);
            valid = false;
        }
    };

    checkOptionalBoolean('bundle');
    checkOptionalBoolean('minify');
    checkOptionalBoolean('minifyWhitespace');
    checkOptionalBoolean('minifyIdentifiers');
    checkOptionalBoolean('minifySyntax');

    const validSourcemapValues: EsbuildSourceMap[] = [true, false, 'inline', 'external'];
    if (buildOptions.sourcemap !== undefined && !validSourcemapValues.includes(buildOptions.sourcemap)) {
        issues?.push(`Invalid sourcemap value: '${buildOptions.sourcemap}'. Must be one of: ${validSourcemapValues.join(', ')}.`);
        valid = false;
    }

    if (buildOptions.target !== undefined) {
        const isValidTarget = (t: any) => typeof t === 'string' && t.trim() !== '' && /^[a-z0-9,]+$/.test(t);
        if (typeof buildOptions.target === 'string') {
            if (!isValidTarget(buildOptions.target)) {
                issues?.push(`Target string "${buildOptions.target}" contains invalid characters or format.`);
                valid = false;
            }
        } else if (Array.isArray(buildOptions.target)) {
            if (!buildOptions.target.every(isValidTarget)) {
                issues?.push("Each item in the 'target' array must be a valid, non-empty string (e.g., 'es2018', 'chrome58').");
                valid = false;
            }
        } else {
            issues?.push(`Build option 'target' must be a string or an array of strings.`);
            valid = false;
        }
    }

    const validFormats: EsbuildFormat[] = ['iife', 'cjs', 'esm'];
    if (buildOptions.format !== undefined && !validFormats.includes(buildOptions.format)) {
        issues?.push(`Invalid format: '${buildOptions.format}'. Must be one of: ${validFormats.join(', ')}.`);
        valid = false;
    }

    const validPlatforms: EsbuildPlatform[] = ['browser', 'node', 'neutral'];
    if (buildOptions.platform !== undefined && !validPlatforms.includes(buildOptions.platform)) {
        issues?.push(`Invalid platform: '${buildOptions.platform}'. Must be one of: ${validPlatforms.join(', ')}.`);
        valid = false;
    }

    if (buildOptions.define !== undefined) {
        if (typeof buildOptions.define !== 'object' || buildOptions.define === null || Array.isArray(buildOptions.define)) {
            issues?.push("Build option 'define' must be an object (key-value map).");
            valid = false;
        } else {
            for (const key in buildOptions.define) {
                if (typeof buildOptions.define[key] !== 'string') {
                    issues?.push(`Value for define key "${key}" must be a string.`);
                    valid = false;
                }
                if (!/^[a-zA-Z_][a-zA-Z0-9_$.]*$/.test(key)) {
                    issues?.push(`Define key "${key}" is not a valid identifier sequence.`);
                    valid = false;
                }
            }
        }
    }

    if (buildOptions.resolveExtensions !== undefined) {
        if (!Array.isArray(buildOptions.resolveExtensions) || !buildOptions.resolveExtensions.every((ext: any) => typeof ext === 'string' && ext.startsWith('.') && ext.length > 1)) {
            issues?.push("Build option 'resolveExtensions' must be an array of strings, each starting with '.' (e.g., '.ts').");
            valid = false;
        }
    }

    const validLoaders: EsbuildLoader[] = ['js', 'jsx', 'ts', 'tsx', 'css', 'json', 'text', 'base64', 'dataurl', 'file', 'binary'];
    if (buildOptions.loader !== undefined) {
        if (typeof buildOptions.loader !== 'object' || buildOptions.loader === null || Array.isArray(buildOptions.loader)) {
            issues?.push("Build option 'loader' must be an object (key-value map).");
            valid = false;
        } else {
            for (const key in buildOptions.loader) {
                if (typeof key !== 'string' || !key.startsWith('.') || key.length < 2) {
                    issues?.push(`Loader key "${key}" must be a file extension string starting with '.' (e.g., '.svg').`);
                    valid = false;
                }
                if (!validLoaders.includes(buildOptions.loader[key])) {
                    issues?.push(`Invalid loader value "${buildOptions.loader[key]}" for extension "${key}". Must be one of: ${validLoaders.join(', ')}.`);
                    valid = false;
                }
            }
        }
    }

    if (buildOptions.external !== undefined) {
        if (!Array.isArray(buildOptions.external) || !buildOptions.external.every((ext: any) => typeof ext === 'string' && ext.trim() !== '')) {
            issues?.push("Build option 'external' must be an array of non-empty strings (module names).");
            valid = false;
        }
    }
    return valid;
}

/**
 * Validates a complete `ProjectSettings` object.
 * This is the master validation function for a project configuration.
 *
 * @param project The project settings object to validate. Can be `any` to handle potentially malformed data.
 * @param issues Optional array to push detailed error messages into.
 * @returns `true` if the project settings are valid, `false` otherwise.
 */
export function isProjectSettingsValid(project: any, issues?: string[]): project is ProjectSettings {
    if (!project || typeof project !== 'object' || Array.isArray(project)) {
        issues?.push("Project settings must be a non-array object.");
        return false;
    }
    let valid = true;

    const checkRequiredString = (key: keyof ProjectSettings) => {
        if (typeof project[key] !== 'string' || project[key].trim() === '') {
            issues?.push(`Project field '${key}' is required and must be a non-empty string.`);
            valid = false;
        }
    };

    checkRequiredString('id');
    checkRequiredString('name');
    checkRequiredString('path');
    checkRequiredString('entryPoint');
    checkRequiredString('outputFile');

    if (project.id && typeof project.id === 'string' && !/^[a-zA-Z0-9_-]+$/.test(project.id)) {
        issues?.push(`Project ID "${project.id}" contains invalid characters. Only alphanumeric, underscore, and hyphen are allowed.`);
        valid = false;
    }

    if (project.path && typeof project.path === 'string' && !isValidVaultPath(project.path)) {
        issues?.push(`Project path "${project.path}" is invalid. It must be a valid vault-relative folder path.`);
        valid = false;
    }
    if (project.entryPoint && typeof project.entryPoint === 'string' && !isValidRelativeFilePath(project.entryPoint)) {
        issues?.push(`Project entryPoint "${project.entryPoint}" is invalid. It must be a relative file path.`);
        valid = false;
    }
    if (project.outputFile && typeof project.outputFile === 'string' && !isValidRelativeFilePath(project.outputFile)) {
        issues?.push(`Project outputFile "${project.outputFile}" is invalid. It must be a relative file path.`);
        valid = false;
    }

    if (!isValidBuildOptions(project.buildOptions, issues)) {
        if (!project.buildOptions) issues?.push("Project 'buildOptions' are missing or invalid.");
        valid = false;
    }

    if (project.dependencies !== undefined) {
        if (!Array.isArray(project.dependencies)) {
            issues?.push("Project 'dependencies' must be an array if provided.");
            valid = false;
        } else {
            project.dependencies.forEach((dep: any, i: number) => {
                const depValidation = validateDependency(dep);
                if (!depValidation.valid) {
                    issues?.push(`Dependency at index ${i} is invalid: ${depValidation.error}`);
                    valid = false;
                }
            });
        }
    }

    const validLogLevels: LogLevel[] = ['verbose', 'info', 'warn', 'error', 'silent'];
    if (project.logLevel === undefined || !validLogLevels.includes(project.logLevel)) {
        issues?.push(`Project logLevel "${project.logLevel || ''}" is invalid. Must be one of: ${validLogLevels.join(', ')}.`);
        valid = false;
    }

    if (project.commandId !== null && typeof project.commandId !== 'string') {
        issues?.push(`Project commandId must be a non-empty string or null, but got type ${typeof project.commandId}.`);
        valid = false;
    }

    return valid;
}

/**
 * Generates a user-friendly summary of validation issues.
 *
 * @param issues Array of issue strings from a validation function.
 * @returns A formatted string summarizing the issues, or an empty string if no issues.
 */
export function getValidationIssuesSummary(issues: string[]): string {
    if (!issues || issues.length === 0) return "";
    return `Validation failed with ${issues.length} issue(s):\n- ${issues.join('\n- ')}`;
}
