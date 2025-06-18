/**
 * @file The main entry point for the settings tab UI.
 *       This class acts as an orchestrator, managing the lifecycle and rendering
 *       of individual, modular setting sections.
 */

import { App, PluginSettingTab, Setting } from 'obsidian';
import { InAppBuilderPlugin } from '../core/InAppBuilderPlugin';
import { container, ServiceTokens } from '../utils/DIContainer';
import { SettingsService } from '../services/SettingsService';
import { GlobalSettingsSection } from './settings/sections/GlobalSettingsSection';
import { EsbuildStatusSection } from './settings/sections/EsbuildStatusSection';
import { ProjectsSection } from './settings/sections/ProjectsSection';
import { SettingSection } from './settings/SettingSection';
import { AnalysisSettingsSection } from './settings/sections/AnalysisSettingsSection';

type SettingTabState = 'uninitialized' | 'rendering' | 'active' | 'hiding' | 'hidden' | 'destroyed';

export class InAppBuilderSettingTab extends PluginSettingTab {
    private plugin: InAppBuilderPlugin;
    private get settingsService(): SettingsService { return container.resolve<SettingsService>(ServiceTokens.SettingsService); }

    // --- State Management ---
    private state: SettingTabState = 'uninitialized';
    private sections: SettingSection[] = [];

    constructor(app: App, plugin: InAppBuilderPlugin) {
        super(app, plugin);
        this.plugin = plugin;
        this.plugin.register(() => this.destroy());

        // Instantiate all the UI sections
        this.sections = [
            new GlobalSettingsSection(app, plugin),
            new AnalysisSettingsSection(app, plugin),
            new EsbuildStatusSection(app, plugin),
            new ProjectsSection(app, plugin),
        ];
    }

    // --- Lifecycle Methods ---

    public display(): void {
        if (this.state === 'destroyed') {
            // It's possible for the logger to be unavailable if the plugin was nulled out.
            // Use a direct console log as a safe fallback.
            (this.plugin?.logger || console).log('warn', `SettingsTab: Ignoring display() - instance destroyed`);
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

            new Setting(containerEl).setName('In-app builder settings').setHeading();

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
            // During destroy, plugin might be null.
            (this.plugin?.logger || console).log('verbose', `SettingsTab: Ignoring hide() in state ${this.state}`);
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
        
        // It's possible for the plugin to be unloaded before the settings tab is fully destroyed,
        // especially during rapid reloads. Caching the logger is a robust pattern.
        const logger = this.plugin?.logger;

        (logger || console).log('verbose', `SettingsTab: Destroy initiated from state ${this.state}`);
        
        this.hide(); // Ensure unload logic is called
        this.containerEl.empty();
        this.sections = [];

        this.state = 'destroyed';
        (logger || console).log('verbose', `SettingsTab: State → destroyed`);

        // Nullify references at the very end to prevent use-after-free errors
        // and to help with garbage collection.
        this.plugin = null as any;
    }

    // --- Private Helper Methods ---

    private _emergencyCleanup(): void {
        try {
            this.sections.forEach(section => section.unload());
            this.containerEl.empty();
        } catch (e) {
            console.error('Emergency cleanup failed:', e);
        }
        this.state = 'hidden';
    }
}
