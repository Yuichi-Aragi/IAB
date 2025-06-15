import { ItemView, WorkspaceLeaf, Setting, SliderComponent, DropdownComponent, ButtonComponent, Menu, Notice } from 'obsidian';
import { InAppBuilderPlugin } from '../core/InAppBuilderPlugin';
import { ANALYSIS_VIEW_TYPE, DEFAULT_REAL_TIME_ANALYSIS_UPDATE_SPEED } from '../constants';
import { AppEvent, AnalysisLogEvent } from '../types/events';
import { LogLevel, PluginSettings } from '../types';
import { EventBus } from '../services/EventBus';
import { Logger } from '../utils/Logger';
import { FileService } from '../services/FileService';
import { container, ServiceTokens } from '../utils/DIContainer';
import { VaultPathResolver } from '../utils/VaultPathResolver';

type ViewState = 'IDLE' | 'LOGGING' | 'FINISHED';

interface DetailedLogEntry {
    id: number;
    level: LogLevel;
    timestamp: string;
    message: string;
    details?: unknown;
}

export class AnalysisView extends ItemView {
    private readonly plugin: InAppBuilderPlugin;
    private get eventBus(): EventBus { return container.resolve<EventBus>(ServiceTokens.EventBus); }
    private get logger(): Logger { return container.resolve<Logger>(ServiceTokens.Logger); }
    private get fileService(): FileService { return container.resolve<FileService>(ServiceTokens.FileService); }

    private state: ViewState = 'IDLE';
    private logBuffer: DetailedLogEntry[] = [];
    private renderBuffer: DetailedLogEntry[] = [];
    private nextLogId = 0;
    private currentProjectId: string | null = null;
    private currentProjectName: string = 'No active build';
    private buildEndTime: Date | null = null;

    private selectedLogLevel: LogLevel = 'verbose';
    private updateSpeed: number = DEFAULT_REAL_TIME_ANALYSIS_UPDATE_SPEED;

    private headerEl!: HTMLElement;
    private controlsEl!: HTMLElement;
    private logContainerEl!: HTMLElement;
    private saveBtn!: ButtonComponent;
    private clearBtn!: ButtonComponent;

    private isRendering = false;
    private renderLoopHandle: number | null = null;

    constructor(leaf: WorkspaceLeaf, plugin: InAppBuilderPlugin) {
        super(leaf);
        this.plugin = plugin;
    }

    getViewType(): string { return ANALYSIS_VIEW_TYPE; }
    getDisplayText(): string { return 'Build Analysis'; }
    getIcon(): string { return 'microscope'; }

    async onOpen(): Promise<void> {
        this._buildUI();
        this._subscribeToEvents();
        this.updateSpeed = this.plugin.settingsService.getSettings().realTimeAnalysisUpdateSpeed;
        this._startRenderLoop();
    }

    async onClose(): Promise<void> {
        if (this.renderLoopHandle) {
            cancelAnimationFrame(this.renderLoopHandle);
            this.renderLoopHandle = null;
        }
    }

    private _buildUI(): void {
        this.containerEl.children[1].empty(); // Clear content
        this.containerEl.children[1].addClass('in-app-builder-analysis-view');

        this.headerEl = this.containerEl.children[1].createDiv({ cls: 'analysis-view-header' });
        
        const controlsDetails = this.containerEl.children[1].createEl('details', { cls: 'analysis-view-controls-container' });
        controlsDetails.createEl('summary', { text: 'View Controls' });
        this.controlsEl = controlsDetails.createDiv({ cls: 'analysis-view-controls' });

        this.logContainerEl = this.containerEl.children[1].createDiv({ cls: 'analysis-log-container' });

        this._updateHeader();
        this._buildControls();
    }

