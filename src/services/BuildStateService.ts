/**
 * @file Manages state related to build processes, such as diagnostic information.
 *       This service decouples build state from the main plugin class and the build service.
 */

import { Logger } from '../utils/Logger';
import { container, ServiceTokens } from '../utils/DIContainer';

export class BuildStateService {
    private readonly logger: Logger;
    private lastBuildDiagnostics: Map<string, string> = new Map();

    constructor() {
        // Resolve logger immediately. This is safe due to the new initialization order.
        this.logger = container.resolve<Logger>(ServiceTokens.Logger);
    }

    /**
     * Stores diagnostic information for a failed build.
     * @param projectId The ID of the project.
     * @param diagnosticInfo The detailed diagnostic string.
     */
    public set(projectId: string, diagnosticInfo: string): void {
        this.lastBuildDiagnostics.set(projectId, diagnosticInfo);
        this.logger.log('verbose', `[BuildStateService] Stored diagnostic info for project ID: ${projectId}`);
    }

    /**
     * Retrieves the last stored diagnostic information for a project.
     * @param projectId The ID of the project.
     * @returns The diagnostic string, or null if none exists.
     */
    public get(projectId: string): string | null {
        return this.lastBuildDiagnostics.get(projectId) || null;
    }

    /**
     * Clears any stored diagnostic information for a project.
     * @param projectId The ID of the project.
     */
    public clear(projectId: string): void {
        if (this.lastBuildDiagnostics.has(projectId)) {
            this.lastBuildDiagnostics.delete(projectId);
            this.logger.log('verbose', `[BuildStateService] Cleared diagnostic info for project ID: ${projectId}`);
        }
    }

    /**
     * Clears all stored diagnostics. Called on plugin unload.
     */
    public unload(): void {
        this.lastBuildDiagnostics.clear();
        this.logger.log('info', '[BuildStateService] Unloaded and cleared all diagnostics.');
    }
}