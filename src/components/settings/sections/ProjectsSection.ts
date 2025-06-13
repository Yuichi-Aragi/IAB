/**
 * @file Renders and manages the "Projects" section of the settings tab.
 */

import { Setting, ButtonComponent, Notice, Modal } from 'obsidian';
import { SettingSection } from '../SettingSection';
import { ProjectSettings, NewProjectSettings, PluginSettings } from '../../../types';
import { ProjectModal } from '../../ProjectModal';
import { VaultPathResolver } from '../../../utils/VaultPathResolver';
import { PluginError } from '../../../errors/CustomErrors';

type ProjectBuildStatus = 'idle' | 'building';

interface ProjectUiControls {
    setting: Setting;
    buildBtn: ButtonComponent;
}

export class ProjectsSection extends SettingSection {
    private projectsContainerEl?: HTMLElement;
    private projectUiControls: Map<string, ProjectUiControls> = new Map();

    public render(containerEl: HTMLElement): void {
        const projectsSection = containerEl.createDiv({ cls: 'in-app-builder-settings-section' });
        projectsSection.createEl('h3', { text: 'Projects' });
        new Setting(projectsSection)
            .addButton(button => button
                .setButtonText('Add New Project')
                .onClick(() => this._openProjectModal(null)));

        this.projectsContainerEl = projectsSection.createDiv();
    }

    public load(settings: PluginSettings): void {
        const safeHandler = <T>(handler: (payload: T) => void) => (payload: T) => {
            try { handler(payload); } catch (e) { this.logger.log('error', 'Event handler error in ProjectsSection', e); }
        };

        this.unsubscribeCallbacks.push(
            this.eventBus.subscribe('SETTINGS_CHANGED', safeHandler(p => this._updateProjectsList(p.newSettings.projects))),
            this.eventBus.subscribe('BUILD_STARTED', safeHandler(p => this._updateProjectBuildStatus(p.projectId, 'building'))),
            this.eventBus.subscribe('BUILD_SUCCEEDED', safeHandler(p => {
                this._updateProjectBuildStatus(p.projectId, 'idle');
                if (p.initiator === 'settings-tab') new Notice(`✅ Build successful!\nOutput: ${VaultPathResolver.normalize(p.outputPath)}`, 7000);
            })),
            this.eventBus.subscribe('BUILD_FAILED', safeHandler(p => {
                this._updateProjectBuildStatus(p.projectId, 'idle');
                if (p.initiator === 'settings-tab') new Notice(`❌ BUILD FAILED\n${p.error.substring(0, 120)}...`, 15000);
            })),
            this.eventBus.subscribe('BUILD_WARNING', safeHandler(p => {
                if (p.initiator === 'settings-tab') new Notice(`⚠️ ${p.warning}`, 10000);
            })),
            this.eventBus.subscribe('DIAGNOSTIC_COPIED', safeHandler(p => new Notice(p.message, p.success ? 3000 : 7000)))
        );
        
        this._updateProjectsList(settings.projects);
    }

    public unload(): void {
        super.unload();
        this.projectUiControls.clear();
    }

    private _updateProjectBuildStatus(projectId: string, status: ProjectBuildStatus): void {
        const controls = this.projectUiControls.get(projectId);
        if (!controls) return;
        controls.buildBtn.setIcon(status === 'building' ? 'loader' : 'play').setDisabled(status === 'building');
    }

    private _updateProjectsList(projects: readonly ProjectSettings[]): void {
        if (!this.projectsContainerEl) return;

        const newIds = new Set(projects.map(p => p.id));
        const existingIds = new Set(this.projectUiControls.keys());

        for (const id of existingIds) {
            if (!newIds.has(id)) {
                this.projectUiControls.get(id)?.setting.settingEl.remove();
                this.projectUiControls.delete(id);
            }
        }

        for (const project of projects) {
            if (this.projectUiControls.has(project.id)) this._updateProjectItem(project);
            else this._renderProjectItem(project);
        }

        const placeholder = this.projectsContainerEl.querySelector('.empty-state');
        if (projects.length === 0 && !placeholder) {
            this.projectsContainerEl.createEl('p', { text: 'No projects configured. Click "Add New Project" to start.', cls: 'empty-state' });
        } else if (projects.length > 0 && placeholder) {
            placeholder.remove();
        }
    }

