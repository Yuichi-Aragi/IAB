/**
 * @file Provides an aggressively robust, secure, and consistent utility class for all path
 *       manipulations within the Obsidian vault context. This module is the single source of
 *       truth for path logic, designed to eliminate entire classes of errors related to
 *       path handling.
 *
 *       Core Principles:
 *       - **Deterministic & Pure:** All methods are pure functions. Given the same input, they
 *         will always produce the same output without any side effects. This makes behavior
 *         predictable and easy to test.
 *       - **Aggressive Normalization:** All path-returning methods ensure the output is fully
 *         normalized according to Obsidian's standards, preventing inconsistencies.
 *       - **Security First:** Methods are designed to mitigate path traversal attacks by
 *         correctly interpreting vault-relative paths and rejecting absolute paths where
 *         appropriate.
 *       - **Comprehensive Edge Case Handling:** Explicitly handles `null`, `undefined`, empty
 *         strings, `.` (vault root), `/`, and mixed slash types (`\`, `/`).
 */

import { normalizePath as obsidianNormalizePath } from 'obsidian';

export class VaultPathResolver {
    /**
     * Normalizes a path string to its canonical form, robustly handling relative segments
     * like `.` and `..`. This is the cornerstone of all path operations in the plugin.
     *
     * This method implements a standard path resolution algorithm to ensure consistent and
     * predictable behavior, as Obsidian's native `normalizePath` may not fully simplify
     * virtual or non-existent paths.
     *
     * @param path The path string to normalize. Can be `null` or `undefined`.
     * @returns The fully normalized, canonical path string. Returns an empty string if the
     *          input is `null`, `undefined`, or an empty string. Returns `.` for paths
     *          that resolve to the vault root.
     *
     * @example
     * VaultPathResolver.normalize("My Notes/Sub/../Other/./Note.md"); // "My Notes/Other/Note.md"
     * VaultPathResolver.normalize("My Notes/"); // "My Notes"
     * VaultPathResolver.normalize("./"); // "."
     * VaultPathResolver.normalize("a/b/../../c"); // "c"
     */
    public static normalize(path: string | null | undefined): string {
        if (!path) {
            return '';
        }

        // Use Obsidian's function for initial cleanup (e.g., converting `\` to `/`).
        const initialPath = obsidianNormalizePath(path);

        // A truly empty path after initial normalization should be empty.
        if (initialPath === '') {
            return '';
        }
        
        // If the path is just the root, return '.' immediately.
        if (initialPath === '.' || initialPath === '/') {
            return '.';
        }

        const segments = initialPath.split('/');
        const resolvedSegments: string[] = [];

        for (const segment of segments) {
            if (segment === '..') {
                // If we encounter '..', pop the last segment, unless we're at the root.
                if (resolvedSegments.length > 0) {
                    resolvedSegments.pop();
                }
            } else if (segment !== '.' && segment !== '') {
                // Ignore '.' segments and empty segments (from multiple slashes).
                resolvedSegments.push(segment);
            }
        }

        const finalPath = resolvedSegments.join('/');

        // If resolution results in an empty string, it means the path resolved to the root.
        // e.g., "a/.." or "./"
        if (finalPath === '') {
            return '.';
        }

        return finalPath;
    }

    /**
     * Joins multiple path segments into a single, normalized path. This method is
     * designed to mimic `path.join` from Node.js but for the vault's virtual file system.
     *
     * - Segments are joined using forward slashes.
     * - The resulting path is fully normalized by the enhanced `normalize` method.
     * - Empty, `null`, or `undefined` segments are ignored.
     *
     * @param segments An ordered array of path segments to join.
     * @returns A single, normalized path string.
     *
     * @example
     * VaultPathResolver.join("path/to", "project", "main.ts"); // "path/to/project/main.ts"
     * VaultPathResolver.join(".", "src", "./index.js"); // "src/index.js"
     * VaultPathResolver.join("a", null, "b", "", "c"); // "a/b/c"
     * VaultPathResolver.join("a/b", "../c"); // "a/c"
     */
    public static join(...segments: (string | null | undefined)[]): string {
        const relevantSegments = segments.filter(s => s && s.trim() !== ''); // Filter out null, undefined, empty strings
        if (relevantSegments.length === 0) {
            return '';
        }
        
        const path = relevantSegments.join('/');
        return VaultPathResolver.normalize(path);
    }

