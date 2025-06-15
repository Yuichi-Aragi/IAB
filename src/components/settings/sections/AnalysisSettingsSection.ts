import { Setting, SliderComponent, ToggleComponent } from 'obsidian';
import { SettingSection } from '../SettingSection';
import { PluginSettings } from '../../../types';
import { DEFAULT_REAL_TIME_ANALYSIS_ENABLED, DEFAULT_REAL_TIME_ANALYSIS_UPDATE_SPEED } from '../../../constants';

export class AnalysisSettingsSection extends SettingSection {
    private updateSpeedSetting?: Setting;
    private enableToggle?: ToggleComponent;
    private speedSlider?: SliderComponent;
    private isLoading = false;

    public render(containerEl: HTMLElement): void {
        const details = containerEl.createEl('details', { cls: 'in-app-builder-settings-section' });
        details.createEl('summary', { text: 'Real-time Analysis' });

        new Setting(details)
            .setName('Enable analysis view')
            .setDesc('Adds a sidebar view for detailed, real-time build logs. Requires restart or manual toggle if changed.')
            .addToggle((toggle: ToggleComponent) => {
                this.enableToggle = toggle;
                toggle.onChange(async (value: boolean) => {
                    if (this.isLoading) return;
                    this.updateSpeedSetting?.settingEl.toggle(value);
                    await this._saveGlobalSetting('realTimeAnalysisEnabled', value);
                });
            });

        this.updateSpeedSetting = new Setting(details)
            .setName('Analysis UI update speed')
            .setDesc('Delay in milliseconds between log updates in the view. Higher values may improve performance on slower machines.')
            .addSlider((slider: SliderComponent) => {
                this.speedSlider = slider;
                slider.setLimits(10, 500, 10)
                      .setDynamicTooltip()
                      .onChange(async (value) => {
                          if (this.isLoading) return;
                          await this._saveGlobalSetting('realTimeAnalysisUpdateSpeed', value);
                      });
            });
    }

    public load(settings: PluginSettings): void {
        this.isLoading = true;
        try {
            const enabled = settings.realTimeAnalysisEnabled ?? DEFAULT_REAL_TIME_ANALYSIS_ENABLED;
            this.enableToggle?.setValue(enabled);
            this.speedSlider?.setValue(settings.realTimeAnalysisUpdateSpeed ?? DEFAULT_REAL_TIME_ANALYSIS_UPDATE_SPEED);
            this.updateSpeedSetting?.settingEl.toggle(enabled);
        } finally {
            this.isLoading = false;
        }
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