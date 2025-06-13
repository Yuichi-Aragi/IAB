/**
 * @file Manages the lifecycle of build projects (add, update, remove).
 *       This service operates as a formal state machine to ensure data consistency and prevent race conditions.
 *       It acts as the single source of truth for project-related write operations,
 *       enforcing validation and immutability principles.
 * 
 * Revised Implementation: Enhanced with strict state transitions, operation queuing, resource management,
 * and aggressive defensive programming to eliminate entire classes of potential issues.
 */

import { ProjectSettings, NewProjectSettings, BuildOptions } from '../types';
import { SettingsService } from '../services/SettingsService';
import { Logger } from '../utils/Logger';
import { generateProjectId } from '../utils/IdGenerator';
import { isProjectSettingsValid, getValidationIssuesSummary } from '../utils/ValidationUtils';
import { ProjectValidationError, PluginError, createChainedMessage } from '../errors/CustomErrors';
import { DEFAULT_PROJECT_BUILD_OPTIONS, DEFAULT_PROJECT_LOG_LEVEL } from '../constants';
import { container, ServiceTokens } from '../utils/DIContainer';

/**
 * Defines the possible states of the ProjectManager with strict transitions:
 * - `IDLE`: Ready for new operations
 * - `PROCESSING`: Actively executing an operation
 * - `DRAINING`: Completing current operation before shutdown
 * - `ERROR`: Unrecoverable state requiring restart
 */
const ProjectManagerState = {
    IDLE: 'idle',
    PROCESSING: 'processing',
    DRAINING: 'draining',
    ERROR: 'error',
} as const;
type ProjectManagerState = typeof ProjectManagerState[keyof typeof ProjectManagerState];

/**
 * Operation timeout constants (in milliseconds)
 */
const OPERATION_TIMEOUT = 30000;
const SHUTDOWN_TIMEOUT = 10000;

interface Operation<T> {
    execute: () => Promise<T>;
    cancelToken: AbortController;
    cleanup?: () => void;
}

export class ProjectManager {
    private get settingsService(): SettingsService { 
        return container.resolve<SettingsService>(ServiceTokens.SettingsService); 
    }
    private get logger(): Logger { 
        return container.resolve<Logger>(ServiceTokens.Logger); 
    }

    private state: ProjectManagerState = ProjectManagerState.IDLE;
    private operationQueue: Operation<any>[] = [];
    private activeOperation: Operation<any> | null = null;
    private shutdownController: AbortController | null = null;
    private resourceRegistry = new FinalizationRegistry((heldValue: string) => {
        this.logger.log('warn', `Resource was not cleaned up properly: ${heldValue}`);
    });

    constructor() {
        // The state is initialized to IDLE. No transition validation is needed here.
    }

    // --- PUBLIC API ---

    public async shutdown(): Promise<void> {
        this._validateStateTransition(ProjectManagerState.DRAINING);
        this.state = ProjectManagerState.DRAINING;
        this.shutdownController = new AbortController();
        
        const shutdownTimer = setTimeout(() => {
            this.logger.log('error', 'Forced shutdown after timeout');
            this._transitionToErrorState(new PluginError('Shutdown timeout exceeded'));
        }, SHUTDOWN_TIMEOUT);

        try {
            // Process remaining operations
            while (this.operationQueue.length > 0) {
                const op = this.operationQueue.shift()!;
                op.cancelToken.abort();
                op.cleanup?.();
            }

            // Wait for active operation to complete
            if (this.activeOperation) {
                await new Promise<void>((resolve) => {
                    const checkActive = () => {
                        if (!this.activeOperation) resolve();
                        else setTimeout(checkActive, 10);
                    };
                    checkActive();
                });
            }
        } finally {
            clearTimeout(shutdownTimer);
            this.state = ProjectManagerState.IDLE;
            this.shutdownController = null;
        }
    }

    public getAllProjects(): ProjectSettings[] {
        this._preReadCheck();
        const projects = this.settingsService.getSettings().projects;
        return this._deepClone(projects);
    }

    public getProjectById(projectId: string): ProjectSettings | undefined {
        this._preReadCheck();
        const project = this.settingsService.getSettings().projects.find(p => p.id === projectId);
        return project ? this._deepClone(project) : undefined;
    }

    public async addProject(newProjectData: NewProjectSettings): Promise<ProjectSettings> {
        return this._enqueueOperation({
            name: 'addProject',
            payload: newProjectData,
            execute: () => this._addProjectInternal(newProjectData)
        });
    }

    public async updateProject(updatedProject: ProjectSettings): Promise<void> {
        return this._enqueueOperation({
            name: 'updateProject',
            payload: updatedProject,
            execute: () => this._updateProjectInternal(updatedProject)
        });
    }

    public async removeProject(projectId: string): Promise<void> {
        return this._enqueueOperation({
            name: 'removeProject',
            payload: projectId,
            execute: () => this._removeProjectInternal(projectId)
        });
    }