    private _updateProjectItem(project: ProjectSettings): void {
        const controls = this.projectUiControls.get(project.id);
        if (!controls) return;
        const path = VaultPathResolver.normalize(project.path);
        const entry = VaultPathResolver.normalize(project.entryPoint);
        const output = VaultPathResolver.normalize(project.outputFile);
        controls.setting.setName(project.name || '(Unnamed Project)').setDesc(`Path: ${path} | Entry: ${entry} | Output: ${output}`);
    }

    private _renderProjectItem(project: ProjectSettings): void {
        if (!this.projectsContainerEl) return;
        const controls = { setting: new Setting(this.projectsContainerEl), buildBtn: new ButtonComponent(createDiv()) };
        this._updateProjectItem(project);
        const settingEl = controls.setting.settingEl;
        settingEl.addClass('project-item');
        const actionsDiv = settingEl.createDiv({ cls: 'project-actions' });

        controls.buildBtn = new ButtonComponent(actionsDiv).setIcon('play').setTooltip(`Build ${project.name}`)
            .onClick(() => this._safeCommandDispatch('BUILD_PROJECT', { projectId: project.id, initiator: 'settings-tab' }));
        new ButtonComponent(actionsDiv).setIcon('clipboard-copy').setTooltip('Copy diagnostic info')
            .onClick(() => this._safeCommandDispatch('COPY_DIAGNOSTICS', { projectId: project.id }));
        new ButtonComponent(actionsDiv).setIcon('pencil').setTooltip('Edit project')
            .onClick(() => this._openProjectModal(project));
        new ButtonComponent(actionsDiv).setIcon('trash').setTooltip('Delete project')
            .onClick(() => this._confirmProjectDeletion(project));

        this.projectUiControls.set(project.id, controls);
    }

    private _openProjectModal(project: ProjectSettings | null): void {
        new ProjectModal(this.app, project, async (settings: NewProjectSettings | ProjectSettings) => {
            try {
                const commandType = project ? 'UPDATE_PROJECT' : 'ADD_PROJECT';
                await this._safeCommandDispatch(commandType, { projectData: settings });
                new Notice(`Project "${settings.name}" ${project ? 'updated' : 'added'} ✓`, 3000);
            } catch (e: unknown) {
                const err = e instanceof PluginError ? e : new Error(String(e));
                new Notice(`❌ ${err.message.substring(0, 120)}...`, 7000);
            }
        }).open();
    }

    private _confirmProjectDeletion(project: ProjectSettings): void {
        const confirmModal = new Modal(this.app);
        confirmModal.titleEl.setText(`Delete "${project.name}"?`);
        confirmModal.contentEl.createEl('p', { text: 'This will permanently remove the project configuration and cannot be undone.' });
        const btnContainer = confirmModal.contentEl.createDiv({ cls: 'modal-button-container' });
        new ButtonComponent(btnContainer).setButtonText('Cancel').onClick(() => confirmModal.close());
        new ButtonComponent(btnContainer).setButtonText('Delete').setCta().onClick(async () => {
            confirmModal.close();
            try {
                await this._safeCommandDispatch('REMOVE_PROJECT', { projectId: project.id });
                new Notice(`Project "${project.name}" deleted ✓`, 3000);
            } catch (e: unknown) {
                const err = e instanceof PluginError ? e : new Error(String(e));
                new Notice(`❌ ${err.message.substring(0, 120)}...`, 7000);
            }
        });
        confirmModal.open();
    }
}
