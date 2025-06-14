/*
 * FILE: src/utils/FileContentUtils.ts
 */

/**
 * @file Provides aggressively robust, secure, and efficient utility functions for processing and analyzing file content.
 *       This module is designed with maximum mitigation against common issues:
 *       - **Type Safety**: All public functions perform strict, upfront validation of arguments to prevent runtime errors.
 *       - **Unicode Correctness**: All character processing correctly handles multi-code-unit Unicode characters (surrogate pairs).
 *       - **Security**: Prioritizes the Web Crypto API for hashing and provides clear fallbacks.
 *       - **Performance**: Clearly documents the performance characteristics (sync/async, potential for blocking) of each function.
 *       - **Immutability**: Functions are pure and do not mutate input arguments or global state.
 */

// --- Hashing Utilities ---

/**
 * Asynchronously calculates a SHA-256 hash of a string using the Web Crypto API.
 * This is the preferred method for strong, cryptographic hashing for integrity checks.
 *
 * @param content The string content to hash. Must be a valid string.
 * @returns A Promise that resolves with the lowercase hex-encoded SHA-256 hash string.
 * @throws {TypeError} if `content` is not a string.
 * @throws {Error} if the Web Crypto API is unavailable or if the hashing operation fails for any reason.
 */
export async function calculateStringHashSHA256(content: string): Promise<string> {
    // --- Aggressive Input Validation ---
    if (typeof content !== 'string') {
        throw new TypeError('[FileContentUtils.calculateStringHashSHA256] Input `content` must be a string.');
    }

    // --- Aggressive Environment Validation ---
    if (typeof window === 'undefined' || !window.crypto?.subtle?.digest) {
        const errorMessage = '[FileContentUtils.calculateStringHashSHA256] Web Crypto API (subtle.digest) is not available in this environment. Cannot perform SHA-256 hashing.';
        console.error(errorMessage);
        throw new Error(errorMessage);
    }

    try {
        const encoder = new TextEncoder();
        const data = encoder.encode(content);
        const hashBuffer = await window.crypto.subtle.digest('SHA-256', data);
        const hashArray = Array.from(new Uint8Array(hashBuffer));
        // Return lowercase hex string for consistency.
        return hashArray.map(b => b.toString(16).padStart(2, '0')).join('');
    } catch (error: unknown) {
        const message = error instanceof Error ? error.message : String(error);
        console.error(`[FileContentUtils] A critical error occurred during SHA-256 hash calculation: ${message}`);
        // Re-throw as a generic error to signal failure to the caller.
        throw new Error(`SHA-256 hashing failed: ${message}`);
    }
}

/**
 * Synchronously calculates a FNV-1a 32-bit hash of a string.
 * This is a non-cryptographic hash function, suitable for fast hashing where cryptographic
 * strength is not required (e.g., cache keys, quick integrity checks, or as a fallback).
 *
 * Note: As a synchronous, CPU-bound operation, this may block the main thread if
 * used on extremely large strings (e.g., multi-megabyte files).
 *
 * @param content The string content to hash. Must be a valid string.
 * @returns The FNV-1a hash as a lowercase, 8-character hex-encoded string.
 * @throws {TypeError} if `content` is not a string.
 */
export function calculateStringHashFNV1aSync(content: string): string {
    // --- Aggressive Input Validation ---
    if (typeof content !== 'string') {
        throw new TypeError('[FileContentUtils.calculateStringHashFNV1aSync] Input `content` must be a string.');
    }

    let hash = 0x811c9dc5; // FNV-1a 32-bit offset basis

    for (let i = 0; i < content.length; i++) {
        hash ^= content.charCodeAt(i);
        // 32-bit FNV prime: 2^24 + 2^8 + 0x93
        hash += (hash << 1) + (hash << 4) + (hash << 7) + (hash << 8) + (hash << 24);
    }

    // Convert to unsigned 32-bit integer and then to a fixed-length hex string.
    const unsignedHash = hash >>> 0;
    return unsignedHash.toString(16).padStart(8, '0');
}

/**
 * Synchronously calculates a FNV-1a 32-bit hash of an ArrayBuffer.
 * This is a non-cryptographic hash function, suitable for fast hashing where cryptographic
 * strength is not required (e.g., cache keys, quick integrity checks, or as a fallback).
 *
 * Note: As a synchronous, CPU-bound operation, this may block the main thread if
 * used on extremely large buffers.
 *
 * @param buffer The ArrayBuffer content to hash. Must be a valid ArrayBuffer.
 * @returns The FNV-1a hash as a lowercase, 8-character hex-encoded string.
 * @throws {TypeError} if `buffer` is not an ArrayBuffer.
 */
