/**
 * @file Implements the EventBus, which allows for decoupled, reactive communication
 *       from the core logic to the UI and other services.
 */

import { Component } from 'obsidian';
import { AppEvent } from '../types/events';
import { container, ServiceTokens } from '../utils/DIContainer';
import { Logger } from '../utils/Logger';

// --- Types and State Machine ---

/**
 * Defines the operational states of the EventBus. This state machine ensures that
 * the bus behaves predictably throughout the plugin's lifecycle, especially during
 * complex scenarios like re-entrant event publishing or plugin reloads.
 * - `idle`: Ready to accept subscriptions and publish events.
 * - `publishing`: Currently dispatching an event to listeners. This state is used to
 *                 manage re-entrant calls gracefully.
 * - `unloading`: Shutting down. No new subscriptions or publications are allowed.
 * - `unloaded`: Fully stopped. All operations will fail fast.
 */
type EventBusState = 'idle' | 'publishing' | 'unloading' | 'unloaded';

/**
 * A generic listener function type used internally. The payload will be cast correctly
 * during dispatch, as guaranteed by the strictly-typed public `subscribe` method.
 * @internal
 */
type AnyListener = (payload: any) => void;

/**
 * A strongly-typed listener for a specific event. This is the type exposed to consumers.
 */
type TypedListener<T extends AppEvent> = (payload: T['payload']) => void;

/**
 * Provides a robust, stateful, and lifecycle-aware event bus for decoupled communication
 * between different parts of the plugin. It is the central nervous system for broadcasting
 * state changes and other significant occurrences.
 *
 * @implements The EventBus is a formal state machine to guarantee predictable behavior.
 * @implements It uses a copy-on-write dispatch mechanism to handle listener modifications during event publication.
 * @implements It integrates deeply with Obsidian's `Component` lifecycle for automatic memory management.
 */
export class EventBus {
    private state: EventBusState = 'idle';
    private listeners: Map<AppEvent['type'], Set<AnyListener>> = new Map();
    private get logger(): Logger { return container.resolve<Logger>(ServiceTokens.Logger); }

    /**
     * Subscribes a callback to a specific event type. This method provides a raw subscription
     * and returns a function to manually unsubscribe.
     *
     * For UI components, it is **strongly recommended** to use `subscribeComponent` to prevent memory leaks.
     *
     * @template T - The specific event type string (e.g., 'BUILD_SUCCEEDED').
     * @param eventType The type of the event to subscribe to.
     * @param callback The function to execute when the event is published. It will receive the event's payload.
     * @returns An `unsubscribe` function. Calling this function will remove the listener. It is safe to call multiple times.
     */
    public subscribe<T extends AppEvent['type']>(
        eventType: T,
        callback: TypedListener<Extract<AppEvent, { type: T }>>
    ): () => void {
        // --- Aggressive State and Input Validation ---
        if (this.state === 'unloading' || this.state === 'unloaded') {
            this.logger.log('warn', `[EventBus] Attempted to subscribe to '${eventType}' while in state '${this.state}'. Subscription ignored.`);
            return () => {}; // Return a no-op function for safety.
        }
        if (typeof callback !== 'function') {
            this.logger.log('error', `[EventBus] Invalid callback provided for '${eventType}'. Must be a function.`);
            return () => {};
        }

        if (!this.listeners.has(eventType)) {
            this.listeners.set(eventType, new Set());
        }

        const listenerSet = this.listeners.get(eventType)!;
        // Cast to the internal `AnyListener` type for storage. Type safety is enforced by the method signature.
        const listener = callback as AnyListener;

        // Prevent duplicate subscriptions of the exact same function instance to avoid redundant notifications.
        if (listenerSet.has(listener)) {
            this.logger.log('warn', `[EventBus] Duplicate subscription for event '${eventType}' with the same callback function instance ignored.`);
        } else {
            listenerSet.add(listener);
        }

        // Return a robust unsubscribe function that is safe to call multiple times.
        return () => {
            // No action needed if the bus is already shutting down, as all listeners will be cleared.
            if (this.state === 'unloading' || this.state === 'unloaded') {
                return;
            }
            const currentListenerSet = this.listeners.get(eventType);
            if (currentListenerSet) {
                currentListenerSet.delete(listener);
                // If the set becomes empty, remove the key from the map to keep it clean and memory-efficient.
                if (currentListenerSet.size === 0) {
                    this.listeners.delete(eventType);
                }
            }
        };
    }