    private _buildControls(): void {
        this.controlsEl.empty();

        new Setting(this.controlsEl)
            .setName('Log level')
            .setDesc('Filter logs shown in this view.')
            .addDropdown((dd: DropdownComponent) => {
                dd.addOption('verbose', 'Verbose')
                  .addOption('info', 'Info')
                  .addOption('warn', 'Warning')
                  .addOption('error', 'Error')
                  .setValue(this.selectedLogLevel)
                  .onChange((value: string) => {
                      this.selectedLogLevel = value as LogLevel;
                      this._rerenderAllLogs();
                  });
            });

        new Setting(this.controlsEl)
            .setName('UI update speed')
            .setDesc('How fast logs appear. Slower may improve performance.')
            .addSlider((slider: SliderComponent) => {
                slider.setLimits(10, 500, 10)
                      .setValue(this.updateSpeed)
                      .setDynamicTooltip()
                      .onChange((value: number) => {
                          this.updateSpeed = value;
                      });
            });

        const buttonsSetting = new Setting(this.controlsEl);
        this.clearBtn = new ButtonComponent(buttonsSetting.controlEl)
            .setButtonText('Clear Log')
            .setTooltip('Clear the current log view')
            .setDisabled(true)
            .onClick(() => this._clearLog());

        this.saveBtn = new ButtonComponent(buttonsSetting.controlEl)
            .setButtonText('Save Log')
            .setTooltip('Save the complete build log')
            .setDisabled(true)
            .onClick((evt: MouseEvent) => this._showSaveMenu(evt));
    }

    private _subscribeToEvents(): void {
        this.register(
            this.eventBus.subscribe('BUILD_STARTED', (payload) => this._handleBuildStarted(payload))
        );
        this.register(
            this.eventBus.subscribe('ANALYSIS_LOG', (payload) => this._handleAnalysisLog(payload))
        );
        this.register(
            this.eventBus.subscribe('BUILD_SUCCEEDED', (payload) => this._handleBuildEnded(payload.projectId))
        );
        this.register(
            this.eventBus.subscribe('BUILD_FAILED', (payload) => this._handleBuildEnded(payload.projectId))
        );
        this.register(
            this.eventBus.subscribe('SETTINGS_CHANGED', (payload) => this._handleSettingsChanged(payload.newSettings))
        );
    }

    private _handleSettingsChanged(settings: PluginSettings): void {
        this.updateSpeed = settings.realTimeAnalysisUpdateSpeed;
        const slider = this.controlsEl.querySelector('.slider-thumb') as any;
        if (slider && slider.value !== this.updateSpeed) {
            slider.value = this.updateSpeed;
        }
    }

    private _handleBuildStarted(payload: Extract<AppEvent, { type: 'BUILD_STARTED' }>['payload']): void {
        const project = this.plugin.settingsService.getSettings().projects.find(p => p.id === payload.projectId);
        if (!project) return;

        this._clearLog();
        this.state = 'LOGGING';
        this.currentProjectId = payload.projectId;
        this.currentProjectName = project.name;
        this._updateHeader();
    }

    private _handleAnalysisLog(payload: AnalysisLogEvent['payload']): void {
        if (payload.projectId !== this.currentProjectId || this.state !== 'LOGGING') {
            return;
        }

        const newLogEntry = { id: this.nextLogId++, ...payload };
        this.logBuffer.push(newLogEntry);
        this.renderBuffer.push(newLogEntry);

        if (this.saveBtn.disabled) {
            this.saveBtn.setDisabled(false);
            this.clearBtn.setDisabled(false);
        }
    }

    private _handleBuildEnded(projectId: string): void {
        if (projectId !== this.currentProjectId) return;
        this.state = 'FINISHED';
        this.buildEndTime = new Date();
        this._updateHeader();
    }

    private _clearLog(): void {
        this.state = 'IDLE';
        this.currentProjectId = null;
        this.currentProjectName = 'No active build';
        this.buildEndTime = null;
        this.logBuffer = [];
        this.renderBuffer = [];
        this.nextLogId = 0;
        this.logContainerEl.empty();
        this._updateHeader();
        this.saveBtn.setDisabled(true);
        this.clearBtn.setDisabled(true);
    }

