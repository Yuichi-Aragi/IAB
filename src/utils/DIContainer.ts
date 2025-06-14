/**
 * @file Implements a robust, stateful, and lifecycle-aware Dependency Injection (DI) container.
 *       This service operates as a formal state machine to guarantee predictable behavior,
 *       prevent race conditions during plugin reloads, and actively manage the lifecycle
 *       (including cleanup) of all registered services.
 */

// --- Custom Error for DI Container ---

/**
 * A specific error class for failures within the DIContainer.
 * This allows for precise error handling of container-related issues.
 */
class DIContainerError extends Error {
    constructor(message: string) {
        super(message);
        this.name = 'DIContainerError';
    }
}

// --- State Machine and Service Entry Definitions ---

/**
 * Defines the operational states of the DIContainer.
 * - `ACTIVE`: The container is running and can register or resolve services. This is the default operational state.
 * - `UNLOADING`: The `unload` process has been initiated. No new registrations or resolutions are permitted.
 * - `UNLOADED`: The `unload` process is complete. The container is inert and must be `reset()` before reuse.
 */
type DIContainerState = 'ACTIVE' | 'UNLOADING' | 'UNLOADED';

/**
 * Defines the contract for a registered service within the container.
 * It holds the service instance and an optional, framework-aware cleanup function.
 */
interface ServiceEntry<T> {
    /** The singleton instance of the service. */
    instance: T;
    /** An optional cleanup function that will be called by the container during its `unload` phase. */
    unload?: () => void | Promise<void>;
}

// --- Service Tokens ---

/**
 * Provides unique, collision-proof symbols for service registration and resolution.
 * Using `Symbol.for` creates symbols in the global symbol registry, which is suitable
 * for ensuring the same symbol is used across different parts of the plugin.
 */
export const ServiceTokens = {
    Logger: Symbol.for('Logger'),
    SettingsService: Symbol.for('SettingsService'),
    NetworkService: Symbol.for('NetworkService'),
    FileService: Symbol.for('FileService'),
    EsbuildService: Symbol.for('EsbuildService'),
    ProjectManager: Symbol.for('ProjectManager'),
    BuildService: Symbol.for('BuildService'),
    EventBus: Symbol.for('EventBus'),
    CommandBus: Symbol.for('CommandBus'),
    Plugin: Symbol.for('Plugin'), // Token for the main plugin instance itself
};

// --- DI Container Implementation ---

export class DIContainer {
    private state: DIContainerState = 'ACTIVE';
    private readonly registry = new Map<symbol, ServiceEntry<unknown>>();
    /** Tracks registration order to ensure Last-In, First-Out (LIFO) unloading. */
    private readonly registrationOrder: symbol[] = [];

    /**
     * Resets the container to a pristine `ACTIVE` state.
     * This is essential for Obsidian's plugin hot-reloading, ensuring that a new
     * `onload` cycle starts with a clean container.
     */
    public reset(): void {
        if (this.state === 'UNLOADING') {
            console.warn('[DIContainer] `reset()` called while still unloading. This may indicate an incomplete previous unload cycle.');
        }
        this.registry.clear();
        this.registrationOrder.length = 0; // More memory-efficient than `[]`
        this.state = 'ACTIVE';
        console.log('[DIContainer] Container has been reset and is now ACTIVE.');
    }

    /**
     * Registers a service instance with the container.
     * This operation is only permitted when the container is in the `ACTIVE` state.
     *
     * @param token A unique symbol from `ServiceTokens` to identify the service.
     * @param instance The singleton instance of the service.
     * @param options An optional object containing lifecycle hooks, such as `unload`.
     * @throws {DIContainerError} if the container is not `ACTIVE` or if inputs are invalid.
     */
    public register<T>(token: symbol, instance: T, options?: { unload?: () => void | Promise<void> }): void {
        this._assertState(['ACTIVE'], 'register');

        if (!token || typeof token !== 'symbol') {
            throw new DIContainerError('Invalid token provided. Token must be a symbol.');
        }
        if (instance === null || instance === undefined) {
            throw new DIContainerError(`Cannot register null or undefined for token ${token.toString()}.`);
        }

        if (this.registry.has(token)) {
            // This is a common scenario during plugin development with hot-reloading.
            // A warning is appropriate to alert the developer, but it shouldn't be a fatal error.
            console.warn(`[DIContainer] Service with token ${token.toString()} is being re-registered. Ensure this is intended.`);
        }

        this.registry.set(token, { instance, unload: options?.unload });
        // Only add to registration order if it's not already there to handle re-registration cases.
        if (!this.registrationOrder.includes(token)) {
            this.registrationOrder.push(token);
        }
    }

