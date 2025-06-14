import { App, requestUrl, RequestUrlParam, RequestUrlResponse } from 'obsidian';
import { Logger } from '../utils/Logger';
import { DEFAULT_REQUEST_TIMEOUT_MS } from '../constants';
import { NetworkError, createChainedMessage } from '../errors/CustomErrors';
import { container, ServiceTokens } from '../utils/DIContainer';
import { calculateStringHashFNV1aSync } from '../utils/FileContentUtils';

// --- State Machine and Configuration ---

/**
 * Defines the operational states of the NetworkService.
 * - `running`: The service is active and can process requests.
 * - `shutting_down`: The service is being unloaded. No new requests are accepted, and active requests are being cancelled.
 * - `stopped`: The service is fully stopped and has cleaned up all resources.
 */
type NetworkServiceState = 'running' | 'shutting_down' | 'stopped';

/**
 * Maximum number of concurrent network requests allowed.
 * This prevents overwhelming the network or remote servers.
 */
const MAX_CONCURRENT_REQUESTS = 5;

// --- Internal Request Tracking ---

/**
 * Represents a request that is pending in the queue.
 */
interface QueuedRequest {
    requestKey: string;
    options: RequestUrlParam;
    timeoutMs: number;
    resolve: (value: RequestUrlResponse) => void;
    reject: (reason?: any) => void;
}

/**
 * Provides a highly robust, resilient, and stateful service for all network operations.
 * This service implements:
 * - A formal state machine (`running`, `shutting_down`, `stopped`) for predictable lifecycle management.
 * - Request coalescing to prevent redundant identical requests.
 * - A concurrency-limited queue to avoid network/server overload.
 * - Graceful shutdown and cancellation of all in-flight requests on plugin unload.
 * - Aggressive validation and defensive checks for all inputs and states.
 */
export class NetworkService {
    private app: App;
    private get logger(): Logger { return container.resolve<Logger>(ServiceTokens.Logger); }

    private state: NetworkServiceState = 'running';
    private readonly requestQueue: QueuedRequest[] = [];
    private activeRequestCount: number = 0;

    /**
     * A map to coalesce identical, concurrent requests.
     * Key: A hash of the request options (URL, method, headers, body).
     * Value: The promise of the in-flight request.
     */
    private readonly coalescingRequests = new Map<string, Promise<RequestUrlResponse>>();

    constructor(app: App) {
        this.app = app;
        this.logger.log('verbose', 'NetworkService initialized and is in a "running" state.');
    }

    /**
     * The primary public method for making network requests. It handles state checks,
     * request coalescing, and queueing. This is the sole entry point for network I/O.
     *
     * @param {RequestUrlParam} options The parameters for the request, matching Obsidian's `requestUrl`.
     * @param {number} [timeoutMs=DEFAULT_REQUEST_TIMEOUT_MS] The timeout for this specific request in milliseconds.
     * @returns {Promise<RequestUrlResponse>} A promise that resolves with the `RequestUrlResponse` or rejects with a `NetworkError`.
     * @throws {NetworkError} if the service is not running or if inputs are invalid. This is returned as a rejected promise.
     */
    public requestUrlWithTimeout(options: RequestUrlParam, timeoutMs: number = DEFAULT_REQUEST_TIMEOUT_MS): Promise<RequestUrlResponse> {
        // --- Aggressive State and Input Validation ---
        if (this.state !== 'running') {
            const message = `NetworkService cannot process new requests while in state: '${this.state}'.`;
            this.logger.log('error', `NetworkService.requestUrlWithTimeout: ${message}`);
            return Promise.reject(new NetworkError(message, undefined, { state: this.state, url: options.url }));
        }

        if (!options || !options.url || typeof options.url !== 'string' || options.url.trim() === '') {
            const message = "Request URL is missing or invalid in options.";
            this.logger.log('error', `NetworkService.requestUrlWithTimeout: ${message}`);
            return Promise.reject(new NetworkError(message, undefined, { options }));
        }

        if (typeof timeoutMs !== 'number' || timeoutMs <= 0) {
            const message = `Invalid timeout value: ${timeoutMs}. Must be a positive number.`;
            this.logger.log('error', `NetworkService.requestUrlWithTimeout: ${message}`);
            return Promise.reject(new NetworkError(message, undefined, { url: options.url, timeout: timeoutMs }));
        }
        
        const requestKey = this._generateRequestKey(options);

        // --- Request Coalescing ---
        if (this.coalescingRequests.has(requestKey)) {
            this.logger.log('verbose', `Coalescing request for URL: ${options.url}`);
            return this.coalescingRequests.get(requestKey)!;
        }

        // --- Queueing and Concurrency Management ---
        const requestPromise = new Promise<RequestUrlResponse>((resolve, reject) => {
            const queuedRequest: QueuedRequest = { requestKey, options, timeoutMs, resolve, reject };
            this.requestQueue.push(queuedRequest);
            this.logger.log('verbose', `Request for URL ${options.url} queued. Queue size: ${this.requestQueue.length}.`);
            this._processQueue();
        });

        // Store the promise for coalescing future identical requests.
        this.coalescingRequests.set(requestKey, requestPromise);

        return requestPromise;
    }