export function calculateArrayBufferHashFNV1aSync(buffer: ArrayBuffer): string {
    // --- Aggressive Input Validation ---
    if (!(buffer instanceof ArrayBuffer)) {
        throw new TypeError('[FileContentUtils.calculateArrayBufferHashFNV1aSync] Input `buffer` must be an ArrayBuffer.');
    }

    const view = new Uint8Array(buffer);
    let hash = 0x811c9dc5; // FNV-1a 32-bit offset basis

    for (let i = 0; i < view.length; i++) {
        hash ^= view[i];
        // 32-bit FNV prime: 2^24 + 2^8 + 0x93
        hash += (hash << 1) + (hash << 4) + (hash << 7) + (hash << 8) + (hash << 24);
    }

    // Convert to unsigned 32-bit integer and then to a fixed-length hex string.
    const unsignedHash = hash >>> 0;
    return unsignedHash.toString(16).padStart(8, '0');
}


// --- Character Analysis Utilities ---

/**
 * A map of known problematic or invisible Unicode characters that can cause subtle parsing issues.
 * This list can be expanded as needed.
 */
const PROBLEMATIC_CHAR_MAP: Readonly<Record<number, string>> = {
    0x200B: 'Zero Width Space (ZWSP)',
    0x200C: 'Zero Width Non-Joiner (ZWNJ)',
    0x200D: 'Zero Width Joiner (ZWJ)',
    0x2028: 'Line Separator (LSEP)',
    0x2029: 'Paragraph Separator (PSEP)',
    0x00A0: 'No-Break Space (NBSP)',
    0xFEFF: 'Byte Order Mark (BOM) / Zero Width No-Break Space',
};

/**
 * Detects known problematic Unicode characters within a text. This function is Unicode-aware
 * and correctly handles characters outside the Basic Multilingual Plane (e.g., emojis).
 *
 * @param text The text to scan. Must be a valid string.
 * @returns An array of objects, each describing a found problematic character, its index, code point, and name.
 * @throws {TypeError} if `text` is not a string.
 */
export function detectProblematicCharacters(text: string): { index: number; char: string; code: number; name: string }[] {
    // --- Aggressive Input Validation ---
    if (typeof text !== 'string') {
        throw new TypeError('[FileContentUtils.detectProblematicCharacters] Input `text` must be a string.');
    }
    if (text.length === 0) {
        return [];
    }

    const found: { index: number; char: string; code: number; name: string }[] = [];
    let i = 0;
    // Use for...of loop to correctly iterate over Unicode characters (including surrogate pairs).
    for (const char of text) {
        // Use codePointAt to get the full Unicode code point.
        const code = char.codePointAt(0)!;
        if (PROBLEMATIC_CHAR_MAP[code]) {
            found.push({
                index: i,
                char: char,
                code: code,
                name: PROBLEMATIC_CHAR_MAP[code],
            });
        }
        // Increment index by the character's length in UTF-16 code units (1 for BMP, 2 for surrogate pairs).
        i += char.length;
    }
    return found;
}

/**
 * Gets a contextual snippet of text around a specific character index, along with detailed
 * information about the character at that index and a standard `hexdump -C` style representation
 * of its surrounding UTF-8 bytes. This function is Unicode-aware.
 *
 * @param text The full text content. Must be a valid string.
 * @param errorCharIndex The 0-based index of the character of interest.
 * @param contextLines The number of lines to show before and after the line containing the character.
 * @param charsAroundForHexDump The number of characters before and after `errorCharIndex` to include in the hex dump.
 * @returns An object containing the context snippet, character analysis, and a hex dump.
 * @throws {TypeError} if any argument has an invalid type.
 * @throws {RangeError} if any numerical argument is out of its valid range.
 */
