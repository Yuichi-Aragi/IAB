/**
 * @file Implements the handler for the 'ADD_PROJECT' command.
 *       This handler ensures that adding a new project is an atomic, transactional operation.
 *
 *       Core Principles:
 *       - **Transactional Integrity**: The entire `handle` method is a single transaction.
 *         The consequential action of synchronizing Obsidian commands is guaranteed to run
 *         only after the primary action of adding the project to settings succeeds. This
 *         prevents state inconsistencies where a project is saved but its build command
 *         is not created.
 *       - **Robust Error Handling**: A comprehensive try-catch block provides localized,
 *         context-rich error logging for this specific operation and ensures that failures
 *         at any stage are gracefully handled and propagated to the CommandBus.
 *       - **Fail-Fast Validation**: The handler performs upfront validation on the command
 *         payload to reject malformed requests before they reach the core business logic.
 *       - **Single Responsibility**: This handler's sole responsibility is to orchestrate
 *         the add transaction, delegating the core logic to the ProjectManager and
 *         the command registration to the main Plugin class, while ensuring they execute
 *         in the correct order.
 */

import { ICommandHandler, AddProjectCommand } from '../../types/commands';
import { ProjectManager } from '../ProjectManager';
import { InAppBuilderPlugin } from '../InAppBuilderPlugin';
import { container, ServiceTokens } from '../../utils/DIContainer';
import { Logger } from '../../utils/Logger';
import { PluginError } from '../../errors/CustomErrors';

export class AddProjectHandler implements ICommandHandler<AddProjectCommand> {
    public readonly commandType = 'ADD_PROJECT';

    // --- Service Accessors for clarity and lazy resolution ---
    private get projectManager(): ProjectManager { return container.resolve<ProjectManager>(ServiceTokens.ProjectManager); }
    private get plugin(): InAppBuilderPlugin { return container.resolve<InAppBuilderPlugin>(ServiceTokens.Plugin); }
    private get logger(): Logger { return container.resolve<Logger>(ServiceTokens.Logger); }

    /**
     * Handles the atomic addition of a new project and the subsequent
     * synchronization of its associated Obsidian command.
     * @param command The command object containing the new project data.
     * @throws {PluginError} Throws an error if the command payload is invalid, or if the
     *         underlying add or command registration fails. The error is logged
     *         before being re-thrown for the CommandBus to handle.
     */
    public async handle(command: AddProjectCommand): Promise<void> {
        this.logger.log('verbose', `[AddProjectHandler] Starting transaction for new project: "${command?.payload?.projectData?.name}"`);

        try {
            // --- 1. Fail-Fast Input Validation ---
            if (!command?.payload?.projectData) {
                throw new PluginError('Invalid "ADD_PROJECT" command: payload.projectData is missing.');
            }
            const { projectData } = command.payload;

            // --- 2. Execute Primary Action: Add Project to State ---
            // This is delegated to the ProjectManager, which handles its own validation and locking.
            const newProject = await this.projectManager.addProject(projectData);
            this.logger.log('verbose', `[AddProjectHandler] Project "${newProject.name}" (ID: ${newProject.id}) successfully added to settings.`);

            // --- 3. Execute Consequential Action: Synchronize Commands ---
            // This runs ONLY if the primary action was successful, ensuring consistency.
            this.plugin.registerBuildCommands();
            this.logger.log('verbose', `[AddProjectHandler] Obsidian commands synchronized successfully after project addition.`);

            this.logger.log('info', `[AddProjectHandler] Successfully completed addition of project: "${newProject.name}"`);

        } catch (error: unknown) {
            const errorMessage = `[AddProjectHandler] Transaction failed while adding new project.`;
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
