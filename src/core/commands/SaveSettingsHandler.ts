/**
 * @file Implements the handler for the 'SAVE_SETTINGS' command.
 *       This handler ensures that saving the entire plugin configuration is an atomic,
 *       transactional, and fault-tolerant operation.
 *
 *       Core Principles:
 *       - **Transactional Integrity**: The `handle` method is a single, atomic transaction.
 *         It ensures the request is either fully dispatched to the `SettingsService` or fails
 *         cleanly with a precise, logged error before any partial state change occurs.
 *       - **Robust Error Handling**: A comprehensive try-catch block provides localized,
 *         context-rich error logging for this specific operation. It catches any failures
 *         from the `SettingsService` (e.g., validation errors, file system I/O failures)
 *         and propagates them consistently as a `PluginError` to the CommandBus.
 *       - **Fail-Fast Validation**: The handler performs aggressive upfront validation on the
 *         command payload to reject malformed requests immediately, preventing invalid data
 *         from reaching the core business logic of the `SettingsService`.
 *       - **Single Responsibility & Delegation**: This handler's sole responsibility is to
 *         orchestrate the settings save operation by delegating to the `SettingsService`,
 *         which contains the complex validation, merging, and I/O logic. This adheres to the
 *         Command pattern and separation of concerns.
 */

import { ICommandHandler, SaveSettingsCommand } from '../../types/commands';
import { SettingsService } from '../../services/SettingsService';
import { container, ServiceTokens } from '../../utils/DIContainer';
import { Logger } from '../../utils/Logger';
import { PluginError } from '../../errors/CustomErrors';

export class SaveSettingsHandler implements ICommandHandler<SaveSettingsCommand> {
    public readonly commandType = 'SAVE_SETTINGS';

    // --- Service Accessors ---
    private get settingsService(): SettingsService { return container.resolve<SettingsService>(ServiceTokens.SettingsService); }
    private get logger(): Logger { return container.resolve<Logger>(ServiceTokens.Logger); }

    /**
     * Handles the atomic saving of the entire plugin settings.
     * @param command The command object containing the new settings.
     * @throws {PluginError} Throws an error if the command payload is invalid or if the
     *         underlying service fails. The error is logged before being re-thrown.
     */
    public async handle(command: SaveSettingsCommand): Promise<void> {
        this.logger.log('verbose', `[SaveSettingsHandler] Starting transaction to save plugin settings.`);

        try {
            // --- 1. Fail-Fast Input Validation ---
            if (!command?.payload?.settings || typeof command.payload.settings !== 'object') {
                throw new PluginError('Invalid "SAVE_SETTINGS" command: payload.settings is missing or not an object.');
            }

            // --- 2. Execute Primary Action: Delegate to SettingsService ---
            // The SettingsService is responsible for deep validation, merging with defaults,
            // and writing to the file system.
            await this.settingsService.saveSettings(command.payload.settings);

            this.logger.log('info', `[SaveSettingsHandler] Successfully completed saving plugin settings.`);

        } catch (error: unknown) {
            const errorMessage = `[SaveSettingsHandler] Transaction failed while saving plugin settings.`;
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
