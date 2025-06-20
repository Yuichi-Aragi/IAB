/**
 * @file Renders and manages the "esbuild Library Configuration" section of the settings tab.
 */

import { Setting, TextComponent } from 'obsidian';
import { SettingSection } from '../SettingSection';
import { PluginSettings } from '../../../types';
import { DEFAULT_ESBUILD_JS_CDN_URL, DEFAULT_ESBUILD_WASM_CDN_URL } from '../../../constants';

export class EsbuildConfigSection extends SettingSection {
    private esbuildJsCdnUrlInput?: TextComponent;
    private esbuildWasmCdnUrlInput?: TextComponent;
    private isLoading = false;

    public render(containerEl: HTMLElement): void {
        const details = containerEl.createEl('details', { cls: 'in-app-builder-settings-section' });
        details.createEl('summary', { text: 'esbuild Library Configuration' });
        
        details.createEl('p', {
            text: 'Configure the CDN URLs from which to fetch the esbuild library. The plugin will always fetch these assets on startup or when re-initialized.',
            cls: 'setting-item-description'
        });

        this.esbuildJsCdnUrlInput = this._createEsbuildUrlSetting(
            details, 'esbuild.min.js CDN URL', 'URL for main esbuild JavaScript file',
            DEFAULT_ESBUILD_JS_CDN_URL, 'esbuildJsCdnUrl'
        );

        this.esbuildWasmCdnUrlInput = this._createEsbuildUrlSetting(
            details, 'esbuild.wasm CDN URL', 'URL for esbuild WebAssembly file',
            DEFAULT_ESBUILD_WASM_CDN_URL, 'esbuildWasmCdnUrl'
        );
    }

    public load(settings: PluginSettings): void {
        this.isLoading = true;
        try {
            this.esbuildJsCdnUrlInput?.setValue(settings.esbuildJsCdnUrl);
            this.esbuildWasmCdnUrlInput?.setValue(settings.esbuildWasmCdnUrl);
        } finally {
            this.isLoading = false;
        }
    }

    private _createEsbuildUrlSetting(
        containerEl: HTMLElement, name: string, desc: string, placeholder: string,
        valueKey: 'esbuildJsCdnUrl' | 'esbuildWasmCdnUrl'
    ): TextComponent {
        let textComponent: TextComponent;
        new Setting(containerEl)
            .setName(name).setDesc(desc)
            .addText(text => {
                textComponent = text;
                text.setPlaceholder(placeholder)
                    .onChange(async (value: string) => {
                        if (this.isLoading) return;
                        await this._saveGlobalSetting(valueKey, value.trim());
                    });
            });
        return textComponent!;
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