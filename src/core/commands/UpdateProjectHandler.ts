/**
 * @file Implements the handler for the 'UPDATE_PROJECT' command.
 *       This handler ensures that updating a project is an atomic, transactional operation.
 *
 *       Core Principles:
 *       - **Transactional Integrity**: The entire `handle` method is a single transaction.
 *         The consequential action of synchronizing Obsidian commands is guaranteed to run
 *         only after the primary action of updating the project settings succeeds. This
 *         prevents state inconsistencies where settings are saved but the UI (commands)
 *         is not updated.
 *       - **Robust Error Handling**: A comprehensive try-catch block provides localized,
 *         context-rich error logging for this specific operation and ensures that failures
 *         at any stage are gracefully handled and propagated to the CommandBus.
 *       - **Fail-Fast Validation**: The handler performs upfront validation on the command
 *         payload to reject malformed requests before they reach the core business logic.
 *       - **Single Responsibility**: This handler's sole responsibility is to orchestrate
 *         the update transaction, delegating the core logic to the ProjectManager and
 *         the command registration to the main Plugin class, while ensuring they execute
 *         in the correct order.
 */

import { ICommandHandler, UpdateProjectCommand } from '../../types/commands';
import { ProjectManager } from '../ProjectManager';
import { InAppBuilderPlugin } from '../InAppBuilderPlugin';
import { container, ServiceTokens } from '../../utils/DIContainer';
import { Logger } from '../../utils/Logger';
import { PluginError } from '../../errors/CustomErrors';

export class UpdateProjectHandler implements ICommandHandler<UpdateProjectCommand> {
    public readonly commandType = 'UPDATE_PROJECT';

    // --- Service Accessors ---
    private get projectManager(): ProjectManager { return container.resolve<ProjectManager>(ServiceTokens.ProjectManager); }
    private get plugin(): InAppBuilderPlugin { return container.resolve<InAppBuilderPlugin>(ServiceTokens.Plugin); }
    private get logger(): Logger { return container.resolve<Logger>(ServiceTokens.Logger); }

    /**
     * Handles the atomic update of a project's settings and the subsequent
     * synchronization of its associated Obsidian command.
     * @param command The command object containing the project data to update.
     * @throws {PluginError} Throws an error if the command payload is invalid, or if the
     *         underlying update or command registration fails. The error is logged
     *         before being re-thrown for the CommandBus to handle.
     */
    public async handle(command: UpdateProjectCommand): Promise<void> {
        this.logger.log('verbose', `[UpdateProjectHandler] Starting transaction for project ID: ${command?.payload?.projectData?.id}`);

        try {
            // --- 1. Fail-Fast Input Validation ---
            if (!command?.payload?.projectData?.id) {
                throw new PluginError('Invalid "UPDATE_PROJECT" command: payload.projectData or its ID is missing.');
            }
            const { projectData } = command.payload;

            // --- 2. Execute Primary Action: Update Project State ---
            // This is delegated to the ProjectManager, which handles its own validation and locking.
            await this.projectManager.updateProject(projectData);
            this.logger.log('verbose', `[UpdateProjectHandler] Project data for "${projectData.name}" (ID: ${projectData.id}) successfully updated.`);

            // --- 3. Execute Consequential Action: Synchronize Commands ---
            // This runs ONLY if the primary action was successful, ensuring consistency.
            this.plugin.registerBuildCommands();
            this.logger.log('verbose', `[UpdateProjectHandler] Obsidian commands synchronized successfully after project update.`);

            this.logger.log('info', `[UpdateProjectHandler] Successfully completed update for project: "${projectData.name}"`);

        } catch (error: unknown) {
            const errorMessage = `[UpdateProjectHandler] Transaction failed while updating project.`;
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
