import { Plugin, Notice } from 'obsidian';
import { PluginSettings, LogLevel, ProjectSettings } from '../types';
import {
    DEFAULT_ESBUILD_JS_CDN_URL,
    DEFAULT_ESBUILD_WASM_CDN_URL,
    DEFAULT_GLOBAL_LOG_LEVEL,
    DEFAULT_PROJECT_BUILD_OPTIONS,
    DEFAULT_PROJECT_LOG_LEVEL,
} from '../constants';
import { Logger } from '../utils/Logger';
import { isProjectSettingsValid, getValidationIssuesSummary } from '../utils/ValidationUtils';
import { PluginError, createChainedMessage } from '../errors/CustomErrors';
import { container, ServiceTokens } from '../utils/DIContainer';
import { EventBus } from './EventBus';

// --- State Machine Definition ---
/**
 * Defines the possible operational states of the SettingsService.
 * This ensures predictable behavior and prevents race conditions during I/O operations.
 * - `uninitialized`: The service has not yet loaded settings from disk.
 * - `loading`: The service is in the process of reading and parsing settings from disk.
 * - `idle`: The service is ready and has a valid settings state in memory.
 * - `saving`: The service is in the process of writing settings to disk.
 */
type SettingsServiceState = 'uninitialized' | 'loading' | 'idle' | 'saving';

/**
 * Manages the loading, validation, and saving of all plugin settings.
 * This service acts as the single source of truth for the plugin's configuration state,
 * operating as a formal state machine to ensure data integrity and prevent race conditions.
 */
export class SettingsService {
    private plugin: Plugin;
    private settings: PluginSettings;
    private state: SettingsServiceState = 'uninitialized';

    // --- Service Accessors ---
    private get logger(): Logger { return container.resolve<Logger>(ServiceTokens.Logger); }
    private get eventBus(): EventBus { return container.resolve<EventBus>(ServiceTokens.EventBus); }

    constructor(plugin: Plugin) {
        this.plugin = plugin;
        // Initialize with safe, default settings. The actual settings will be loaded via loadSettings().
        this.settings = this.getDefaultSettings();
    }

    /**
     * Retrieves a deep, immutable copy of the current plugin settings.
     *
     * This method is the primary way for other services to access configuration. It returns a
     * deep copy to enforce immutability, preventing accidental state modification. All changes
     * to settings MUST go through the `saveSettings` method to ensure validation, consistency,
     * and proper event publication. This design eliminates an entire class of state-related bugs.
     *
     * @returns {PluginSettings} A deep copy of the current `PluginSettings`.
     */
    public getSettings(): PluginSettings {
        // Aggressive defense: Ensure settings are never mutated externally.
        return JSON.parse(JSON.stringify(this.settings));
    }

    /**
     * Retrieves the current global log level.
     * A convenience method for frequent access without needing to get the full settings object.
     * @returns {LogLevel} The current `LogLevel`.
     */
    public getGlobalLogLevel(): LogLevel {
        return this.settings?.globalLogLevel || DEFAULT_GLOBAL_LOG_LEVEL;
    }