export function getCharacterContext(
    text: string,
    errorCharIndex: number,
    contextLines: number = 3,
    charsAroundForHexDump: number = 10
): { snippetLines: string[]; charInfo: string; hexDump: string } {
    // --- Aggressive Input Validation ---
    if (typeof text !== 'string') throw new TypeError('[getCharacterContext] `text` must be a string.');
    if (!Number.isInteger(errorCharIndex)) throw new TypeError('[getCharacterContext] `errorCharIndex` must be an integer.');
    if (!Number.isInteger(contextLines)) throw new TypeError('[getCharacterContext] `contextLines` must be an integer.');
    if (!Number.isInteger(charsAroundForHexDump)) throw new TypeError('[getCharacterContext] `charsAroundForHexDump` must be an integer.');

    if (contextLines < 0) throw new RangeError('[getCharacterContext] `contextLines` cannot be negative.');
    if (charsAroundForHexDump < 0) throw new RangeError('[getCharacterContext] `charsAroundForHexDump` cannot be negative.');

    // --- Edge Case Handling ---
    if (text.length === 0) {
        return {
            snippetLines: ['[Empty Text]'],
            charInfo: 'N/A (empty text)',
            hexDump: 'N/A (empty text)',
        };
    }

    // Clamp errorCharIndex to be within valid bounds to prevent out-of-range errors.
    const clampedErrorCharIndex = Math.max(0, Math.min(errorCharIndex, text.length - 1));

    const lines = text.split(/\r\n|\r|\n/);
    let charCountUpToErrorLine = 0;
    let errorLineIndex = -1;
    let errorColumnInLine = -1;

    for (let i = 0; i < lines.length; i++) {
        const lineLength = lines[i].length;
        // The +1 accounts for the newline character that was removed by split().
        if (clampedErrorCharIndex >= charCountUpToErrorLine && clampedErrorCharIndex < charCountUpToErrorLine + lineLength + 1) {
            errorLineIndex = i;
            errorColumnInLine = clampedErrorCharIndex - charCountUpToErrorLine;
            break;
        }
        charCountUpToErrorLine += lineLength + 1;
    }

    if (errorLineIndex === -1) { // Should be unreachable due to clamping, but included for defense.
        return {
            snippetLines: [`Error: Could not locate character index ${clampedErrorCharIndex} within text.`],
            charInfo: `Character at index ${clampedErrorCharIndex} not found in line context.`,
            hexDump: "N/A",
        };
    }

    // Clamp column to be within the line's bounds.
    errorColumnInLine = Math.max(0, Math.min(errorColumnInLine, lines[errorLineIndex].length - 1));
    if (lines[errorLineIndex].length === 0) errorColumnInLine = 0;

    // --- Snippet Generation ---
    const snippetLines: string[] = [];
    const startLine = Math.max(0, errorLineIndex - contextLines);
    const endLine = Math.min(lines.length - 1, errorLineIndex + contextLines);

    for (let i = startLine; i <= endLine; i++) {
        const lineNum = i + 1;
        snippetLines.push(`L${lineNum.toString().padEnd(4)}: ${lines[i]}`);
        if (i === errorLineIndex) {
            // Use Array.from to correctly calculate length of characters before the error,
            // accounting for multi-code-unit characters.
            const prefix = Array.from(lines[i]).slice(0, errorColumnInLine).join('');
            const pointer = ' '.repeat(prefix.length) + '^';
            snippetLines.push(`      ${pointer} (col ${errorColumnInLine + 1})`);
        }
    }

    // --- Character Info Generation (Unicode-aware) ---
    const charAtError = Array.from(lines[errorLineIndex])[errorColumnInLine] || '[EOL]';
    const codePointAtError = charAtError === '[EOL]' ? -1 : charAtError.codePointAt(0)!;
    const charInfo = `Character: '${charAtError.replace('\t', '\\t')}' (Unicode: U+${codePointAtError.toString(16).toUpperCase().padStart(4, '0')}${PROBLEMATIC_CHAR_MAP[codePointAtError] ? ' - ' + PROBLEMATIC_CHAR_MAP[codePointAtError] : ''})`;

    // --- Hex Dump Generation (hexdump -C style) ---
    const hexDumpStart = Math.max(0, clampedErrorCharIndex - charsAroundForHexDump);
    const hexDumpEnd = Math.min(text.length, clampedErrorCharIndex + charsAroundForHexDump + 1);
    const subTextForHex = text.substring(hexDumpStart, hexDumpEnd);

    let hexDump = '';
    if (subTextForHex.length > 0) {
        const encoder = new TextEncoder();
        const bytes = encoder.encode(subTextForHex);
        const bytesPerLine = 16;
        const formattedHexLines: string[] = [];

        for (let i = 0; i < bytes.length; i += bytesPerLine) {
            const byteSlice = bytes.slice(i, i + bytesPerLine);
            const hexPart = Array.from(byteSlice).map(b => b.toString(16).padStart(2, '0')).join(' ');
            const charPart = Array.from(byteSlice).map(b => (b >= 32 && b <= 126) ? String.fromCharCode(b) : '.').join('');

            formattedHexLines.push(
                `0x${(hexDumpStart + i).toString(16).padStart(8, '0')}: ${hexPart.padEnd(bytesPerLine * 3 - 1)} |${charPart}|`
            );
        }
        hexDump = formattedHexLines.join('\n');
    } else {
        hexDump = "N/A (Could not generate hex dump, empty selection)";
    }

    return { snippetLines, charInfo, hexDump };
}
