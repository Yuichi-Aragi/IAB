/**
 * @file Implements the handler for the 'CLEAR_CACHE' command.
 *       This handler acts as a robust, transactional entry point for clearing the esbuild asset cache.
 *
 *       Core Principles:
 *       - **Transactional Integrity**: The `handle` method is a single, atomic transaction.
 *         It ensures the request is either fully dispatched to the `EsbuildService` or fails
 *         cleanly with a precise, logged error before any partial state change occurs.
 *       - **Robust Error Handling**: A comprehensive try-catch block provides localized,
 *         context-rich error logging for this specific operation. It catches any failures
 *         from the `EsbuildService` (e.g., file system errors, re-initialization failures)
 *         and propagates them consistently as a `PluginError` to the CommandBus.
 *       - **Single Responsibility & Delegation**: This handler's sole responsibility is to
 *         orchestrate the cache clearing operation by delegating to the `EsbuildService`,
 *         which contains the complex state management and I/O logic. This adheres to the
 *         Command pattern and separation of concerns.
 *       - **State-Awareness (Implicit)**: By calling `clearCacheAndReinitialize`, the handler
 *         leverages the `EsbuildService`'s internal state machine, which is designed to
 *         handle race conditions and invalid states gracefully (e.g., by aborting stale operations).
 */

import { ICommandHandler, ClearCacheCommand } from '../../types/commands';
import { EsbuildService } from '../EsbuildService';
import { container, ServiceTokens } from '../../utils/DIContainer';
import { Logger } from '../../utils/Logger';
import { PluginError } from '../../errors/CustomErrors';

export class ClearCacheHandler implements ICommandHandler<ClearCacheCommand> {
    public readonly commandType = 'CLEAR_CACHE';

    // --- Service Accessors ---
    private get esbuildService(): EsbuildService { return container.resolve<EsbuildService>(ServiceTokens.EsbuildService); }
    private get logger(): Logger { return container.resolve<Logger>(ServiceTokens.Logger); }

    /**
     * Handles the atomic clearing of the esbuild asset cache and subsequent re-initialization.
     * @param command The command object.
     * @throws {PluginError} Throws an error if the underlying service fails. The error is
     *         logged before being re-thrown for the CommandBus to handle.
     */
    public async handle(command: ClearCacheCommand): Promise<void> {
        this.logger.log('verbose', `[ClearCacheHandler] Starting transaction to clear esbuild cache.`);

        try {
            // --- 1. Execute Primary Action: Delegate to EsbuildService ---
            // This service method is designed to be atomic and state-aware, handling its own
            // internal race conditions and state transitions.
            await this.esbuildService.clearCacheAndReinitialize('SettingsTabManualClear');

            this.logger.log('info', `[ClearCacheHandler] Successfully completed esbuild cache clearing and re-initialization.`);

        } catch (error: unknown) {
            const errorMessage = `[ClearCacheHandler] Transaction failed while clearing esbuild cache.`;
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
