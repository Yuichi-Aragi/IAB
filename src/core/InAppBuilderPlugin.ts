/**
 * @file The main entry point and orchestrator for the In-App Builder Obsidian plugin.
 *       This class extends Obsidian's `Plugin` class and is responsible for:
 *       - Initializing and managing the lifecycle of all plugin services.
 *       - Operating as a formal state machine to ensure predictable behavior and prevent race conditions.
 *       - Loading plugin settings.
 *       - Registering the settings tab.
 *       - Performing a full synchronization of Obsidian commands to match the project list,
 *         including the removal of stale commands for deleted projects.
 *       - Coordinating the initial, non-blocking initialization of the esbuild service.
 *       - Storing and providing access to last build diagnostic information for projects.
 */

import { Plugin, Notice, App, PluginManifest } from 'obsidian';
import { LogLevel, ProjectSettings, PluginSettings } from '../types';
import { Logger } from '../utils/Logger';
import { SettingsService } from '../services/SettingsService';
import { NetworkService } from '../services/NetworkService';
import { FileService } from '../services/FileService';
import { EsbuildService } from './EsbuildService';
import { ProjectManager } from './ProjectManager';
import { InAppBuilderSettingTab } from '../components/InAppBuilderSettingTab';
import { PluginError } from '../errors/CustomErrors';
import { container, ServiceTokens } from '../utils/DIContainer';
import { CommandBus } from '../services/CommandBus';
import { EventBus } from '../services/EventBus';
import { BuildProjectHandler } from './commands/BuildProjectHandler';
import { AddProjectHandler } from './commands/AddProjectHandler';
import { UpdateProjectHandler } from './commands/UpdateProjectHandler';
import { RemoveProjectHandler } from './commands/RemoveProjectHandler';
import { ReinitializeEsbuildHandler } from './commands/ReinitializeEsbuildHandler';
import { CopyDiagnosticsHandler } from './commands/CopyDiagnosticsHandler';
import { SaveSettingsHandler } from './commands/SaveSettingsHandler';
import { AnalysisView } from '../views/AnalysisView';
import { ANALYSIS_VIEW_TYPE, DEFAULT_GLOBAL_LOG_LEVEL } from '../constants';
import { BuildService } from './BuildService';
import { BuildStateService } from '../services/BuildStateService';

type PluginState = 'unloaded' | 'loading' | 'loaded' | 'unloading' | 'failed';

/**
 * The main plugin class for the In-App Builder.
 * Implements a state machine to ensure robust lifecycle management.
 */
export class InAppBuilderPlugin extends Plugin {
    // --- Service Getters for convenient, type-safe access ---
    get logger(): Logger { return container.resolve<Logger>(ServiceTokens.Logger); }
    get settingsService(): SettingsService { return container.resolve<SettingsService>(ServiceTokens.SettingsService); }
    get projectManager(): ProjectManager { return container.resolve<ProjectManager>(ServiceTokens.ProjectManager); }
    get esbuildService(): EsbuildService { return container.resolve<EsbuildService>(ServiceTokens.EsbuildService); }
    get eventBus(): EventBus { return container.resolve<EventBus>(ServiceTokens.EventBus); }

    // --- State Management ---
    private pluginState: PluginState = 'unloaded';
    private readonly registeredCommandIds: Set<string> = new Set();
    private analysisViewRibbonIcon: HTMLElement | null = null;

    constructor(app: App, manifest: PluginManifest) {
        super(app, manifest);
        this.pluginState = 'unloaded';
    }