    // --- PRIVATE OPERATION IMPLEMENTATIONS ---

    private async _addProjectInternal(newProjectData: NewProjectSettings): Promise<ProjectSettings> {
        const currentSettings = this.settingsService.getSettings();
        const projects = currentSettings.projects;

        // Validate name uniqueness
        const normalizedNewName = newProjectData.name.trim().toLowerCase();
        if (projects.some(p => p.name.trim().toLowerCase() === normalizedNewName)) {
            throw new ProjectValidationError(`Project "${newProjectData.name}" already exists`);
        }

        // Merge build options
        const completeBuildOptions = this._deepMergeBuildOptions(
            DEFAULT_PROJECT_BUILD_OPTIONS,
            newProjectData.buildOptions || {}
        );

        const newProject: ProjectSettings = {
            id: generateProjectId(),
            name: newProjectData.name.trim(),
            path: newProjectData.path.trim(),
            entryPoint: newProjectData.entryPoint.trim(),
            outputFile: newProjectData.outputFile.trim(),
            dependencies: newProjectData.dependencies || [],
            logLevel: newProjectData.logLevel || DEFAULT_PROJECT_LOG_LEVEL,
            commandId: null,
            buildOptions: completeBuildOptions,
        };

        // Validate project structure
        const validationIssues: string[] = [];
        if (!isProjectSettingsValid(newProject, validationIssues)) {
            const summary = getValidationIssuesSummary(validationIssues);
            throw new ProjectValidationError(`Invalid project configuration: ${summary}`);
        }

        // Create and save new settings
        const newSettings = {
            ...currentSettings,
            projects: [...projects, newProject],
        };

        await this._saveAndLog(newSettings, `Project added: ${newProject.name}`);
        return this._deepClone(newProject);
    }

    private async _updateProjectInternal(updatedProject: ProjectSettings): Promise<void> {
        const currentSettings = this.settingsService.getSettings();
        const projects = currentSettings.projects;
        const projectIndex = projects.findIndex(p => p.id === updatedProject.id);

        if (projectIndex === -1) {
            throw new ProjectValidationError(`Project not found: ${updatedProject.id}`);
        }

        // Validate name uniqueness
        const normalizedNewName = updatedProject.name.trim().toLowerCase();
        if (projects.some((p, index) => 
            index !== projectIndex && p.name.trim().toLowerCase() === normalizedNewName)) {
            throw new ProjectValidationError(`Project name conflict: ${updatedProject.name}`);
        }

        // Merge build options
        const completeBuildOptions = this._deepMergeBuildOptions(
            DEFAULT_PROJECT_BUILD_OPTIONS,
            updatedProject.buildOptions || {}
        );
        
        // Preserve commandId
        const validatedProject: ProjectSettings = {
            ...updatedProject,
            name: updatedProject.name.trim(),
            path: updatedProject.path.trim(),
            entryPoint: updatedProject.entryPoint.trim(),
            outputFile: updatedProject.outputFile.trim(),
            logLevel: updatedProject.logLevel || DEFAULT_PROJECT_LOG_LEVEL,
            buildOptions: completeBuildOptions,
            dependencies: updatedProject.dependencies || [],
            commandId: projects[projectIndex].commandId,
        };

        // Validate project structure
        const validationIssues: string[] = [];
        if (!isProjectSettingsValid(validatedProject, validationIssues)) {
            const summary = getValidationIssuesSummary(validationIssues);
            throw new ProjectValidationError(`Invalid project update: ${summary}`);
        }

        // Update and save settings
        const newProjects = [...projects];
        newProjects[projectIndex] = validatedProject;
        const newSettings = { ...currentSettings, projects: newProjects };

        await this._saveAndLog(newSettings, `Project updated: ${validatedProject.name}`);
    }

    private async _removeProjectInternal(projectId: string): Promise<void> {
        const currentSettings = this.settingsService.getSettings();
        const projects = currentSettings.projects;
        const projectIndex = projects.findIndex(p => p.id === projectId);

        if (projectIndex === -1) {
            this.logger.log('warn', `Remove ignored: Project not found (${projectId})`);
            return;
        }

        const projectName = projects[projectIndex].name;
        const newProjects = projects.filter(p => p.id !== projectId);
        const newSettings = { ...currentSettings, projects: newProjects };

        await this._saveAndLog(newSettings, `Project removed: ${projectName}`);
    }

    // --- CORE OPERATION MANAGEMENT ---

    private async _enqueueOperation<T>(operation: {
        name: string;
        payload: any;
        execute: () => Promise<T>;
    }): Promise<T> {
        if (this.state === ProjectManagerState.ERROR) {
            throw new PluginError('Manager in error state');
        }
        if (this.state === ProjectManagerState.DRAINING) {
            throw new PluginError('Manager is shutting down');
        }

        const cancelToken = new AbortController();
        const operationEntry: Operation<T> = {
            execute: operation.execute,
            cancelToken,
            cleanup: () => {
                cancelToken.abort();
                this.resourceRegistry.unregister(operationEntry);
            }
        };

        this.resourceRegistry.register(
            operationEntry, 
            `Operation:${operation.name}:${Date.now()}`
        );

        return new Promise<T>((resolve, reject) => {
            this.operationQueue.push({
                ...operationEntry,
                execute: async () => {
                    try {
                        const result = await operation.execute();
                        resolve(result);
                        return result;
                    } catch (error) {
                        reject(error);
                        throw error;
                    }
                }
            });

            this._processQueue().catch(reject);
        });
    }