    /**
     * Loads settings from the disk. This is the primary initialization method for the service.
     * It can only be run once from the `uninitialized` state.
     * @throws {PluginError} if the service is not in the 'uninitialized' state or if loading fails critically.
     */
    public async loadSettings(): Promise<void> {
        if (this.state !== 'uninitialized') {
            this.logger.log('warn', `loadSettings called in an invalid state: '${this.state}'. Operation aborted.`);
            // In a defensive model, we don't throw here, as it might be a harmless duplicate call.
            // We just prevent re-execution.
            return;
        }

        this.state = 'loading';
        this.logger.log('verbose', 'SettingsService state changed to -> loading.');

        try {
            const loadedData = await this.plugin.loadData() as Partial<PluginSettings> | null | undefined;
            
            // Perform a safe merge of loaded data with defaults.
            this.settings = this._mergeWithDefaults(loadedData);

            // Validate and sanitize the loaded projects.
            this._validateAndSanitizeProjects();

            this.state = 'idle';
            this.logger.log('verbose', 'SettingsService state changed to -> idle.');
            
            // Publish the final, validated settings. Send a deep copy in the event payload.
            this.eventBus.publish({ type: 'SETTINGS_CHANGED', payload: { newSettings: this.getSettings() } });
            
            this.logger.log('info', `Settings loaded successfully. Valid projects: ${this.settings.projects.length}.`);
            this.logger.log('verbose', 'Final loaded and validated settings:', this.getSettings());

        } catch (error: unknown) {
            this.state = 'uninitialized'; // Revert to uninitialized to allow a retry.
            this.logger.log('error', 'Critical failure during settings load. Reverting to default settings and uninitialized state.', error);
            this.settings = this.getDefaultSettings(); // Ensure a safe state.
            
            // Publish change to default settings so UI can reset.
            this.eventBus.publish({ type: 'SETTINGS_CHANGED', payload: { newSettings: this.getSettings() } });
            new Notice("FATAL: Could not load In-App Builder settings. Defaults have been applied. Check console for error details.", 10000);
            
            const loadError = error instanceof Error ? error : new Error(String(error));
            throw new PluginError(createChainedMessage('Failed to load settings.', loadError), loadError);
        }
    }

    /**
     * Validates and saves the provided settings object to disk.
     * This is the sole entry point for persisting any settings changes.
     * @param {PluginSettings} settingsToSave The complete `PluginSettings` object to be validated and saved.
     * @throws {PluginError} if the service is not in the 'idle' state (e.g., already saving) or if saving fails.
     */
    public async saveSettings(settingsToSave: PluginSettings): Promise<void> {
        if (this.state !== 'idle') {
            const errorMessage = `saveSettings called while the service is in a non-idle state: '${this.state}'. This may indicate a race condition. Operation aborted.`;
            this.logger.log('error', errorMessage);
            throw new PluginError(errorMessage, undefined, { currentState: this.state });
        }

        this.state = 'saving';
        this.logger.log('verbose', 'SettingsService state changed to -> saving.');

        try {
            // Create a new object for final validation to avoid mutating the input.
            const validatedSettings: PluginSettings = {
                ...this._mergeWithDefaults(settingsToSave), // Ensure all global fields are present
                projects: this._validateAndFilterProjects(settingsToSave.projects || []),
            };

            // Update the internal state *before* writing to disk.
            this.settings = validatedSettings;

            await this.plugin.saveData(this.settings);
            
            // Publish the change *after* a successful save. Send a deep copy.
            this.eventBus.publish({ type: 'SETTINGS_CHANGED', payload: { newSettings: this.getSettings() } });
            
            this.logger.log('info', 'Settings saved successfully.');
            this.logger.log('verbose', 'Data written to disk:', this.getSettings());

        } catch (error: unknown) {
            const saveError = error instanceof Error ? error : new Error(String(error));
            const message = createChainedMessage('Failed to save In-App Builder settings.', saveError);
            this.logger.log('error', message, saveError);
            // The state will be reset to 'idle' in the finally block, allowing for another attempt.
            throw new PluginError(message, saveError, { operation: 'saveSettings' });
        } finally {
            this.state = 'idle';
            this.logger.log('verbose', 'SettingsService state changed to -> idle.');
        }
    }

    /**
     * Creates a deep copy of the default settings object.
     * @returns A fresh `PluginSettings` object with all default values.
     */
    private getDefaultSettings(): PluginSettings {
        // JSON stringify/parse is a robust way to ensure a deep copy,
        // preventing accidental mutation of the constant defaults.
        return JSON.parse(JSON.stringify({
            projects: [],
            globalLogLevel: DEFAULT_GLOBAL_LOG_LEVEL,
            esbuildJsCdnUrl: DEFAULT_ESBUILD_JS_CDN_URL,
            esbuildWasmCdnUrl: DEFAULT_ESBUILD_WASM_CDN_URL,
        }));
    }