    /**
     * Initiates a graceful shutdown of the service, to be called from the plugin's `onunload`.
     * - Sets the state to `shutting_down`.
     * - Rejects all queued requests that have not yet started.
     * - Allows in-flight requests to complete or time out.
     * - Sets state to `stopped` once all active and queued requests are cleared.
     */
    public unload(): void {
        if (this.state !== 'running') {
            return; // Already shutting down or stopped.
        }

        this._setState('shutting_down');
        this.logger.log('info', `NetworkService is shutting down. Rejecting ${this.requestQueue.length} queued requests.`);

        // Reject all requests that haven't started yet.
        while (this.requestQueue.length > 0) {
            const queuedRequest = this.requestQueue.shift()!;
            const shutdownError = new NetworkError('Request cancelled due to NetworkService shutdown.', undefined, { url: queuedRequest.options.url, state: 'shutting_down' });
            queuedRequest.reject(shutdownError);
            // Also remove from coalescing map so it doesn't block future requests if plugin reloads
            this.coalescingRequests.delete(queuedRequest.requestKey);
        }

        // If there are no active requests, we can stop immediately.
        if (this.activeRequestCount === 0) {
            this._setState('stopped');
            this.logger.log('info', 'NetworkService has stopped.');
        }
        // If there are active requests, they will complete or time out,
        // and the last one to finish will transition the state to 'stopped'.
    }

    /**
     * Processes the request queue if there is capacity for more concurrent requests.
     */
    private _processQueue(): void {
        if (this.state !== 'running') {
            return; // Do not process queue if not in a running state.
        }

        while (this.activeRequestCount < MAX_CONCURRENT_REQUESTS && this.requestQueue.length > 0) {
            const requestToProcess = this.requestQueue.shift()!;
            this.activeRequestCount++;
            this.logger.log('verbose', `Processing request for URL: ${requestToProcess.options.url}. Active requests: ${this.activeRequestCount}.`);
            this._executeRequest(requestToProcess);
        }
    }

    /**
     * Executes a single network request with timeout handling.
     * This is the core execution logic for a dequeued request.
     *
     * @param queuedRequest The request object from the queue.
     */
    private async _executeRequest(queuedRequest: QueuedRequest): Promise<void> {
        const { requestKey, options, timeoutMs, resolve, reject } = queuedRequest;
        let timeoutHandle: number | undefined;

        const timeoutPromise = new Promise<RequestUrlResponse>((_, rejectTimeout) => {
            timeoutHandle = window.setTimeout(() => {
                // Clear the handle immediately to prevent race conditions with clearTimeout
                timeoutHandle = undefined;
                const message = `Request timed out after ${timeoutMs / 1000}s for URL: ${options.url}`;
                this.logger.log('warn', `NetworkService._executeRequest: Timeout - ${options.url}`);
                rejectTimeout(new NetworkError(message, undefined, { url: options.url, timeout: timeoutMs, type: 'timeout' }));
            }, timeoutMs);
        });

        try {
            // Race the actual request against the timeout promise.
            const result = await Promise.race([
                requestUrl(options),
                timeoutPromise
            ]);
            resolve(result);
        } catch (error: unknown) {
            // The error could be from the timeout or the request itself.
            const wrappedError = error instanceof NetworkError 
                ? error 
                : new NetworkError(
                    createChainedMessage(`Request failed for URL: ${options.url}`, error), 
                    error instanceof Error ? error : undefined, 
                    { url: options.url, originalOptions: options }
                  );
            
            this.logger.log('error', `NetworkService._executeRequest: Failure - ${options.url}`, wrappedError);
            reject(wrappedError);
        } finally {
            // --- Critical Cleanup Logic ---
            if (timeoutHandle) {
                clearTimeout(timeoutHandle);
            }
            
            this.activeRequestCount--;
            this.coalescingRequests.delete(requestKey);
            this.logger.log('verbose', `Request finished for URL: ${options.url}. Active requests: ${this.activeRequestCount}.`);

            // If the service is shutting down and this was the last active request, complete the shutdown.
            if (this.state === 'shutting_down' && this.activeRequestCount === 0) {
                this._setState('stopped');
                this.logger.log('info', 'NetworkService has stopped.');
            } else {
                // Otherwise, try to process more items from the queue.
                this._processQueue();
            }
        }
    }

    /**
     * Generates a stable key for a request based on its properties, used for coalescing.
     * @param options The request parameters.
     * @returns A string hash representing the request.
     */
    private _generateRequestKey(options: RequestUrlParam): string {
        const { url, method, headers, body } = options;
        // Create a stable string representation of the request for hashing.
        // This includes sorting headers to ensure the key is consistent regardless of header order.
        const keyData = {
            url: url.trim(),
            method: (method || 'GET').toUpperCase(),
            headers: headers ? Object.fromEntries(Object.entries(headers).sort(([a], [b]) => a.localeCompare(b))) : {},
            // Only include string bodies in the hash for simplicity and performance.
            // Binary bodies are less likely to be coalesced anyway.
            body: typeof body === 'string' ? body : '',
        };
        try {
            const stableString = JSON.stringify(keyData);
            return calculateStringHashFNV1aSync(stableString);
        } catch (e) {
            // Fallback for unserializable data, though unlikely with the sanitized keyData.
            return url.trim();
        }
    }

    /**
     * Centralized method for changing the service's state.
     * @param newState The new state to transition to.
     */
    private _setState(newState: NetworkServiceState): void {
        if (this.state !== newState) {
            this.logger.log('verbose', `NetworkService state changed: ${this.state} -> ${newState}`);
            this.state = newState;
        }
    }
}