    /**
     * Subscribes a callback to an event and automatically handles unsubscribing
     * when the provided Obsidian `Component` is unloaded. This is the safest and recommended
     * way to subscribe from UI components (e.g., Modals, SettingTabs, Views) and
     * is the primary defense against memory leaks in the plugin.
     *
     * @param component The Obsidian `Component` (e.g., `this` in a Modal or View) that owns this subscription.
     * @param eventType The type of the event to subscribe to.
     * @param callback The function to execute when the event is published.
     */
    public subscribeComponent<T extends AppEvent['type']>(
        component: Component,
        eventType: T,
        callback: TypedListener<Extract<AppEvent, { type: T }>>
    ): void {
        const unsubscribe = this.subscribe(eventType, callback);
        // Register the cleanup function with the component's lifecycle.
        // When the component is unloaded, Obsidian will automatically call this function.
        component.register(unsubscribe);
    }

    /**
     * Publishes an event, notifying all subscribed listeners for that event type.
     * This operation is designed to be highly resilient:
     * - It is safe against re-entrant calls (a listener publishing another event).
     * - It is safe against modifications to the listener list during dispatch.
     * - An error in one listener will not prevent other listeners from being notified.
     *
     * @param event The event object to publish, containing a `type` and a `payload`.
     */
    public publish<T extends AppEvent>(event: T): void {
        // --- Aggressive State Check ---
        if (this.state === 'unloading' || this.state === 'unloaded') {
            this.logger.log('verbose', `[EventBus] Event '${event.type}' publication blocked due to state: '${this.state}'.`);
            return;
        }

        const eventListeners = this.listeners.get(event.type);
        if (!eventListeners || eventListeners.size === 0) {
            return; // No listeners for this event, exit early.
        }

        this.logger.log('verbose', `[EventBus] Publishing event: ${event.type}`, event.payload);

        const previousState = this.state;
        this.state = 'publishing';

        // --- Copy-on-Write Dispatch ---
        // Create a snapshot of the listeners at the time of publish. This is a critical step
        // to prevent issues if a listener subscribes or unsubscribes during its own execution.
        const listenersToNotify = Array.from(eventListeners);

        for (const listener of listenersToNotify) {
            try {
                listener(event.payload);
            } catch (error: unknown) {
                const listenerName = listener.name ? `'${listener.name}'` : 'anonymous listener';
                const errorMessage = `[EventBus] Unhandled error in ${listenerName} for event '${event.type}'. See details below.`;
                this.logger.log('error', errorMessage, error);
                // The loop continues to ensure other listeners are still notified.
            }
        }

        // Restore previous state. This correctly handles re-entrant calls.
        // If another event was published by a listener, `previousState` would be 'publishing',
        // and we correctly remain in that state until the outer call completes.
        this.state = previousState;
    }

    /**
     * Initiates a graceful shutdown of the EventBus.
     * This should be called during the plugin's `onunload` lifecycle hook.
     * It transitions the bus to an `unloaded` state, preventing any further operations
     * and clearing all listeners to prevent memory leaks and break reference cycles.
     */
    public unload(): void {
        if (this.state === 'unloading' || this.state === 'unloaded') {
            return; // Idempotent unload.
        }

        this.logger.log('info', `[EventBus] Unloading. Clearing ${this.listeners.size} event types with their listeners.`);
        this.state = 'unloading';

        // Clear all listeners to break reference cycles and ensure clean garbage collection.
        this.listeners.clear();

        this.state = 'unloaded';
        this.logger.log('info', `[EventBus] Unloaded successfully.`);
    }
}
