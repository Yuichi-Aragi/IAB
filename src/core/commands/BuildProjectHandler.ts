/**
 * @file Implements the handler for the 'BUILD_PROJECT' command.
 *       This handler acts as a robust, transactional entry point for initiating a build.
 *
 *       Core Principles:
 *       - **Transactional Integrity**: The `handle` method is a single, atomic transaction.
 *         It ensures that a build request is either valid and dispatched to the BuildService,
 *         or it fails cleanly with a precise error before any significant processing occurs.
 *       - **Robust Error Handling**: A comprehensive try-catch block provides localized,
 *         context-rich error logging for this specific operation. It catches any failures
 *         from the BuildService (e.g., build lock engaged, initialization errors) and
 *         propagates them consistently to the CommandBus.
 *       - **Fail-Fast Validation**: The handler performs aggressive upfront validation on the
 *         command payload (e.g., presence and type of `projectId`) to reject malformed
 *         requests immediately, preventing invalid data from reaching the core business logic.
 *       - **Single Responsibility**: This handler's sole responsibility is to validate a build
 *         request and dispatch it to the BuildService. It does not contain any build logic itself,
 *         adhering to the Command pattern and separation of concerns.
 */

import { ICommandHandler, BuildProjectCommand } from '../../types/commands';
import { BuildService } from '../BuildService';
import { container, ServiceTokens } from '../../utils/DIContainer';
import { Logger } from '../../utils/Logger';
import { PluginError } from '../../errors/CustomErrors';

export class BuildProjectHandler implements ICommandHandler<BuildProjectCommand> {
    public readonly commandType = 'BUILD_PROJECT';

    // --- Service Accessors ---
    private get buildService(): BuildService { return container.resolve<BuildService>(ServiceTokens.BuildService); }
    private get logger(): Logger { return container.resolve<Logger>(ServiceTokens.Logger); }

    /**
     * Handles the validation and dispatch of a project build request.
     * @param command The command object containing the projectId and initiator.
     * @throws {PluginError} Throws an error if the command payload is invalid or if the
     *         underlying BuildService fails to start the build. The error is logged
     *         before being re-thrown for the CommandBus to handle.
     */
    public async handle(command: BuildProjectCommand): Promise<void> {
        this.logger.log('verbose', `[BuildProjectHandler] Starting transaction for build request. Project ID: ${command?.payload?.projectId}`);

        try {
            // --- 1. Fail-Fast Input Validation ---
            if (!command?.payload?.projectId || typeof command.payload.projectId !== 'string') {
                throw new PluginError('Invalid "BUILD_PROJECT" command: payload.projectId is missing or not a string.');
            }
            // Default initiator to 'command' if not provided, ensuring the BuildService always receives a valid value.
            const { projectId, initiator = 'command' } = command.payload;

            // --- 2. Execute Primary Action: Trigger Build ---
            // This is delegated to the BuildService, which handles its own state machine (build lock) and logic.
            await this.buildService.triggerBuild(projectId, initiator);

            // Note: The BuildService is responsible for publishing success/failure events.
            // This handler's job is done once the build is successfully triggered.
            this.logger.log('info', `[BuildProjectHandler] Successfully dispatched build command for project ID: ${projectId}`);

        } catch (error: unknown) {
            const projectId = command?.payload?.projectId || 'unknown';
            const errorMessage = `[BuildProjectHandler] Transaction failed while dispatching build for project ID: ${projectId}.`;
            this.logger.log('error', errorMessage, error);

            // Re-throw the original error (or a wrapped version) to allow the CommandBus
            // and the original dispatcher (e.g., the UI) to be notified of the failure.
            if (error instanceof PluginError) {
                throw error;
            }
            throw new PluginError(errorMessage, error instanceof Error ? error : undefined);
        }
    }
}
