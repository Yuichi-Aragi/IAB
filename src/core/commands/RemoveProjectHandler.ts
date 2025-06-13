/**
 * @file Implements the handler for the 'REMOVE_PROJECT' command.
 *       This handler ensures that removing a project is an atomic, transactional operation.
 *
 *       Core Principles:
 *       - **Transactional Integrity**: The entire `handle` method is a single transaction.
 *         The consequential action of synchronizing Obsidian commands is guaranteed to run
 *         only after the primary action of removing the project from settings succeeds. This
 *         prevents state inconsistencies where a project is deleted from settings but its
 *         build command remains in the UI.
 *       - **Robust Error Handling**: A comprehensive try-catch block provides localized,
 *         context-rich error logging for this specific operation and ensures that failures
 *         at any stage are gracefully handled and propagated to the CommandBus.
 *       - **Fail-Fast Validation**: The handler performs aggressive upfront validation on the
 *         command payload (e.g., presence and type of `projectId`) to reject malformed
 *         requests immediately.
 *       - **Single Responsibility**: This handler's sole responsibility is to orchestrate
 *         the removal transaction, delegating the core logic to the ProjectManager and
 *         the command synchronization to the main Plugin class, while ensuring they execute
 *         in the correct order.
 */

import { ICommandHandler, RemoveProjectCommand } from '../../types/commands';
import { ProjectManager } from '../ProjectManager';
import { InAppBuilderPlugin } from '../InAppBuilderPlugin';
import { container, ServiceTokens } from '../../utils/DIContainer';
import { Logger } from '../../utils/Logger';
import { PluginError } from '../../errors/CustomErrors';

export class RemoveProjectHandler implements ICommandHandler<RemoveProjectCommand> {
    public readonly commandType = 'REMOVE_PROJECT';

    // --- Service Accessors ---
    private get projectManager(): ProjectManager { return container.resolve<ProjectManager>(ServiceTokens.ProjectManager); }
    private get plugin(): InAppBuilderPlugin { return container.resolve<InAppBuilderPlugin>(ServiceTokens.Plugin); }
    private get logger(): Logger { return container.resolve<Logger>(ServiceTokens.Logger); }

    /**
     * Handles the atomic removal of a project and the subsequent
     * synchronization of Obsidian commands.
     * @param command The command object containing the ID of the project to remove.
     * @throws {PluginError} Throws an error if the command payload is invalid, or if the
     *         underlying removal or command synchronization fails. The error is logged
     *         before being re-thrown for the CommandBus to handle.
     */
    public async handle(command: RemoveProjectCommand): Promise<void> {
        const projectId = command?.payload?.projectId || 'unknown';
        this.logger.log('verbose', `[RemoveProjectHandler] Starting transaction to remove project ID: ${projectId}`);

        try {
            // --- 1. Fail-Fast Input Validation ---
            if (!command?.payload?.projectId || typeof command.payload.projectId !== 'string') {
                throw new PluginError('Invalid "REMOVE_PROJECT" command: payload.projectId is missing or not a string.');
            }

            // --- 2. Execute Primary Action: Remove Project from State ---
            // This is delegated to the ProjectManager, which handles its own validation and locking.
            await this.projectManager.removeProject(command.payload.projectId);
            this.logger.log('verbose', `[RemoveProjectHandler] Project ID ${command.payload.projectId} successfully removed from settings.`);

            // --- 3. Execute Consequential Action: Synchronize Commands ---
            // This runs ONLY if the primary action was successful, ensuring consistency.
            // This will remove the command associated with the deleted project.
            this.plugin.registerBuildCommands();
            this.logger.log('verbose', `[RemoveProjectHandler] Obsidian commands synchronized successfully after project removal.`);

            this.logger.log('info', `[RemoveProjectHandler] Successfully completed removal of project ID: ${command.payload.projectId}`);

        } catch (error: unknown) {
            const errorMessage = `[RemoveProjectHandler] Transaction failed while removing project ID: ${projectId}.`;
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