    /**
     * Safely merges loaded data with default settings to create a complete `PluginSettings` object.
     * @param loadedData The partial data loaded from disk.
     * @returns A complete `PluginSettings` object.
     */
    private _mergeWithDefaults(loadedData: Partial<PluginSettings> | null | undefined): PluginSettings {
        const defaults = this.getDefaultSettings();
        if (!loadedData) {
            return defaults;
        }
        return {
            ...defaults,
            globalLogLevel: loadedData.globalLogLevel ?? defaults.globalLogLevel,
            esbuildJsCdnUrl: loadedData.esbuildJsCdnUrl ?? defaults.esbuildJsCdnUrl,
            esbuildWasmCdnUrl: loadedData.esbuildWasmCdnUrl ?? defaults.esbuildWasmCdnUrl,
            projects: loadedData.projects ?? [], // Project validation is handled separately
        };
    }

    /**
     * Validates the projects within the current `this.settings` object in-place.
     * Invalid projects are removed, and a notice is displayed if any are discarded.
     * This is used during the `loadSettings` flow.
     */
    private _validateAndSanitizeProjects(): void {
        if (!Array.isArray(this.settings.projects)) {
            this.logger.log('warn', "The 'projects' field in saved data is not an array and has been discarded.");
            this.settings.projects = [];
            return;
        }

        const validatedProjects = this._validateAndFilterProjects(this.settings.projects);
        const discardedCount = this.settings.projects.length - validatedProjects.length;

        if (discardedCount > 0) {
            const fullWarning = `${discardedCount} project configuration(s) were found to be invalid during load and have been discarded. Please review your settings. Check the developer console for detailed reasons.`;
            new Notice(fullWarning, 15000);
        }
        
        this.settings.projects = validatedProjects;
    }

    /**
     * Takes an array of raw project data, validates each item, and returns a new array
     * containing only the valid, fully-formed `ProjectSettings` objects.
     * @param projects The array of projects to validate.
     * @returns A new array with only valid projects.
     */
    private _validateAndFilterProjects(projects: any[]): ProjectSettings[] {
        const allValidationIssues: string[] = [];
        
        const validProjects = projects.map((projectData: any): ProjectSettings | null => {
            const validationIssues: string[] = [];
            
            // Create a preliminary object with all defaults to ensure `isProjectSettingsValid` has a full structure to check.
            const preliminaryProject: Partial<ProjectSettings> = {
                ...this.getDefaultProjectSettings(), // Get a base structure
                ...(projectData || {}), // Overlay loaded data
                buildOptions: { // Deep merge buildOptions
                    ...DEFAULT_PROJECT_BUILD_OPTIONS,
                    ...(projectData?.buildOptions || {}),
                },
            };

            if (isProjectSettingsValid(preliminaryProject, validationIssues)) {
                // Cast to full ProjectSettings, as validation passed.
                return preliminaryProject as ProjectSettings;
            } else {
                const projectName = projectData?.name || 'Unnamed Project';
                const projectId = projectData?.id || 'No ID';
                const summary = getValidationIssuesSummary(validationIssues);
                const warningMsg = `Project (Name: "${projectName}", ID: "${projectId}") is invalid and will be discarded. Reasons:\n${summary}`;
                
                allValidationIssues.push(warningMsg);
                this.logger.log('verbose', `Invalid project data for "${projectName}" (ID: "${projectId}"):`, projectData);
                
                return null;
            }
        }).filter((project): project is ProjectSettings => project !== null);

        if (allValidationIssues.length > 0) {
            this.logger.log('warn', `Summary of all validation issues for discarded projects:\n\n${allValidationIssues.join('\n\n')}`);
        }

        return validProjects;
    }

    /**
     * Helper to get a default structure for a single project.
     */
    private getDefaultProjectSettings(): Omit<ProjectSettings, 'id' | 'name' | 'path' | 'entryPoint' | 'outputFile'> {
        return {
            dependencies: [],
            logLevel: DEFAULT_PROJECT_LOG_LEVEL,
            commandId: null,
            buildOptions: { ...DEFAULT_PROJECT_BUILD_OPTIONS },
        };
    }
}