    /**
     * Plugin load lifecycle method. Initializes all services and sets up the plugin.
     * This method is designed to be robust: if any part of the initialization fails,
     * it will trigger a full cleanup to prevent an unstable, partially-loaded state.
     */
    async onload(): Promise<void> {
        if (this.pluginState !== 'unloaded') {
            console.warn(`[InAppBuilder] onload called in an unexpected state: ${this.pluginState}. Aborting to prevent duplicate initialization.`);
            return;
        }
        this.pluginState = 'loading';
        console.log(`[InAppBuilder] [INFO] Loading In-App Builder Plugin v${this.manifest.version}...`);

        try {
            // --- Reset DI Container for clean start (especially for hot-reloading) ---
            container.reset();

            // --- Service Initialization and DI Registration ---
            // 1. Create logger with a safe, default provider. It will be updated after settings load.
            const logger = new Logger(() => DEFAULT_GLOBAL_LOG_LEVEL);
            container.register(ServiceTokens.Logger, logger);
            container.register(ServiceTokens.Plugin, this);

            // 2. Register event/command buses and other core services.
            const eventBus = new EventBus();
            container.register(ServiceTokens.EventBus, eventBus, { unload: () => eventBus.unload() });

            const commandBus = new CommandBus();
            container.register(ServiceTokens.CommandBus, commandBus, { unload: () => commandBus.unload() });

            const settingsService = new SettingsService(this);
            container.register(ServiceTokens.SettingsService, settingsService);

            const buildStateService = new BuildStateService();
            container.register(ServiceTokens.BuildStateService, buildStateService, { unload: () => buildStateService.unload() });

            const networkService = new NetworkService(this.app);
            container.register(ServiceTokens.NetworkService, networkService, { unload: () => networkService.unload() });

            const fileService = new FileService(this.app);
            container.register(ServiceTokens.FileService, fileService, { unload: () => fileService.unload() });

            // Services with removed `plugin` dependency
            const esbuildService = new EsbuildService(this.app);
            container.register(ServiceTokens.EsbuildService, esbuildService, { unload: () => esbuildService.unload() });

            const projectManager = new ProjectManager();
            container.register(ServiceTokens.ProjectManager, projectManager, { unload: () => projectManager.shutdown() });

            container.register(ServiceTokens.BuildService, new BuildService(this.app));
            logger.log('verbose', 'All services initialized and registered in DI container.');

            this.registerCommandHandlers();
            logger.log('verbose', 'Command handlers registered with CommandBus.');

            // --- Settings and UI Setup ---
            // 3. Load settings from disk.
            await settingsService.loadSettings();
            logger.log('verbose', 'Plugin settings loaded.');

            // 4. Update logger with the real provider now that settings are loaded.
            logger.setLogLevelProvider(() => settingsService.getGlobalLogLevel());
            logger.log('verbose', 'Logger log level provider updated to use settings.');

            this.addSettingTab(new InAppBuilderSettingTab(this.app, this));
            logger.log('verbose', 'Settings tab added.');

            // --- Analysis View Setup ---
            this.registerView(ANALYSIS_VIEW_TYPE, (leaf) => new AnalysisView(leaf, this));
            this.analysisViewRibbonIcon = this.addRibbonIcon('microscope', 'In-App Builder Analysis', () => this.activateAnalysisView());
            this._updateAnalysisViewVisibility(settingsService.getSettings());
            this.eventBus.subscribeComponent(this, 'SETTINGS_CHANGED', (payload) => this._updateAnalysisViewVisibility(payload.newSettings));

            // --- Final State Transition and Post-Load Tasks ---
            this.pluginState = 'loaded';
            this.registerBuildCommands(); // Now safe to register commands

            logger.log('info', 'Initiating background esbuild service initialization...');
            this.esbuildService.initializeEsbuild('PluginLoad').catch(() => {
                // This is a non-critical failure on initial load. The service will try again on-demand.
                logger.log('warn', "Initial background esbuild service initialization failed. This is expected if not configured. Service will auto-initialize on first build.");
            });

            logger.log('info', `In-App Builder Plugin v${this.manifest.version} loaded successfully.`);

        } catch (error) {
            this.pluginState = 'failed';
            console.error('[InAppBuilder] [ERROR] CRITICAL: Failed to load plugin. Attempting to unload to prevent an unstable state.', error);
            await this.onunload(); // Trigger cleanup
        }
    }

    /**
     * Plugin unload lifecycle method. Cleans up all resources, services, and state.
     * This method is designed to be resilient, attempting all cleanup steps even if one fails.
     */
    async onunload(): Promise<void> {
        // Prevent re-entry and handle calls from a failed onload.
        if (this.pluginState === 'unloading' || this.pluginState === 'unloaded') {
            return;
        }
        const previousState = this.pluginState;
        this.pluginState = 'unloading';
        console.log(`[InAppBuilder] [INFO] Unloading In-App Builder Plugin v${this.manifest.version} from state: ${previousState}...`);

        // --- Resource Cleanup ---
        // Detach views first to prevent them from trying to access services that are being unloaded.
        this.app.workspace.detachLeavesOfType(ANALYSIS_VIEW_TYPE);

        // The DI container's unload method will orchestrate the graceful shutdown of all
        // registered services (like EsbuildService) in the correct LIFO order.
        try {
            await container.unload();
        } catch (e) {
            // Use console.error as the logger service itself is now unloaded.
            console.error('[InAppBuilder] Error during DI container unload:', e);
        }

        // Clear internal plugin state that is not managed by the DI container.
        this.registeredCommandIds.clear(); // Obsidian handles command removal, but we clear our tracker.
        this.analysisViewRibbonIcon = null;

        this.pluginState = 'unloaded';
        // Use console.log for the final message as the logger service is no longer available.
        console.log(`[InAppBuilder] [INFO] In-App Builder Plugin v${this.manifest.version} unloaded.`);
    }

    /**
     * Registers all command handlers with the CommandBus.
     * This centralizes the command handling logic.
     */
    private registerCommandHandlers(): void {
        const commandBus = container.resolve<CommandBus>(ServiceTokens.CommandBus);
        commandBus.register(new BuildProjectHandler());
        commandBus.register(new AddProjectHandler());
        commandBus.register(new UpdateProjectHandler());
        commandBus.register(new RemoveProjectHandler());
        commandBus.register(new ReinitializeEsbuildHandler());
        commandBus.register(new CopyDiagnosticsHandler());
        commandBus.register(new SaveSettingsHandler());
    }

