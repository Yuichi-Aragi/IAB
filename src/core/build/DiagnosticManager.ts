import { InAppBuilderPlugin } from '../InAppBuilderPlugin';
import { ProjectSettings, BuildInitiator } from '../../types';
import { BuildDiagnostics } from './BuildContext';
import { SettingsService } from '../../services/SettingsService';
import { container, ServiceTokens } from '../../utils/DIContainer';

export class DiagnosticManager {
    private plugin: InAppBuilderPlugin;
    private get settingsService(): SettingsService { return container.resolve<SettingsService>(ServiceTokens.SettingsService); }

    constructor(plugin: InAppBuilderPlugin) {
        this.plugin = plugin;
    }

    public createInitialDiagnostics(project: ProjectSettings, initiator: BuildInitiator): BuildDiagnostics {
        const globalSettings = this.settingsService.getSettings();
        const appWithVersion = this.plugin.app as any;
        const obsidianVersion = appWithVersion.appId && appWithVersion.appVersion 
            ? `${appWithVersion.appId} ${appWithVersion.appVersion}` 
            : appWithVersion.version || 'Unknown';

        const isUsingHashFallback = typeof window === 'undefined' || !window.crypto?.subtle;

        return {
            projectName: project.name,
            projectId: project.id,
            initiator,
            pluginVersion: this.plugin.manifest.version,
            obsidianVersion: obsidianVersion,
            timestamp: new Date().toISOString(),
            projectSettings: JSON.parse(JSON.stringify(project)),
            globalSettings: {
                globalLogLevel: globalSettings.globalLogLevel,
            },
            hashingMethod: isUsingHashFallback ? 'FNV-1a (fallback)' : 'SHA-256',
            projectFileAssets: {},
            cdnModuleNameToUrl: {},
            resolutionLogs: [],
            esbuildOutput: { errors: [], warnings: [] },
            finalError: null,
        };
    }

    public formatFinalDiagnosticString(diagnostics: BuildDiagnostics): string {
        let output = `--- In-App Builder - Build Diagnostic Report ---\n`;
        output += `Plugin Version: ${diagnostics.pluginVersion}\n`;
        output += `Obsidian Version: ${diagnostics.obsidianVersion}\n`;
        output += `Timestamp: ${diagnostics.timestamp}\n`;
        output += `Project Name: ${diagnostics.projectName}\n`;
        output += `Project ID: ${diagnostics.projectId}\n\n`;

        output += this._formatSettingsForReport(diagnostics);
        output += this._formatFileHashesForReport(diagnostics);
        output += this._formatErrorsForReport(diagnostics);

        output += `\n--- End of Report ---`;
        return output;
    }

    private _formatSettingsForReport(diagnostics: BuildDiagnostics): string {
        let output = `--- Project Settings ---\n`;
        try {
            const settingsToLog = {...diagnostics.projectSettings};
            if (settingsToLog.buildOptions) delete (settingsToLog.buildOptions as any).plugins; 
            output += JSON.stringify(settingsToLog, null, 2) + "\n\n";
        } catch (e) {
            output += "Error stringifying project settings for report.\n\n";
        }
        
        output += `--- Global Settings (Relevant) ---\n`;
        output += JSON.stringify(diagnostics.globalSettings, null, 2) + "\n\n";
        return output;
    }

    private _formatFileHashesForReport(diagnostics: BuildDiagnostics): string {
        let output = `--- File Hashes (Initial Read) ---\n`;
        output += `Hashing Method Used: ${diagnostics.hashingMethod}\n`;
        for (const path in diagnostics.projectFileAssets) {
            const asset = diagnostics.projectFileAssets[path];
            if (asset.fileReadError) {
                output += `${path}: READ ERROR - ${asset.fileReadError.message.split('\n')[0]}\n`;
            } else {
                output += `${path}: ${asset.initialHash}\n`;
            }
        }
        return output + "\n";
    }

    private _formatErrorsForReport(diagnostics: BuildDiagnostics): string {
        let output = `--- Error Details & Logs ---\n`;
        if (diagnostics.esbuildOutput.errors.length > 0) {
            output += "--- Esbuild Errors ---\n" + diagnostics.esbuildOutput.errors.join('\n\n') + '\n\n';
        }
        if (diagnostics.esbuildOutput.warnings.length > 0) {
            output += "--- Esbuild Warnings ---\n" + diagnostics.esbuildOutput.warnings.join('\n\n') + '\n\n';
        }
        if (diagnostics.resolutionLogs.length > 0) {
            output += "--- Plugin Resolution Logs ---\n" + diagnostics.resolutionLogs.join('\n') + '\n\n';
        }
        if (diagnostics.finalError) {
            output += `--- Overall Build Failure ---\n`;
            output += `Error: ${diagnostics.finalError.message}\n`;
            if (diagnostics.finalError.context) output += `Context: ${JSON.stringify(diagnostics.finalError.context, null, 2)}\n`;
            if (diagnostics.finalError.stack) output += `Stack: ${diagnostics.finalError.stack}\n`;
            if (diagnostics.finalError.cause) output += `Cause: ${diagnostics.finalError.cause}\n`;
        }
        return output;
    }
}
