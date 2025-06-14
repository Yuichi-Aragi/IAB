/**
 * @file Renders and manages the "Global Configuration" section of the settings tab.
 */

import { Setting, DropdownComponent } from 'obsidian';
import { SettingSection } from '../SettingSection';
import { LogLevel, PluginSettings } from '../../../types';

export class GlobalSettingsSection extends SettingSection {
    private globalLogLevelDropdown?: DropdownComponent;

    public render(containerEl: HTMLElement): void {
        const globalSection = containerEl.createDiv({ cls: 'in-app-builder-settings-section' });
        new Setting(globalSection).setName('Global configuration').setHeading();

        new Setting(globalSection)
            .setName('Global log level')
            .addDropdown(dd => {
                this.globalLogLevelDropdown = dd;
                dd.addOption('error', 'Error')
                  .addOption('warn', 'Warning')
                  .addOption('info', 'Info (Default)')
                  .addOption('verbose', 'Verbose (Debug)')
                  .addOption('silent', 'Silent')
                  .onChange((value: string) => this._saveGlobalSetting('globalLogLevel', value as LogLevel));
            });
    }

    public load(settings: PluginSettings): void {
        this.globalLogLevelDropdown?.setValue(settings.globalLogLevel);
    }

    private async _saveGlobalSetting<K extends keyof PluginSettings>(key: K, value: PluginSettings[K]): Promise<void> {
        try {
            const current = this.settingsService.getSettings();
            const updated = { ...current, [key]: value };
            await this._safeCommandDispatch('SAVE_SETTINGS', { settings: updated });
        } catch (e) {
            this.logger.log('error', `Save failed for global setting ${key}`, e);
        }
    }
}