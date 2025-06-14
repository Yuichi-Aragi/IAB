/**
 * @file Provides an aggressively robust utility for generating unique identifiers.
 *       This module is designed for maximum reliability and security by:
 *       - Performing a one-time, stateful check for a FUNCTIONAL Web Crypto API, not just its existence.
 *       - Caching the result of the check for high performance on subsequent calls.
 *       - Gracefully and automatically falling back to a time-based pseudo-random generator if the crypto API is unavailable, non-functional, or fails at runtime.
 *       - Operating as a formal state machine (CRYPTO_AVAILABLE vs. FALLBACK_ONLY) to ensure predictable, unambiguous behavior.
 *       - Eliminating entire classes of environmental errors by validating dependencies before use.
 */

// --- Module-level State for Crypto API Availability ---

/**
 * A private, module-level variable to cache the availability of a functional Web Crypto API.
 * This prevents re-checking the environment on every call to generateProjectId.
 * It's determined once by the `checkCryptoAvailability` IIFE.
 * - `true`: `window.crypto.getRandomValues` is available and functional.
 * - `false`: The API is unavailable or failed a one-time test.
 * @internal
 */
let isCryptoFunctional: boolean = false;

/**
 * A private, module-level flag to ensure the warning about using the fallback
 * generator is only logged once per session to avoid console spam.
 * @internal
 */
let hasLoggedCryptoWarning: boolean = false;

// --- One-Time Environment Check (IIFE) ---

/**
 * This IIFE runs once when the module is first loaded.
 * It performs an aggressive, one-time check for a functional Web Crypto API,
 * setting the module's internal state for all subsequent ID generation calls.
 * @internal
 */
(() => {
    // Check for the basic API existence in a browser-like environment.
    if (typeof window === 'undefined' || !window.crypto?.getRandomValues) {
        isCryptoFunctional = false;
        return;
    }

    // Perform a live test to catch environments where the API exists but is non-functional
    // (e.g., insecure contexts, browser bugs, extensions interfering).
    try {
        const buffer = new Uint8Array(1);
        window.crypto.getRandomValues(buffer);
        // If the call succeeds without throwing, we consider the API functional.
        isCryptoFunctional = true;
    } catch (error) {
        // The test failed. We must use the fallback.
        console.warn(
            '[IdGenerator] A one-time test of the Web Crypto API (getRandomValues) failed. ' +
            'The plugin will use a less secure, time-based fallback for generating unique IDs. ' +
            'This may occur in unusual environments or if an extension is interfering. ' +
            'Error details:', error
        );
        isCryptoFunctional = false;
    }
})();


// --- ID Generation Implementations ---

/**
 * Generates a UUID v4 using the Web Crypto API.
 * This is the preferred, cryptographically secure method.
 * @internal
 * @returns {string} A UUID v4 string.
 * @throws {Error} If `window.crypto.getRandomValues` fails unexpectedly during the call. This is caught by the public-facing function.
 */
function generateCryptoUuid(): string {
    const buffer = new Uint8Array(16);
    window.crypto.getRandomValues(buffer);

    // Per RFC 4122, set the version to 4.
    // buffer[6] = (b[6] & 0x0f) | 0x40
    buffer[6] = (buffer[6] & 0b00001111) | 0b01000000;

    // Per RFC 4122, set the variant to 1 (10xx).
    // buffer[8] = (b[8] & 0x3f) | 0x80
    buffer[8] = (buffer[8] & 0b00111111) | 0b10000000;

    // Convert the byte array to a UUID string format.
    const s = Array.from(buffer, byte => byte.toString(16).padStart(2, '0')).join('');
    return `${s.substring(0, 8)}-${s.substring(8, 12)}-${s.substring(12, 16)}-${s.substring(16, 20)}-${s.substring(20, 32)}`;
}

/**
 * Generates a UUID-like string using a time-based, pseudo-random fallback method.
 * This is used only when the Web Crypto API is unavailable or non-functional.
 * @internal
 * @returns {string} A UUID-like string.
 */
function generateFallbackUuid(): string {
    let d = new Date().getTime();

    // Use performance.now() for higher resolution time if available, increasing uniqueness.
    if (typeof performance !== 'undefined' && typeof performance.now === 'function') {
        d += performance.now();
    }

    return 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, (c) => {
        const r = (d + Math.random() * 16) % 16 | 0;
        d = Math.floor(d / 16);
        // Set version (4) and variant (8, 9, A, or B) bits correctly.
        return (c === 'x' ? r : (r & 0x3 | 0x8)).toString(16);
    });
}


// --- Public API ---

/**
 * Generates a highly unique identifier string, compliant with UUID v4 format.
 *
 * This function implements a robust, two-tiered approach:
 * 1.  **Primary (Secure):** It prioritizes the Web Crypto API (`window.crypto.getRandomValues`)
 *     to generate a cryptographically strong random UUID. The availability and functionality
 *     of this API are checked once and cached for maximum efficiency.
 *
 * 2.  **Secondary (Fallback):** If the Web Crypto API is unavailable, non-functional, or fails
 *     during execution, the function seamlessly falls back to a time-based, pseudo-random
 *     generator. This ensures that the plugin can always generate necessary IDs, even in
 *     constrained or unusual environments. A warning is logged to the console on the first
 *     fallback instance.
 *
 * This design guarantees both maximum security where possible and maximum reliability in all cases.
 *
 * @returns {string} A unique string identifier (e.g., "xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx").
 */
export function generateProjectId(): string {
    if (isCryptoFunctional) {
        try {
            // Attempt to use the primary, secure method.
            return generateCryptoUuid();
        } catch (error) {
            // A rare, transient error occurred with the crypto API (e.g., entropy pool exhausted).
            // Log this specific failure and use the fallback for this single call.
            console.error(
                '[IdGenerator] Web Crypto API failed during an active call, despite passing initial checks. ' +
                'Using fallback for this ID generation. This is highly unusual. Error:', error
            );
            // Do not change `isCryptoFunctional` here, as the error might be temporary.
        }
    }

    // If crypto is not functional OR the primary method failed, use the fallback.
    if (!hasLoggedCryptoWarning) {
        console.warn(
            '[IdGenerator] Using time-based fallback for ID generation because the Web Crypto API is not available or failed. ' +
            'While still highly unique, this method is not cryptographically secure. This warning will only appear once.'
        );
        hasLoggedCryptoWarning = true;
    }
    return generateFallbackUuid();
}