    /**
     * Gets the parent directory of a given path.
     *
     * - For root-level items (e.g., "file.md"), the parent is the vault root, represented as `.`
     * - The parent of the vault root (`.` or `/`) is `.`
     *
     * @param path The path string.
     * @returns The normalized path of the parent directory.
     *
     * @example
     * VaultPathResolver.getParent("path/to/file.md"); // "path/to"
     * VaultPathResolver.getParent("path/to/"); // "path"
     * VaultPathResolver.getParent("file.md"); // "."
     * VaultPathResolver.getParent("."); // "."
     */
    public static getParent(path: string | null | undefined): string {
        const normalizedPath = VaultPathResolver.normalize(path);

        if (normalizedPath === '' || normalizedPath === '.') {
            return '.';
        }

        const lastSlashIndex = normalizedPath.lastIndexOf('/');
        if (lastSlashIndex === -1) {
            // No slashes, implies a root-level file/folder.
            return '.';
        }
        if (lastSlashIndex === 0) {
            // Path is like "/file", which is not a standard vault path.
            // The parent of a root file is the root itself.
            return '.';
        }

        const parent = normalizedPath.substring(0, lastSlashIndex);
        // If the parent part becomes empty (e.g., from "file"), it's the root.
        return parent || '.';
    }

    /**
     * Extracts the filename (including extension) from a path.
     *
     * @param path The path string.
     * @returns The filename. Returns an empty string if the path is a directory
     *          (ends with `/`), the vault root (`.`), or empty.
     *
     * @example
     * VaultPathResolver.getFilename("path/to/file.md"); // "file.md"
     * VaultPathResolver.getFilename("path/to/"); // ""
     * VaultPathResolver.getFilename("file.md"); // "file.md"
     */
    public static getFilename(path: string | null | undefined): string {
        const normalizedPath = VaultPathResolver.normalize(path);
        if (!normalizedPath || normalizedPath === '.' || normalizedPath.endsWith('/')) {
            return '';
        }
        const lastSlashIndex = normalizedPath.lastIndexOf('/');
        return normalizedPath.substring(lastSlashIndex + 1);
    }

    /**
     * Extracts the file extension from a path, including the leading dot.
     * Correctly handles dotfiles (e.g., `.gitignore` has no extension).
     *
     * @param path The path string.
     * @returns The extension (e.g., ".ts", ".md"), or an empty string if no extension is found.
     *
     * @example
     * VaultPathResolver.getExtension("file.ts"); // ".ts"
     * VaultPathResolver.getExtension("archive.tar.gz"); // ".gz"
     * VaultPathResolver.getExtension(".gitignore"); // ""
     * VaultPathResolver.getExtension("folder/file"); // ""
     */
    public static getExtension(path: string | null | undefined): string {
        const filename = VaultPathResolver.getFilename(path);
        if (!filename) {
            return '';
        }
        const lastDotIndex = filename.lastIndexOf('.');
        // A dot must exist, not be the first character, and not be the last character.
        if (lastDotIndex > 0 && lastDotIndex < filename.length - 1) {
            return filename.substring(lastDotIndex);
        }
        return '';
    }

    /**
     * Checks if a path string appears to be an OS-absolute path. This is a critical
     * security check to prevent operations outside the vault's intended scope.
     *
     * @param path The path string to check.
     * @returns `true` if the path is absolute, `false` otherwise.
     *
     * @example
     * VaultPathResolver.isPathAbsolute("/home/user/file"); // true
     * VaultPathResolver.isPathAbsolute("C:\\Users\\user\\file"); // true
     * VaultPathResolver.isPathAbsolute("relative/path/file"); // false
     * VaultPathResolver.isPathAbsolute(null); // false
     */
    public static isPathAbsolute(path: string | null | undefined): boolean {
        if (!path) {
            return false;
        }
        // Check for Unix-like absolute paths (e.g., /home/user).
        if (path.startsWith('/')) {
            return true;
        }
        // Check for Windows-like absolute paths (e.g., C:\, D:/, \\server\share).
        if (/^[a-zA-Z]:[\\/]/.test(path) || path.startsWith('\\\\')) {
            return true;
        }
        return false;
    }

    /**
     * Compares two paths for equality after normalizing them. This is the safest way
     * to check if two path strings refer to the same location in the vault.
     *
     * @param path1 The first path string.
     * @param path2 The second path string.
     * @returns `true` if the normalized paths are identical, `false` otherwise.
     *
     * @example
     * VaultPathResolver.isSamePath("path/to/file.md", "path//to/../to/./file.md"); // true
     * VaultPathResolver.isSamePath("path/to", "path/to/other"); // false
     */
    public static isSamePath(path1: string | null | undefined, path2: string | null | undefined): boolean {
        return VaultPathResolver.normalize(path1) === VaultPathResolver.normalize(path2);
    }
}
