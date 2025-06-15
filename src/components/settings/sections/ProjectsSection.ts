/*
 * FILE: src/components/settings/sections/ProjectsSection.ts
 */

import { Setting, ButtonComponent, Notice, Modal } from 'obsidian';
import { SettingSection } from '../SettingSection';
import { ProjectSettings, NewProjectSettings, PluginSettings } from '../../../types';
import { ProjectModal } from '../../ProjectModal';
import { VaultPathResolver } from '../../../utils/VaultPathResolver';
import { PluginError } from '../../../errors/CustomErrors';

// Retain ProjectUiControls for managing build button state dynamically
interface ProjectUiControls {
    setting: Setting;
    buildBtn: ButtonComponent;
}

export class ProjectsSection extends SettingSection {
    private projectsContainerEl?: HTMLElement;
    private projectUiControls: Map<string, ProjectUiControls> = new Map();

    public render(containerEl: HTMLElement): void {
        const details = containerEl.createEl('details', { cls: 'in-app-builder-settings-section', attr: { open: true } });
        details.createEl('summary', { text: 'Projects' });
        
        // This button is always visible, providing a consistent entry point.
        new Setting(details)
            .addButton(button => button
                .setButtonText('Add new project')
                .setCta() // Make it a primary action button for better visibility.
                .onClick(() => this._openProjectModal(null)));

        // This is the container that will hold EITHER the list of projects
        // OR the "empty state" message.
        this.projectsContainerEl = details.createDiv();
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

    private _updateProjectBuildStatus(projectId: string, status: 'idle' | 'building'): void {
        const controls = this.projectUiControls.get(projectId);
        if (!controls) return;
        controls.buildBtn.setIcon(status === 'building' ? 'loader' : 'play').setDisabled(status === 'building');
    }

    private _updateProjectsList(projects: readonly ProjectSettings[]): void {
        if (!this.projectsContainerEl) {
            this.logger.log('verbose', '[ProjectsSection] _updateProjectsList called but projectsContainerEl is not available. Skipping update.');
            return;
        }
    
        this.logger.log('verbose', `[ProjectsSection] Updating projects list. New count: ${projects.length}.`);
    
        this.projectsContainerEl.empty();
        this.projectUiControls.clear();
    
        if (projects.length === 0) {
            this.logger.log('verbose', '[ProjectsSection] No projects found, empty state message is not rendered.');
        } else {
            for (const project of projects) {
                this._renderProjectItem(project);
            }
            this.logger.log('verbose', `[ProjectsSection] Re-rendered ${projects.length} project items.`);
        }
    }

    private _updateProjectDetails(detailsEl: HTMLElement, project: ProjectSettings): void {
        const createDetail = (icon: string, text: string, tooltip: string) => {
            const el = detailsEl.createDiv({ cls: 'project-item-detail' });
            el.createSpan({ text: icon, cls: 'icon' });
            el.createSpan({ text });
            el.setAttr('aria-label', tooltip);
        };

        const path = VaultPathResolver.normalize(project.path);
        const entry = VaultPathResolver.normalize(project.entryPoint);
        const output = VaultPathResolver.normalize(project.outputFile);

        createDetail('📁', `Path: ${path}`, `Project Path: ${path}`);
        createDetail('→', `Entry: ${entry}`, `Entry Point: ${entry}`);
        createDetail('←', `Output: ${output}`, `Output File: ${output}`);
    }

    private _renderProjectItem(project: ProjectSettings): void {
        if (!this.projectsContainerEl) return;

        const setting = new Setting(this.projectsContainerEl);
        setting.settingEl.addClass('project-item');
        setting.infoEl.remove(); // Remove default info cell
        setting.controlEl.style.width = '100%'; // Make control cell take full width

        const container = setting.controlEl.createDiv({ cls: 'project-item-container' });
        const header = container.createDiv({ cls: 'project-item-header' });
        
        const infoDiv = header.createDiv({ cls: 'project-item-info-main' });
        infoDiv.createEl('div', { text: project.name || '(Unnamed Project)', cls: 'project-item-name' });

        const detailsDiv = infoDiv.createDiv({ cls: 'project-item-details' });
        this._updateProjectDetails(detailsDiv, project);

        const actionsDiv = header.createDiv({ cls: 'project-item-actions' });
        const buildBtn = new ButtonComponent(actionsDiv)
            .setIcon('play')
            .setTooltip(`Build ${project.name}`)
            .onClick(() => {
                const currentProject = this.settingsService.getSettings().projects.find(p => p.id === project.id);
                if (currentProject) {
                    this._safeCommandDispatch('BUILD_PROJECT', { projectId: currentProject.id, initiator: 'settings-tab' });
                } else {
                    this.logger.log('error', `[ProjectsSection] Build button clicked for a project (ID: ${project.id}) that no longer exists in settings.`);
                    new Notice('Error: Project not found. It might have been deleted.');
                }
            });

        new ButtonComponent(actionsDiv)
            .setIcon('clipboard-copy')
            .setTooltip('Copy last build diagnostic info')
            .onClick(() => {
                const currentProject = this.settingsService.getSettings().projects.find(p => p.id === project.id);
                if (currentProject) {
                    this._safeCommandDispatch('COPY_DIAGNOSTICS', { projectId: currentProject.id });
                } else {
                    this.logger.log('error', `[ProjectsSection] Copy diagnostics button clicked for a project (ID: ${project.id}) that no longer exists.`);
                }
            });

        new ButtonComponent(actionsDiv)
            .setIcon('pencil')
            .setTooltip('Edit project')
            .onClick(() => {
                const currentProject = this.settingsService.getSettings().projects.find(p => p.id === project.id);
                if (currentProject) {
                    this._openProjectModal(currentProject);
                } else {
                    this.logger.log('error', `[ProjectsSection] Edit button clicked for a project (ID: ${project.id}) that no longer exists in settings.`);
                    new Notice('Error: Project not found. It might have been deleted. Please refresh settings.');
                }
            });

        new ButtonComponent(actionsDiv)
            .setIcon('trash')
            .setTooltip('Delete project')
            .onClick(() => {
                const currentProject = this.settingsService.getSettings().projects.find(p => p.id === project.id);
                if (currentProject) {
                    this._confirmProjectDeletion(currentProject);
                } else {
                    this.logger.log('error', `[ProjectsSection] Delete button clicked for a project (ID: ${project.id}) that no longer exists.`);
                }
            });

        this.projectUiControls.set(project.id, { setting, buildBtn });
    }

    private _openProjectModal(project: ProjectSettings | null): void {
        new ProjectModal(this.app, project, async (settingsToSave: NewProjectSettings | ProjectSettings) => {
            try {
                const commandType = (settingsToSave as ProjectSettings).id ? 'UPDATE_PROJECT' : 'ADD_PROJECT';
                await this._safeCommandDispatch(commandType, { projectData: settingsToSave as any });
                new Notice(`Project "${settingsToSave.name}" ${ (settingsToSave as ProjectSettings).id ? 'updated' : 'added'} ✓`, 3000);
            } catch (e: unknown) {
                const err = e instanceof PluginError ? e : new Error(String(e));
                new Notice(`❌ ${err.message.substring(0, 120)}...`, 7000);
                this.logger.log('error', `[ProjectsSection] Error submitting project modal for "${settingsToSave.name}"`, err);
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
                this.logger.log('error', `[ProjectsSection] Error deleting project "${project.name}"`, err);
            }
        });
        confirmModal.open();
    }
}