    private _startRenderLoop(): void {
        const loop = () => {
            if (this.renderBuffer.length > 0) {
                const logToRender = this.renderBuffer.shift()!;
                this._renderLogEntry(logToRender);
            }
            this.renderLoopHandle = window.setTimeout(() => requestAnimationFrame(loop), this.updateSpeed);
        };
        this.renderLoopHandle = requestAnimationFrame(loop);
    }

    private _rerenderAllLogs(): void {
        this.logContainerEl.empty();
        for (const log of this.logBuffer) {
            this._renderLogEntry(log);
        }
    }

    private _renderLogEntry(log: DetailedLogEntry): void {
        const logLevelMap = { verbose: 0, info: 1, warn: 2, error: 3, silent: 4 };
        if (logLevelMap[log.level] < logLevelMap[this.selectedLogLevel]) {
            return;
        }

        const entryEl = this.logContainerEl.createDiv({ cls: `analysis-log-entry log-level-${log.level}` });
        const time = new Date(log.timestamp).toLocaleTimeString('en-US', { hour12: false });
        entryEl.createSpan({ text: `[${time}]`, cls: 'log-timestamp' });
        entryEl.createSpan({ text: `[${log.level.toUpperCase()}]`, cls: 'log-level' });
        entryEl.createSpan({ text: log.message, cls: 'log-message' });

        if (log.details) {
            const detailsEl = entryEl.createEl('details', { cls: 'log-details' });
            detailsEl.createEl('summary', { text: 'Details' });
            const pre = detailsEl.createEl('pre');
            try {
                pre.textContent = JSON.stringify(log.details, null, 2);
            } catch (e) {
                pre.textContent = String(log.details);
            }
        }
        this.logContainerEl.scrollTop = this.logContainerEl.scrollHeight;
    }

    private _updateHeader(): void {
        this.headerEl.empty();
        this.headerEl.createEl('h4', { text: 'Project:' });
        this.headerEl.createEl('span', { text: this.currentProjectName, cls: `project-status project-status-${this.state.toLowerCase()}` });
    }

    private _showSaveMenu(evt: MouseEvent): void {
        if (this.state === 'IDLE' || this.logBuffer.length === 0) return;

        const menu = new Menu();
        menu.addItem((item) =>
            item.setTitle('Save as Markdown (.md)')
                .setIcon('document')
                .onClick(() => this._saveLogFile('md'))
        );
        menu.addItem((item) =>
            item.setTitle('Save as NDJSON (.ndjson)')
                .setIcon('file-json')
                .onClick(() => this._saveLogFile('ndjson'))
        );
        menu.showAtMouseEvent(evt);
    }

    private async _saveLogFile(format: 'md' | 'ndjson'): Promise<void> {
        if (this.logBuffer.length === 0 || !this.currentProjectId) {
            new Notice('No log data to save.');
            return;
        }

        const timestamp = (this.buildEndTime || new Date()).toISOString().replace(/[:.]/g, '-');
        const fileName = `iab-${this.currentProjectName}-${timestamp}.${format}`;
        const outputPath = VaultPathResolver.join('.obsidian/plugins/in-app-builder/logs', fileName);

        let fileContent = '';
        if (format === 'md') {
            fileContent = this.logBuffer.map(log => {
                let mdLine = `**[${log.level.toUpperCase()}]** \`${new Date(log.timestamp).toISOString()}\` - ${log.message}`;
                if (log.details) {
                    mdLine += `\n\n\`\`\`json\n${JSON.stringify(log.details, null, 2)}\n\`\`\`\n`;
                }
                return mdLine;
            }).join('\n\n---\n\n');
        } else {
            fileContent = this.logBuffer.map(log => JSON.stringify(log)).join('\n');
        }

        try {
            await this.fileService.writeFile(outputPath, fileContent);
            new Notice(`Log saved successfully to:\n${outputPath}`);
        } catch (e) {
            this.logger.log('error', 'Failed to save analysis log file', e);
            new Notice('Error saving log file. Check console for details.');
        }
    }
}