    /**
     * Synchronizes the registered Obsidian commands with the current list of projects.
     * This method is the single source of truth for build commands. It will:
     * 1. Correct any invalid command IDs in the settings.
     * 2. Remove commands for projects that have been deleted.
     * 3. Add or update commands for all current projects.
     */
    public registerBuildCommands(): void {
        if (this.pluginState !== 'loaded') {
            this.logger.log('warn', `registerBuildCommands called in invalid state: ${this.pluginState}. Aborting.`);
            return;
        }
        this.logger.log('verbose', 'Syncing build commands with project list...');

        const currentSettings = this.settingsService.getSettings();
        const projects = currentSettings.projects;
        const newCommandIds = new Set<string>();
        let settingsChanged = false;

        // Phase 1: Create a new projects array with corrected command IDs.
        const updatedProjects = projects.map(project => {
            if (!project?.id || !project.name) {
                this.logger.log('error', "Attempted to register command for an invalid project configuration:", project);
                return project; // Return original to avoid losing it from settings
            }
            const expectedCommandId = `in-app-builder:build-${project.id}`;
            newCommandIds.add(expectedCommandId);

            if (project.commandId !== expectedCommandId) {
                this.logger.log('info', `Correcting commandId for project "${project.name}" from "${project.commandId}" to "${expectedCommandId}".`);
                settingsChanged = true;
                // Create a new project object with the updated commandId, respecting immutability.
                return { ...project, commandId: expectedCommandId };
            }
            return project; // No change, return original object.
        });

        // Phase 2: Remove stale commands that no longer have a corresponding project.
        const commandIdsToRemove = new Set([...this.registeredCommandIds].filter(id => !newCommandIds.has(id)));
        if (commandIdsToRemove.size > 0) {
            this.logger.log('info', `Removing ${commandIdsToRemove.size} stale build command(s).`);
            // Accessing internal app property to remove commands is a common workaround.
            const commands = (this.app as any).commands.commands;
            if (commands) {
                commandIdsToRemove.forEach(id => {
                    if (commands[id]) {
                        delete commands[id];
                    }
                    this.registeredCommandIds.delete(id);
                });
            } else {
                this.logger.log('warn', 'Could not access app.commands.commands to remove stale commands.');
            }
        }

        // Phase 3: Add or update commands for all current projects.
        updatedProjects.forEach(project => {
            const commandId = project.commandId!; // Guaranteed to be set by Phase 1.
            this.addCommand({
                id: commandId,
                name: `Build: ${project.name}`,
                icon: 'play-circle',
                callback: async () => {
                    if (this.pluginState !== 'loaded') {
                        new Notice('In-App Builder plugin is not ready. Please wait or reload.');
                        return;
                    }
                    this.logger.log('info', `Command triggered for project: "${project.name}" (ID: ${project.id})`);
                    try {
                        const commandBus = container.resolve<CommandBus>(ServiceTokens.CommandBus);
                        await commandBus.dispatch({ type: 'BUILD_PROJECT', payload: { projectId: project.id, initiator: 'command' } });
                    } catch (error: unknown) {
                        const buildError = error instanceof PluginError ? error : new Error(String(error));
                        this.logger.log('error', `Error from build command dispatch for "${project.name}":`, buildError);
                        new Notice(`Failed to initiate build for "${project.name}": ${buildError.message.substring(0, 100)}... Check console.`, 7000);
                    }
                }
            });
            this.registeredCommandIds.add(commandId);
        });

        // Phase 4: Persist settings if any command IDs were corrected.
        if (settingsChanged) {
            this.logger.log('info', 'One or more project commandIds were corrected. Saving settings...');
            const newSettings: PluginSettings = { ...currentSettings, projects: updatedProjects };
            this.settingsService.saveSettings(newSettings).catch(e => 
                this.logger.log('error', `Failed to save settings after correcting commandIds:`, e)
            );
        }

        this.logger.log('info', `Command sync complete. Active commands: ${this.registeredCommandIds.size}. Total projects: ${projects.length}.`);
    }

    /**
     * Ensures the analysis view is visible in the right sidebar.
     */
    private async activateAnalysisView(): Promise<void> {
        this.app.workspace.detachLeavesOfType(ANALYSIS_VIEW_TYPE);
        const leaf = this.app.workspace.getRightLeaf(false);
        if (leaf) {
            await leaf.setViewState({
                type: ANALYSIS_VIEW_TYPE,
                active: true,
            });
            this.app.workspace.revealLeaf(leaf);
        }
    }

    /**
     * Controls the visibility of the analysis view icon and detaches the view if disabled.
     * @param settings The current plugin settings.
     */
    private _updateAnalysisViewVisibility(settings: PluginSettings): void {
        if (this.analysisViewRibbonIcon) {
            this.analysisViewRibbonIcon.style.display = settings.realTimeAnalysisEnabled ? '' : 'none';
        }
        if (!settings.realTimeAnalysisEnabled) {
            this.app.workspace.detachLeavesOfType(ANALYSIS_VIEW_TYPE);
        }
    }
}