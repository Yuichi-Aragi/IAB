/**
 * @file This file contains global, mutable state flags used across the plugin.
 *       Separating these from immutable constants in `index.ts` clarifies their nature
 *       as stateful variables, not true constants.
 */

/**
 * A private, module-level flag to ensure the warning about using the FNV-1a hash fallback
 * is only logged once per session to avoid console spam.
 * @internal
 */
let _hasLoggedHashFallbackWarning = false;

/**
 * Checks if the hash fallback warning has been logged.
 * @returns {boolean}
 */
export function hasLoggedHashFallbackWarning(): boolean {
    return _hasLoggedHashFallbackWarning;
}

/**
 * Sets the flag indicating the hash fallback warning has been logged.
 */
export function setHashFallbackWarningLogged(): void {
    _hasLoggedHashFallbackWarning = true;
}
