import { Notice } from 'obsidian';
import { ProjectSettings, BuildInitiator, LogLevel } from '../../types';
import { BuildCancelledError, FileSystemError } from '../../errors/CustomErrors';
import { EventBus } from '../../services/EventBus';

// --- Types for State and Diagnostics ---

export type BuildStatus = 'preparing' | 'compiling' | 'writing';

export interface ProjectFileAsset {
    content: string;
    initialHash: string;
    path: string;
    fileReadError?: FileSystemError;
}

export interface BuildDiagnostics {
    projectName: string;
    projectId: string;
    initiator: BuildInitiator;
    pluginVersion: string;
    obsidianVersion: string;
    timestamp: string;
    projectSettings: ProjectSettings;
    globalSettings: {
        globalLogLevel: LogLevel;
        esbuildJsCdnUrl: string;
        esbuildWasmCdnUrl: string;
    };
    hashingMethod: 'SHA-256' | 'FNV-1a (fallback)';
    projectFileAssets: Record<string, ProjectFileAsset>;
    cdnModuleNameToUrl: Record<string, string>;
    resolutionLogs: string[];
    esbuildOutput: {
        errors: string[];
        warnings: string[];
    };
    finalError: {
        message: string;
        stack?: string;
        context?: Record<string, any>;
        cause?: string;
    } | null;
}

/**
 * A simple cancellation token to allow for aborting async operations.
 */
export class CancellationToken {
    private _isCancelled = false;
    public get isCancelled(): boolean { return this._isCancelled; }
    public cancel(): void { this._isCancelled = true; }
    public throwIfCancelled(): void {
        if (this.isCancelled) {
            throw new BuildCancelledError();
        }
    }
}

/**
 * Encapsulates all state and context for a single build process.
 * An instance of this class is created for each build and passed through the pipeline.
 */
export class BuildContext {
    public readonly projectId: string;
    public readonly initiator: BuildInitiator;
    public readonly startTime: number;
    public readonly cancellationToken: CancellationToken;
    public readonly diagnostics: BuildDiagnostics;
    public readonly projectFileAssets: Record<string, ProjectFileAsset> = {};
    public readonly externalDependenciesContent: Map<string, string> = new Map();
    
    private status: BuildStatus = 'preparing';
    private eventBus: EventBus;

    constructor(project: ProjectSettings, initiator: BuildInitiator, initialDiagnostics: BuildDiagnostics, eventBus: EventBus) {
        this.projectId = project.id;
        this.initiator = initiator;
        this.startTime = Date.now();
        this.cancellationToken = new CancellationToken();
        this.diagnostics = initialDiagnostics;
        this.eventBus = eventBus;
    }

    public getStatus(): BuildStatus {
        return this.status;
    }

    public setStatus(status: BuildStatus): void {
        this.status = status;
    }

    public updateProgress(progress: number, message: string): void {
        this.eventBus.publish({ type: 'BUILD_PROGRESS', payload: { projectId: this.projectId, progress, message, initiator: this.initiator } });
        if (this.initiator === 'settings-tab' && (progress === 5 || progress === 55 || progress === 65 || progress === 95)) {
            new Notice(`[${this.diagnostics.projectName}] ${message}`, 2500);
        }
    }

    /**
     * Publishes a detailed log event for the real-time analysis view.
     * @param level The severity level of the log.
     * @param message The primary log message.
     * @param details Optional structured data for detailed inspection.
     */
    public logAnalysis(level: LogLevel, message: string, details?: unknown): void {
        this.eventBus.publish({
            type: 'ANALYSIS_LOG',
            payload: {
                projectId: this.projectId,
                level,
                timestamp: new Date().toISOString(),
                message,
                details,
            }
        });
    }
}