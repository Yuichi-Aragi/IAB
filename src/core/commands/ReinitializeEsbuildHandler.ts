/**
 * @file Implements the handler for the 'REINITIALIZE_ESBUILD' command.
 *       This handler ensures that forcing a re-initialization of the esbuild service
 *       is an atomic, transactional, and fault-tolerant operation.
 *
 *       Core Principles:
 *       - **Transactional Integrity**: The `handle` method is a single, atomic transaction.
 *         The sequence of `unload()` followed by `initializeEsbuild()` is guaranteed to be
 *         executed in order, or the entire operation fails cleanly. This prevents a partially
 *         re-initialized or inconsistent state in the `EsbuildService`.
 *       - **Robust Error Handling**: A comprehensive try-catch block provides localized,
 *         context-rich error logging for this specific operation and ensures that failures
 *         at any stage are gracefully handled and propagated as a `PluginError` to the CommandBus.
 *       - **Fail-Fast Validation**: The handler performs aggressive upfront validation on the
 *         command payload (e.g., presence and type of `initiatorId`) to reject malformed
 *         requests immediately.
 *       - **Explicit State Management**: The handler explicitly orchestrates the state transition
 *         of the `EsbuildService` by first calling `unload()` to force a reset. This ensures a
 *         predictable and clean starting point for re-initialization, eliminating ambiguity.
 */

import { ICommandHandler, ReinitializeEsbuildCommand } from '../../types/commands';
import { EsbuildService } from '../EsbuildService';
import { container, ServiceTokens } from '../../utils/DIContainer';
import { Logger } from '../../utils/Logger';
import { PluginError } from '../../errors/CustomErrors';

export class ReinitializeEsbuildHandler implements ICommandHandler<ReinitializeEsbuildCommand> {
    public readonly commandType = 'REINITIALIZE_ESBUILD';

    // --- Service Accessors ---
    private get esbuildService(): EsbuildService { return container.resolve<EsbuildService>(ServiceTokens.EsbuildService); }
    private get logger(): Logger { return container.resolve<Logger>(ServiceTokens.Logger); }

    /**
     * Handles the atomic re-initialization of the esbuild service.
     * @param command The command object containing the initiator ID.
     * @throws {PluginError} Throws an error if the command payload is invalid or if the
     *         underlying service fails. The error is logged before being re-thrown.
     */
    public async handle(command: ReinitializeEsbuildCommand): Promise<void> {
        const initiatorId = command?.payload?.initiatorId || 'Unknown';
        this.logger.log('verbose', `[ReinitializeEsbuildHandler] Starting transaction. Initiator: ${initiatorId}`);

        try {
            // --- 1. Fail-Fast Input Validation ---
            if (!command?.payload?.initiatorId || typeof command.payload.initiatorId !== 'string') {
                throw new PluginError('Invalid "REINITIALIZE_ESBUILD" command: payload.initiatorId is missing or not a string.');
            }

            // --- 2. Execute Primary Action: Unload to reset state ---
            // This is a critical step to ensure a clean slate and abort any ongoing operations
            // in the EsbuildService, leveraging its internal generation-based locking.
            this.esbuildService.unload();
            this.logger.log('verbose', `[ReinitializeEsbuildHandler] EsbuildService unloaded successfully, ensuring a clean state.`);

            // --- 3. Execute Consequential Action: Initialize again ---
            // The `initializeEsbuild` method is the main entry point and handles its own state.
            // We show notices because this is typically a user-driven action from the UI.
            await this.esbuildService.initializeEsbuild(initiatorId, true);

            this.logger.log('info', `[ReinitializeEsbuildHandler] Successfully completed esbuild re-initialization for initiator: ${initiatorId}.`);

        } catch (error: unknown) {
            const errorMessage = `[ReinitializeEsbuildHandler] Transaction failed while re-initializing esbuild for initiator: ${initiatorId}.`;
            this.logger.log('error', errorMessage, error);

            // Re-throw the original error (or a wrapped version) to allow the CommandBus
            // and the original dispatcher (e.g., the UI) to be notified of the failure.
            if (error instanceof PluginError) {
                throw error;
            }
            // Wrap non-PluginErrors for consistent error handling upstream.
            throw new PluginError(errorMessage, error instanceof Error ? error : undefined);
        }
    }
}