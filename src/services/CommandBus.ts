/**
 * @file Implements the CommandBus, which decouples command dispatchers (UI)
 *       from command handlers (core logic). This service operates as a formal
 *       state machine to ensure predictable behavior, prevent race conditions,
 *       and manage its lifecycle gracefully.
 */

import { Command, ICommandHandler } from '../types/commands';
import { container, ServiceTokens } from '../utils/DIContainer';
import { Logger } from '../utils/Logger';
import { PluginError, createChainedMessage } from '../errors/CustomErrors';

// --- State Machine Definition ---
/**
 * Defines the operational states of the CommandBus. This state machine is critical
 * for ensuring data consistency by preventing concurrent command execution.
 * - `idle`: Ready to accept registrations and dispatch commands.
 * - `dispatching`: Currently executing a command. This acts as a non-reentrant lock.
 * - `unloading`: Shutting down. No new operations are accepted.
 * - `unloaded`: Fully stopped and resources cleared. All operations will fail fast.
 */
type CommandBusState = 'idle' | 'dispatching' | 'unloading' | 'unloaded';

/**
 * Provides a robust, stateful, and lifecycle-aware command bus. It acts as the central
 * dispatcher for all state-mutating operations in the plugin, decoupling the initiators
 * of actions (e.g., UI components) from the business logic that executes them (handlers).
 *
 * @implements The CommandBus is a formal state machine to guarantee predictable behavior.
 * @implements It uses a non-reentrant dispatch mechanism to serialize all command executions,
 *             preventing race conditions between different operations.
 */
export class CommandBus {
    private state: CommandBusState = 'idle';
    private handlers = new Map<string, ICommandHandler<any>>();
    private get logger(): Logger { return container.resolve<Logger>(ServiceTokens.Logger); }

    /**
     * Registers a command handler with the bus. Each handler is responsible for the logic
     * of a single command type.
     *
     * This operation is only permitted when the bus is in an 'idle' state.
     *
     * @param handler The command handler instance to register. It must implement `ICommandHandler`.
     */
    public register(handler: ICommandHandler<any>): void {
        // --- Aggressive State and Input Validation ---
        if (this.state !== 'idle') {
            this.logger.log('warn', `[CommandBus] Attempted to register handler for '${handler?.commandType}' while in state '${this.state}'. Operation ignored.`);
            return;
        }
        if (!handler || typeof handler.commandType !== 'string' || !handler.commandType) {
            this.logger.log('error', `[CommandBus] Invalid handler provided. Must be an object with a non-empty 'commandType' string property.`);
            return;
        }
        if (typeof handler.handle !== 'function') {
            this.logger.log('error', `[CommandBus] Invalid handler for '${handler.commandType}'. It is missing a 'handle' method.`);
            return;
        }

        if (this.handlers.has(handler.commandType)) {
            // This is a common scenario during plugin development with hot-reloading.
            // A warning is appropriate to alert the developer.
            this.logger.log('warn', `[CommandBus] Handler for command type '${handler.commandType}' is being re-registered. Ensure this is intended.`);
        }
        this.handlers.set(handler.commandType, handler);
        this.logger.log('verbose', `[CommandBus] Registered handler for command: ${handler.commandType}`);
    }

    /**
     * Dispatches a command to its registered handler for execution. This method is the sole
     * entry point for initiating state changes through the bus.
     *
     * The dispatch process is **non-reentrant** and **transactional**:
     * - Only one command can be in-flight at a time. If `dispatch` is called while another
     *   command is executing, it will throw an error immediately. This serializes all
     *   state-mutating operations, preventing race conditions.
     * - The entire `handle` method of the corresponding handler is treated as an atomic
     *   transaction. It either completes successfully or throws a structured `PluginError`.
     *
     * @param command The command to dispatch. It must be a valid `Command` object.
     * @returns A promise that resolves with the result from the command handler.
     * @throws {PluginError} if the bus is not idle, the command is invalid, no handler is found, or the handler itself throws an error.
     */
    public async dispatch(command: Command): Promise<any> {
        // --- Aggressive State and Input Validation ---
        if (this.state !== 'idle') {
            const reason = this.state === 'dispatching' ? 'another command is already in progress' : `service is in '${this.state}' state`;
            const errorMessage = `[CommandBus] Cannot dispatch command '${command?.type}'. Reason: ${reason}. This is a non-reentrant bus.`;
            this.logger.log('warn', errorMessage);
            throw new PluginError(errorMessage, undefined, { state: this.state, commandType: command?.type });
        }

        if (!command || typeof command.type !== 'string' || !command.type) {
            const errorMessage = `[CommandBus] Invalid command dispatched. Command must be an object with a non-empty 'type' property.`;
            this.logger.log('error', errorMessage, command);
            throw new PluginError(errorMessage, undefined, { command });
        }

        const handler = this.handlers.get(command.type);
        if (!handler) {
            const errorMessage = `[CommandBus] No handler registered for command type '${command.type}'.`;
            this.logger.log('error', errorMessage);
            throw new PluginError(errorMessage, undefined, { commandType: command.type });
        }

        // --- State Transition and Transactional Execution ---
        this.state = 'dispatching';
        this.logger.log('verbose', `[CommandBus] Dispatching command: ${command.type}. State changed: idle -> dispatching.`, command.payload);

        try {
            // The actual execution of the command handler. The `await` ensures the bus
            // remains in a 'dispatching' state until the handler's async operation completes.
            return await handler.handle(command);
        } catch (error: unknown) {
            // Wrap any error from the handler in a structured PluginError for consistent upstream handling.
            const commandError = new PluginError(
                createChainedMessage(`Command '${command.type}' failed during execution.`, error),
                error instanceof Error ? error : undefined,
                { command }
            );
            this.logger.log('error', `[CommandBus] Error during command execution for '${command.type}':`, commandError);
            // Re-throw the structured error to be handled by the original dispatcher (e.g., UI to show a notice).
            throw commandError;
        } finally {
            // --- CRITICAL: Ensure state is reset to 'idle' even if the handler throws an error. ---
            this.state = 'idle';
            this.logger.log('verbose', `[CommandBus] Finished command: ${command.type}. State changed: dispatching -> idle.`);
        }
    }

    /**
     * Initiates a graceful shutdown of the CommandBus.
     * This should be called during the plugin's `onunload` lifecycle hook.
     * It transitions the bus to an `unloaded` state, preventing any further operations
     * and clearing all handlers to prevent memory leaks and break reference cycles.
     */
    public unload(): void {
        if (this.state === 'unloading' || this.state === 'unloaded') {
            return; // Idempotent unload.
        }

        this.logger.log('info', `[CommandBus] Unloading. Clearing ${this.handlers.size} registered handlers.`);
        this.state = 'unloading';

        // Clear all handlers to break reference cycles and ensure clean garbage collection.
        this.handlers.clear();

        this.state = 'unloaded';
        this.logger.log('info', `[CommandBus] Unloaded successfully.`);
    }
}
