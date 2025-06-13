/**
 * @file Renders and manages the "esbuild Library Configuration" section of the settings tab.
 */

import { Setting, ButtonComponent, ToggleComponent, TextComponent, Modal } from 'obsidian';
import { SettingSection } from '../SettingSection';
import { PluginSettings } from '../../../types';
import { CACHE_DIR, DEFAULT_ENABLE_CACHE, DEFAULT_ESBUILD_JS_CDN_URL, DEFAULT_ESBUILD_WASM_CDN_URL } from '../../../constants';
import { EsbuildStatus } from 'src/types/events';

export class EsbuildConfigSection extends SettingSection {
    private enableCacheToggle?: ToggleComponent;
    private renewCacheBtn?: ButtonComponent;
    private esbuildJsCdnUrlInput?: TextComponent;
    private esbuildWasmCdnUrlInput?: TextComponent;

    public render(containerEl: HTMLElement): void {
        const esbuildConfigSection = containerEl.createDiv({ cls: 'in-app-builder-settings-section' });
        esbuildConfigSection.createEl('h3', { text: 'esbuild Library Configuration' });

        new Setting(esbuildConfigSection)
            .setName('Enable Caching')
            .setDesc(`Cache esbuild assets to "${CACHE_DIR}" for faster initialization`)
            .addToggle(toggle => {
                this.enableCacheToggle = toggle;
                toggle.onChange((value) => this._saveGlobalSetting('enableCache', value));
            });

        new Setting(esbuildConfigSection)
            .setName('Renew Cache')
            .setDesc('Force re-download of esbuild assets on next build')
            .addButton(button => {
                this.renewCacheBtn = button;
                button.setButtonText('Renew Cache')
                      .setIcon('refresh-cw')
                      .setWarning()
                      .onClick(() => this._confirmCacheRenewal());
            });

        this.esbuildJsCdnUrlInput = this._createEsbuildUrlSetting(
            esbuildConfigSection, 'esbuild.min.js CDN URL', 'URL for main esbuild JavaScript file',
            DEFAULT_ESBUILD_JS_CDN_URL, 'esbuildJsCdnUrl'
        );

        this.esbuildWasmCdnUrlInput = this._createEsbuildUrlSetting(
            esbuildConfigSection, 'esbuild.wasm CDN URL', 'URL for esbuild WebAssembly file',
            DEFAULT_ESBUILD_WASM_CDN_URL, 'esbuildWasmCdnUrl'
        );
    }

    public load(settings: PluginSettings): void {
        this.enableCacheToggle?.setValue(settings.enableCache ?? DEFAULT_ENABLE_CACHE);
        this.esbuildJsCdnUrlInput?.setValue(settings.esbuildJsCdnUrl);
        this.esbuildWasmCdnUrlInput?.setValue(settings.esbuildWasmCdnUrl);

        this.unsubscribeCallbacks.push(
            this.eventBus.subscribe('ESBUILD_STATUS_CHANGED', (payload) => this._onEsbuildStatusChanged(payload.status))
        );
        this._onEsbuildStatusChanged(this.esbuildService.isInitializing() ? 'initializing' : 'initialized');
    }

    private _onEsbuildStatusChanged(status: EsbuildStatus): void {
        const canInteract = status !== 'initializing';
        this.renewCacheBtn?.setDisabled(!canInteract);
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
                    .onChange((value: string) => this._saveGlobalSetting(valueKey, value.trim()));
            });
        return textComponent!;
    }

    private _confirmCacheRenewal(): void {
        const confirmModal = new Modal(this.app);
        confirmModal.titleEl.setText('Confirm Cache Renewal');
        confirmModal.contentEl.createEl('p', { text: `This will delete the "${CACHE_DIR}" directory and force re-download of esbuild assets.` });
        confirmModal.contentEl.createEl('p', { text: '⚠️ Any ongoing builds will be interrupted!', cls: 'text-warning' });
        
        const btnContainer = confirmModal.contentEl.createDiv({ cls: 'modal-button-container' });
        new ButtonComponent(btnContainer).setButtonText('Cancel').onClick(() => confirmModal.close());
        new ButtonComponent(btnContainer).setButtonText('Renew').setCta().onClick(() => {
            confirmModal.close();
            this._safeCommandDispatch('CLEAR_CACHE', {});
        });
        confirmModal.open();
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
