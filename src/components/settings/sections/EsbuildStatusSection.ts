/**
 * @file Renders and manages the "esbuild Service Status" section of the settings tab.
 */

import { Setting, ButtonComponent } from 'obsidian';
import { SettingSection } from '../SettingSection';
import { EsbuildStatus } from '../../../types/events';
import { PluginSettings } from '../../../types';

export class EsbuildStatusSection extends SettingSection {
    private esbuildStatusEl?: HTMLElement;
    private reinitializeEsbuildBtn?: ButtonComponent;

    public render(containerEl: HTMLElement): void {
        const esbuildStatusSection = containerEl.createDiv({ cls: 'in-app-builder-settings-section' });
        new Setting(esbuildStatusSection).setName('esbuild service status').setHeading();
        const statusSetting = new Setting(esbuildStatusSection).setName('Current status');
        statusSetting.settingEl.addClass('esbuild-status-setting');
        
        this.esbuildStatusEl = statusSetting.controlEl.createSpan({ cls: 'in-app-builder-status-text' });

        this.reinitializeEsbuildBtn = new ButtonComponent(statusSetting.controlEl)
            .setTooltip("Force re-initialization of esbuild service")
            .setClass('mod-cta')
            .onClick(() => this._safeCommandDispatch(
                'REINITIALIZE_ESBUILD',
                { initiatorId: 'SettingsTabManualReinit' }
            ));
    }

    public load(settings: PluginSettings): void {
        this.unsubscribeCallbacks.push(
            this.eventBus.subscribe('ESBUILD_STATUS_CHANGED', (payload) =>
                this._updateEsbuildStatus(payload.status, payload.error?.message || null)
            )
        );

        // Populate initial status
        this._updateEsbuildStatus(
            this.esbuildService.isInitializing() ? 'initializing' :
            this.esbuildService.isInitialized() ? 'initialized' : 'uninitialized',
            this.esbuildService.getLastInitializationError()?.message || null
        );
    }

    private _updateEsbuildStatus(status: EsbuildStatus, error: string | null): void {
        if (!this.esbuildStatusEl || !this.reinitializeEsbuildBtn) return;

        let statusText = 'Unknown';
        let statusClass = '';
        let canInteract = true;

        switch (status) {
            case 'initializing':
                statusText = 'Initializing...';
                statusClass = 'status-progress';
                canInteract = false;
                break;
            case 'initialized':
                statusText = 'Initialized ✓';
                statusClass = 'status-ok';
                break;
            case 'error':
                statusText = `Error: ${error?.substring(0, 70) || 'Unknown'}...`;
                statusClass = 'status-error';
                break;
            case 'uninitialized':
                statusText = 'Not initialized';
                break;
        }

        this.esbuildStatusEl.textContent = statusText;
        this.esbuildStatusEl.className = `in-app-builder-status-text ${statusClass}`;
        this.reinitializeEsbuildBtn.setButtonText(status === 'initializing' ? "Initializing..." : "Reinitialize")
            .setDisabled(!canInteract);
    }
}