    private async _processQueue(): Promise<void> {
        if (this.state !== ProjectManagerState.IDLE || this.activeOperation) return;
        if (this.operationQueue.length === 0) return;

        this._validateStateTransition(ProjectManagerState.PROCESSING);
        this.state = ProjectManagerState.PROCESSING;
        this.activeOperation = this.operationQueue.shift()!;

        try {
            const timeout = setTimeout(() => {
                this.activeOperation?.cancelToken.abort();
                this._transitionToErrorState(
                    new PluginError(`Operation timed out after ${OPERATION_TIMEOUT}ms`)
                );
            }, OPERATION_TIMEOUT);

            await this.activeOperation.execute();
            clearTimeout(timeout);
        } catch (error) {
            if (error.name === 'AbortError') {
                this.logger.log('warn', 'Operation aborted');
            } else {
                this.logger.log('error', 'Operation failed', error);
                if (!(error instanceof PluginError)) {
                    this._transitionToErrorState(
                        new PluginError('Unhandled operation error', error)
                    );
                }
            }
            throw error;
        } finally {
            this.activeOperation?.cleanup?.();
            this.activeOperation = null;
            this.state = ProjectManagerState.IDLE;
            if (this.operationQueue.length > 0) {
                setImmediate(() => this._processQueue());
            }
        }
    }

    // --- RESOURCE MANAGEMENT ---

    private _deepClone<T>(obj: T): T {
        if (typeof structuredClone === 'function') {
            return structuredClone(obj);
        }
        // Fallback for environments without structuredClone
        try {
            return JSON.parse(JSON.stringify(obj));
        } catch (e) {
            this.logger.log('error', 'Deep clone failed', e);
            throw new PluginError('Data serialization error');
        }
    }

    private _deepMergeBuildOptions(
        defaults: BuildOptions, 
        overrides: Partial<BuildOptions>
    ): BuildOptions {
        const output: BuildOptions = { ...defaults };

        (Object.keys(overrides) as Array<keyof BuildOptions>).forEach(key => {
            const overrideValue = overrides[key];
            if (overrideValue === undefined) return;

            if (key === 'define' || key === 'loader') {
                output[key] = { ...defaults[key], ...overrideValue as any };
            } else {
                output[key] = overrideValue as any;
            }
        });

        return output;
    }

    // --- STATE MANAGEMENT ---

    private _validateStateTransition(newState: ProjectManagerState): void {
        const validTransitions: Record<ProjectManagerState, ProjectManagerState[]> = {
            [ProjectManagerState.IDLE]: [
                ProjectManagerState.PROCESSING, 
                ProjectManagerState.DRAINING,
                ProjectManagerState.ERROR
            ],
            [ProjectManagerState.PROCESSING]: [
                ProjectManagerState.IDLE, 
                ProjectManagerState.ERROR
            ],
            [ProjectManagerState.DRAINING]: [
                ProjectManagerState.IDLE,
                ProjectManagerState.ERROR
            ],
            [ProjectManagerState.ERROR]: [] // No transitions out of ERROR
        };

        if (!validTransitions[this.state].includes(newState)) {
            throw new PluginError(`Invalid state transition: ${this.state} -> ${newState}`);
        }
    }

    private _transitionToErrorState(error: PluginError): void {
        this.state = ProjectManagerState.ERROR;
        this.logger.log('error', 'Fatal state transition', error);
        
        // Cleanup resources
        this.activeOperation?.cancelToken.abort();
        this.activeOperation?.cleanup?.();
        this.activeOperation = null;
        
        this.operationQueue.forEach(op => {
            op.cancelToken.abort();
            op.cleanup?.();
        });
        this.operationQueue = [];
    }

    // --- SAFETY CHECKS ---

    private _preReadCheck(): void {
        if (this.state === ProjectManagerState.ERROR) {
            throw new PluginError('Cannot read in error state');
        }
        if (this.state === ProjectManagerState.DRAINING) {
            this.logger.log('warn', 'Reading during shutdown state');
        }
    }

    private async _saveAndLog(settings: any, successMessage: string): Promise<void> {
        try {
            await this.settingsService.saveSettings(settings);
            this.logger.log('info', successMessage);
        } catch (error) {
            const err = error instanceof Error ? error : new Error(String(error));
            const wrapped = new PluginError('Save operation failed', err);
            this.logger.log('error', 'Settings save failed', wrapped);
            throw wrapped;
        }
    }
}