    /**
     * Resolves a service instance from the container.
     * This operation is only permitted when the container is in the `ACTIVE` state.
     *
     * @param token The unique symbol of the service to retrieve.
     * @returns The registered service instance.
     * @throws {DIContainerError} if the container is not `ACTIVE` or the service is not found.
     */
    public resolve<T>(token: symbol): T {
        this._assertState(['ACTIVE'], 'resolve');

        const entry = this.registry.get(token);
        if (!entry) {
            throw new DIContainerError(`No service registered for token ${token.toString()}`);
        }
        return entry.instance as T;
    }

    /**
     * Initiates a graceful shutdown of the container and all its managed services.
     * - Transitions the container to `UNLOADING`, then `UNLOADED`.
     * - Calls the `unload` method on all registered services in LIFO order.
     * - The process is resilient, logging errors from individual service unloads without halting the overall cleanup.
     * - This method is idempotent; subsequent calls will have no effect.
     */
    public async unload(): Promise<void> {
        if (this.state !== 'ACTIVE') {
            // It's safe to ignore unload calls if the container is already unloading or unloaded.
            return;
        }

        this._setState('UNLOADING');
        console.log(`[DIContainer] Unloading ${this.registrationOrder.length} services in LIFO order...`);

        const reversedTokens = [...this.registrationOrder].reverse();
        const unloadPromises: Promise<void>[] = [];

        for (const token of reversedTokens) {
            const entry = this.registry.get(token);
            if (entry?.unload) {
                try {
                    const result = entry.unload();
                    // If the unload method is async, add its promise to the list to be awaited.
                    if (result instanceof Promise) {
                        unloadPromises.push(
                            result.catch(err => {
                                // Catch and log errors from individual async unloads to ensure all are attempted.
                                console.error(`[DIContainer] Error during ASYNC unload of service ${token.toString()}:`, err);
                            })
                        );
                    }
                } catch (err) {
                    // Catch and log errors from individual sync unloads.
                    console.error(`[DIContainer] Error during SYNC unload of service ${token.toString()}:`, err);
                }
            }
        }

        // Wait for all asynchronous unload operations to complete.
        await Promise.all(unloadPromises);

        // Final cleanup after all services have been given a chance to unload.
        this.registry.clear();
        this.registrationOrder.length = 0;
        this._setState('UNLOADED');
        console.log('[DIContainer] All services unloaded and container is now UNLOADED.');
    }

    /**
     * Asserts that the container is in one of the allowed states.
     * @param allowedStates An array of states that are permissible for the operation.
     * @param operationName The name of the operation being attempted, for clear error messages.
     * @throws {DIContainerError} if the current state is not in the allowed list.
     */
    private _assertState(allowedStates: DIContainerState[], operationName: string): void {
        if (!allowedStates.includes(this.state)) {
            throw new DIContainerError(`Cannot perform operation '${operationName}' while in state '${this.state}'. Allowed states: [${allowedStates.join(', ')}].`);
        }
    }

    /**
     * Centralized method for changing and logging the container's state.
     * @param newState The new state to transition to.
     */
    private _setState(newState: DIContainerState): void {
        if (this.state !== newState) {
            console.log(`[DIContainer] State changed: ${this.state} -> ${newState}`);
            this.state = newState;
        }
    }
}

/**
 * The global singleton instance of the DI container.
 * The plugin's lifecycle methods (`onload`, `onunload`) will manage this instance's state.
 */
export const container = new DIContainer();
