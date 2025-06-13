/**
 * @file The main entry point for the settings tab UI.
 *       This class acts as an orchestrator, managing the lifecycle and rendering
 *       of individual, modular setting sections.
 */

import { App, PluginSettingTab } from 'obsidian';
import { InAppBuilderPlugin } from '../core/InAppBuilderPlugin';
import { container, ServiceTokens } from '../utils/DIContainer';
import { SettingsService } from '../services/SettingsService';
import { GlobalSettingsSection } from './settings/sections/GlobalSettingsSection';
import { EsbuildStatusSection } from './settings/sections/EsbuildStatusSection';
import { EsbuildConfigSection } from './settings/sections/EsbuildConfigSection';
import { ProjectsSection } from './settings/sections/ProjectsSection';
import { SettingSection } from './settings/SettingSection';

type SettingTabState = 'uninitialized' | 'rendering' | 'active' | 'hiding' | 'hidden' | 'destroyed';

export class InAppBuilderSettingTab extends PluginSettingTab {
    private plugin: InAppBuilderPlugin;
    private get settingsService(): SettingsService { return container.resolve<SettingsService>(ServiceTokens.SettingsService); }

    // --- State Management ---
    private state: SettingTabState = 'uninitialized';
    private sections: SettingSection[] = [];
    private styleEl?: HTMLStyleElement;

    constructor(app: App, plugin: InAppBuilderPlugin) {
        super(app, plugin);
        this.plugin = plugin;
        this.plugin.register(() => this.destroy());

        // Instantiate all the UI sections
        this.sections = [
            new GlobalSettingsSection(app, plugin),
            new EsbuildStatusSection(app, plugin),
            new EsbuildConfigSection(app, plugin),
            new ProjectsSection(app, plugin),
        ];
    }

    // --- Lifecycle Methods ---

    public display(): void {
        if (this.state === 'destroyed') {
            this.plugin.logger.log('warn', `SettingsTab: Ignoring display() - instance destroyed`);
            return;
        }
        if (this.state !== 'uninitialized' && this.state !== 'hidden') {
            this.plugin.logger.log('warn', `SettingsTab: Invalid state transition from ${this.state} to rendering`);
            return;
        }

        this.state = 'rendering';
        this.plugin.logger.log('verbose', `SettingsTab: State → rendering`);

        try {
            const { containerEl } = this;
            containerEl.empty();
            containerEl.addClass('in-app-builder-settings-tab');
            this._injectStyles();

            containerEl.createEl('h2', { text: 'In-App Builder Settings' });

            // Render all sections
            this.sections.forEach(section => section.render(containerEl));

            // Load data into all sections
            const currentSettings = this.settingsService.getSettings();
            this.sections.forEach(section => section.load(currentSettings));

            this.state = 'active';
            this.plugin.logger.log('verbose', `SettingsTab: State → active`);
        } catch (error) {
            this.plugin.logger.log('error', 'Critical error in display()', error);
            this._emergencyCleanup();
            this.containerEl.createEl('h3', { text: '⚡ Critical Error ⚡' });
            this.containerEl.createEl('p', { text: 'Settings tab failed to initialize. Please reload Obsidian and report this issue.' });
        }
    }

    public hide(): void {
        if (this.state !== 'active') {
            this.plugin.logger.log('verbose', `SettingsTab: Ignoring hide() in state ${this.state}`);
            return;
        }

        this.state = 'hiding';
        this.plugin.logger.log('verbose', `SettingsTab: State → hiding`);
        this.sections.forEach(section => section.unload());
        this.state = 'hidden';
        this.plugin.logger.log('verbose', `SettingsTab: State → hidden`);
    }

    public destroy(): void {
        if (this.state === 'destroyed') return;
        this.plugin.logger.log('verbose', `SettingsTab: Destroy initiated from state ${this.state}`);
        
        this.hide(); // Ensure unload logic is called
        this._removeStyles();
        this.containerEl.empty();
        this.sections = [];
        this.plugin = null as any;

        this.state = 'destroyed';
        this.plugin.logger.log('verbose', `SettingsTab: State → destroyed`);
    }

    // --- Private Helper Methods ---

    private _emergencyCleanup(): void {
        try {
            this.sections.forEach(section => section.unload());
            this._removeStyles();
            this.containerEl.empty();
        } catch (e) {
            console.error('Emergency cleanup failed:', e);
        }
        this.state = 'hidden';
    }

    private _injectStyles(): void {
        if (this.styleEl) return;
        const styleId = 'in-app-builder-ui-styles';
        this.styleEl = document.createElement('style');
        this.styleEl.id = styleId;
        document.head.appendChild(this.styleEl);
        this.styleEl.textContent = `
            .in-app-builder-settings-section { margin-bottom: 30px; padding-bottom: 15px; border-bottom: 1px solid var(--background-modifier-border); }
            .in-app-builder-settings-section:last-child { border-bottom: none; }
            .in-app-builder-status-text { margin-right: 10px; }
            .status-ok { color: var(--text-success); }
            .status-error { color: var(--text-error); }
            .status-progress { color: var(--text-accent); }
            .modal-button-container { display: flex; justify-content: flex-end; gap: 10px; margin-top: 20px; }
            .project-item { position: relative; }
            .project-actions { position: absolute; right: 0; top: 50%; transform: translateY(-50%); display: flex; gap: 4px; }
        `;
    }

    private _removeStyles(): void {
        if (this.styleEl?.isConnected) {
            document.head.removeChild(this.styleEl);
        }
        this.styleEl = undefined;
    }
}
