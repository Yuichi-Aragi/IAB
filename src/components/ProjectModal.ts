import { App, Modal, Setting, TextComponent, ButtonComponent, DropdownComponent, ToggleComponent, Notice, TextAreaComponent } from 'obsidian';
import { ProjectSettings, NewProjectSettings, LogLevel, Dependency, BuildOptions, EsbuildFormat, EsbuildPlatform, EsbuildLoader } from '../types';
import { VaultPathResolver } from '../utils/VaultPathResolver';
import { isValidVaultPath, isValidRelativeFilePath, validateDependency, isValidBuildOptions } from '../utils/ValidationUtils';
import { DEFAULT_PROJECT_BUILD_OPTIONS, DEFAULT_PROJECT_LOG_LEVEL } from '../constants';
import { container, ServiceTokens } from '../utils/DIContainer';
import { Logger } from '../utils/Logger';

/**
 * A reference to a UI input component and its associated feedback element.
 * This structure helps manage the state of each input in the modal.
 */
interface InputRefWithFeedback {
    component: TextComponent | DropdownComponent | ToggleComponent | TextAreaComponent;
    feedbackEl?: HTMLElement;
}

/**
 * A modal for creating and editing build project settings.
 * It provides a comprehensive form with real-time validation to guide the user.
 */
export class ProjectModal extends Modal {
    private project: ProjectSettings | NewProjectSettings;
    private isNewProject: boolean;
    private onSubmit: (settings: ProjectSettings | NewProjectSettings) => Promise<void>;

    /** A map to hold references to all UI input components for validation purposes. */
    private inputRefs: Record<string, InputRefWithFeedback> = {};
    private get logger(): Logger { return container.resolve<Logger>(ServiceTokens.Logger); }

    constructor(app: App, projectToEdit: ProjectSettings | null, onSubmit: (settings: ProjectSettings | NewProjectSettings) => Promise<void>) {
        super(app);
        this.isNewProject = !projectToEdit;
        this.onSubmit = onSubmit;

        // Deeply merge provided build options with defaults to handle new options gracefully.
        const baseBuildOptions = this.isNewProject
            ? { ...DEFAULT_PROJECT_BUILD_OPTIONS }
            : { ...DEFAULT_PROJECT_BUILD_OPTIONS, ...(projectToEdit?.buildOptions || {}) };

        if (projectToEdit) {
            // Create a deep copy to avoid mutating the original settings object directly.
            this.project = JSON.parse(JSON.stringify({
                ...projectToEdit,
                dependencies: projectToEdit.dependencies || [],
                logLevel: projectToEdit.logLevel || DEFAULT_PROJECT_LOG_LEVEL,
                buildOptions: baseBuildOptions
            })) as ProjectSettings;
        } else {
            // Initialize a new project with default values.
            this.project = {
                name: '',
                path: '.',
                entryPoint: 'main.ts',
                outputFile: 'main.js',
                dependencies: [],
                logLevel: DEFAULT_PROJECT_LOG_LEVEL,
                buildOptions: baseBuildOptions
            } as Omit<NewProjectSettings, 'id' | 'commandId'>;
        }

        this.modalEl.addClass('in-app-builder-project-modal');
    }

    onOpen(): void {
        const { contentEl } = this;
        contentEl.empty();
        contentEl.addClass('in-app-builder-modal');
        this.inputRefs = {};

        // Note: Style management is centralized in InAppBuilderSettingTab.ts
        // to ensure robust lifecycle handling. No style injection/removal here.

        contentEl.createEl('h2', { text: this.isNewProject ? 'Add New Build Project' : `Edit Project: ${(this.project as ProjectSettings).name}` });

        this._renderBasicSettings(contentEl);
        this._renderBuildOptions(contentEl);
        this._renderExternalDependencies(contentEl);
        this._renderAdvancedSettings(contentEl);
        this._renderActionButtons(contentEl);

        // Trigger initial validation on all fields to show their current state.
        this._validateAllFields();
    }

    /**
     * Creates a standard text input setting with integrated validation feedback.
     * @param containerEl The parent element for the setting.
     * @param name The setting's display name.
     * @param desc The setting's description.
     * @param placeholder The input's placeholder text.
     * @param projectKey The key in the `project` object this input maps to.
     * @param validationFn A function that validates the input value.
     */
    private _createValidatedTextSetting(
        containerEl: HTMLElement, name: string, desc: string, placeholder: string,
        projectKey: keyof Pick<ProjectSettings, 'name' | 'path' | 'entryPoint' | 'outputFile'>,
        validationFn: (value: string) => { valid: boolean; message?: string; normalizedValue?: string }
    ): void {
        const setting = new Setting(containerEl).setName(name).setDesc(desc);
        const feedbackEl = createDiv({ cls: 'setting-item-feedback' });
        setting.controlEl.appendChild(feedbackEl);

        setting.addText(text => {
            this.inputRefs[projectKey] = { component: text, feedbackEl };
            text.setPlaceholder(placeholder)
                .setValue(this.project[projectKey as keyof typeof this.project] as string)
                .onChange(value => {
                    const validationResult = validationFn(value);
                    // Use the normalized value if the validation function provides one.
                    const finalValue = validationResult.normalizedValue !== undefined ? validationResult.normalizedValue : value.trim();
                    (this.project[projectKey as keyof typeof this.project] as any) = finalValue;
                    
                    // If normalization changed the value, update the input field to reflect it.
                    if (text.getValue() !== finalValue) {
                         text.setValue(finalValue);
                    }

                    this._updateFeedback(feedbackEl, validationResult.valid, validationResult.message);
                    text.inputEl.toggleClass('in-app-builder-input-error', !validationResult.valid);
                });
            // Perform initial validation on load.
            const initialValidation = validationFn(this.project[projectKey as keyof typeof this.project] as string);
            this._updateFeedback(feedbackEl, initialValidation.valid, initialValidation.message);
            text.inputEl.toggleClass('in-app-builder-input-error', !initialValidation.valid);
        });
    }
    
    /**
     * Updates the validation feedback element for an input.
     * @param feedbackEl The HTML element for feedback.
     * @param isValid Whether the current value is valid.
     * @param message The message to display.
     */
    private _updateFeedback(feedbackEl: HTMLElement | undefined, isValid: boolean, message?: string): void {
        if (!feedbackEl) return;
        feedbackEl.setText(message || (isValid ? '✓ Valid' : ''));
        feedbackEl.toggleClass('setting-item-feedback-error', !isValid && !!message);
        feedbackEl.toggleClass('setting-item-feedback-valid', isValid && !!message);
        if (isValid && !message) feedbackEl.setText('');
    }

    /** Renders the core project configuration settings (name, paths). */
    private _renderBasicSettings(contentEl: HTMLElement): void {
        contentEl.createEl('h3', { text: 'Basic Configuration' });

        this._createValidatedTextSetting(contentEl, 'Project Name', 'A descriptive name. Required.', 'My Awesome Plugin', 'name', value => {
            const trimmed = value.trim();
            if (!trimmed) return { valid: false, message: 'Project Name is required.' };
            if (trimmed.length > 100) return {valid: false, message: 'Project Name is too long (max 100 chars).'};
            return { valid: true, normalizedValue: trimmed };
        });

        this._createValidatedTextSetting(contentEl, 'Project Path (Folder)', 'Path to project\'s root folder. Use "." for vault root.', 'Path/To/PluginFolder or .', 'path', value => {
            let processedValue = value.trim();
            if (processedValue === "" || processedValue === "/") processedValue = ".";
            else processedValue = VaultPathResolver.normalize(processedValue);
            
            if (processedValue.endsWith('/') && processedValue !== "." && processedValue.length > 1) processedValue = processedValue.slice(0, -1);
            if (processedValue === "") processedValue = ".";

            if (!isValidVaultPath(processedValue)) return { valid: false, message: 'Invalid vault path. Check for ".." or invalid characters.', normalizedValue: processedValue };
            return { valid: true, normalizedValue: processedValue };
        });

        this._createValidatedTextSetting(contentEl, 'Entry Point File', 'Main TS/JS file, relative to Project Path. Required.', 'main.ts or src/index.js', 'entryPoint', value => {
            let processedValue = VaultPathResolver.normalize(value.trim());
            if (processedValue.startsWith('./')) processedValue = processedValue.substring(2);
            if (processedValue.startsWith('/')) processedValue = processedValue.substring(1);
            if (processedValue === "") processedValue = "main.ts";

            if (!isValidRelativeFilePath(processedValue)) return { valid: false, message: 'Invalid relative file path. Cannot use ".." or start/end with "/".', normalizedValue: processedValue };
            return { valid: true, normalizedValue: processedValue };
        });

        this._createValidatedTextSetting(contentEl, 'Output File Path', 'Bundled JS file path, relative to Project Path. Required.', 'main.js or dist/bundle.js', 'outputFile', value => {
            let processedValue = VaultPathResolver.normalize(value.trim());
            if (processedValue.startsWith('./')) processedValue = processedValue.substring(2);
            if (processedValue.startsWith('/')) processedValue = processedValue.substring(1);
            if (processedValue === "") processedValue = "main.js";

            if (!isValidRelativeFilePath(processedValue)) return { valid: false, message: 'Invalid relative file path. Cannot use ".." or start/end with "/".', normalizedValue: processedValue };
            return { valid: true, normalizedValue: processedValue };
        });
    }

    /**
     * Creates a text area setting for inputting JSON, with validation.
     * @param parentElement The parent element for the setting.
     * @param name The setting's display name.
     * @param description The setting's description.
     * @param placeholder The textarea's placeholder text.
     * @param valueKey The key in `buildOptions` this input maps to.
     */
    private _createJsonTextAreaSetting(
        parentElement: HTMLElement, name: string, description: string, placeholder: string,
        valueKey: keyof BuildOptions
    ): void {
        const setting = new Setting(parentElement).setName(name).setDesc(description);
        const feedbackEl = createDiv({ cls: 'setting-item-feedback' });
        setting.controlEl.appendChild(feedbackEl);

        setting.addTextArea(text => {
            this.inputRefs[valueKey] = { component: text, feedbackEl };
            text.setPlaceholder(placeholder)
                .setValue(this.project.buildOptions[valueKey] ? JSON.stringify(this.project.buildOptions[valueKey], null, 2) : '')
                .onChange(value => {
                    this._validateJsonAndUpdateProject(value, valueKey, feedbackEl, text.inputEl);
                });
            const validateAndStyle = () => this._validateJsonAndUpdateProject(text.getValue(), valueKey, feedbackEl, text.inputEl);
            text.inputEl.addEventListener('blur', validateAndStyle);
            validateAndStyle();
        });
    }

    /**
     * Validates a JSON string, provides specific feedback, and updates the project state.
     * @param jsonString The JSON string from the text area.
     * @param valueKey The key in `buildOptions` to update.
     * @param feedbackEl The feedback element to update.
     * @param inputEl The textarea element to style on error.
     * @returns `true` if the JSON is valid, `false` otherwise.
     */
    private _validateJsonAndUpdateProject(
        jsonString: string, valueKey: keyof BuildOptions, feedbackEl: HTMLElement, inputEl: HTMLTextAreaElement
    ): boolean {
        const trimmedValue = jsonString.trim();
        if (!trimmedValue) {
            (this.project.buildOptions as any)[valueKey] = undefined; // Use undefined to clear
            this._updateFeedback(feedbackEl, true, 'Optional. Cleared if empty.');
            inputEl.removeClass('in-app-builder-input-error');
            return true;
        }
        try {
            const parsed = JSON.parse(trimmedValue);
            let validationError: string | null = null;

            if (valueKey === 'define' || valueKey === 'loader') {
                if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
                    validationError = "Value must be a JSON object (e.g., {\"key\": \"value\"}).";
                } else {
                    if (valueKey === 'define') {
                        for (const k in parsed) {
                            if (typeof parsed[k] !== 'string') {
                                validationError = `Value for key "${k}" must be a string.`;
                                break;
                            }
                        }
                    }
                    if (valueKey === 'loader') {
                         const validLoaderValues: EsbuildLoader[] = ['js', 'jsx', 'ts', 'tsx', 'css', 'json', 'text', 'base64', 'dataurl', 'file', 'binary'];
                         for (const k in parsed) {
                            if (!k.startsWith('.') || k.length < 2) {
                                validationError = `Loader key "${k}" must be a file extension (e.g., '.svg').`;
                                break;
                            }
                            if (typeof parsed[k] !== 'string' || !validLoaderValues.includes(parsed[k])) {
                                validationError = `Loader value for "${k}" is invalid. Must be one of: ${validLoaderValues.join(', ')}.`;
                                break;
                            }
                         }
                    }
                }
            }

            if (validationError) {
                throw new Error(validationError);
            }

            (this.project.buildOptions as any)[valueKey] = parsed;
            this._updateFeedback(feedbackEl, true, '✓ Valid JSON');
            inputEl.removeClass('in-app-builder-input-error');
            return true;

        } catch (e: any) {
            (this.project.buildOptions as any)[valueKey] = undefined; // Clear on error
            const message = e.message.includes('JSON.parse') ? `Invalid JSON format.` : e.message;
            this._updateFeedback(feedbackEl, false, message.substring(0, 150));
            inputEl.addClass('in-app-builder-input-error');
            return false;
        }
    }

    /** Renders all settings related to the esbuild `BuildOptions`. */
    private _renderBuildOptions(contentEl: HTMLElement): void {
        contentEl.createEl('h3', { text: 'esbuild Build Options' });
        const bo = this.project.buildOptions;

        new Setting(contentEl).setName('Bundle').setDesc('Enable/disable bundling. Usually true for plugins.').addToggle(toggle => {
            this.inputRefs['bundle'] = { component: toggle };
            toggle.setValue(bo.bundle === undefined ? DEFAULT_PROJECT_BUILD_OPTIONS.bundle! : bo.bundle).onChange(value => bo.bundle = value);
        });

        contentEl.createEl('h4', { text: 'Minification' });
        new Setting(contentEl).setName('Minify (General)').setDesc('Enable/disable all minification.').addToggle(toggle => {
            this.inputRefs['minify'] = { component: toggle };
            toggle.setValue(bo.minify === undefined ? DEFAULT_PROJECT_BUILD_OPTIONS.minify! : bo.minify).onChange(value => bo.minify = value);
        });
        new Setting(contentEl).setName('Minify Whitespace').addToggle(toggle => {
            this.inputRefs['minifyWhitespace'] = { component: toggle };
            toggle.setValue(bo.minifyWhitespace === undefined ? DEFAULT_PROJECT_BUILD_OPTIONS.minifyWhitespace! : bo.minifyWhitespace!).onChange(value => bo.minifyWhitespace = value);
        });
        new Setting(contentEl).setName('Minify Identifiers').addToggle(toggle => {
            this.inputRefs['minifyIdentifiers'] = { component: toggle };
            toggle.setValue(bo.minifyIdentifiers === undefined ? DEFAULT_PROJECT_BUILD_OPTIONS.minifyIdentifiers! : bo.minifyIdentifiers!).onChange(value => bo.minifyIdentifiers = value);
        });
        new Setting(contentEl).setName('Minify Syntax').addToggle(toggle => {
            this.inputRefs['minifySyntax'] = { component: toggle };
            toggle.setValue(bo.minifySyntax === undefined ? DEFAULT_PROJECT_BUILD_OPTIONS.minifySyntax! : bo.minifySyntax!).onChange(value => bo.minifySyntax = value);
        });

        contentEl.createEl('h4', { text: 'Output & Environment' });
        new Setting(contentEl).setName('Sourcemap').addDropdown(dropdown => {
            this.inputRefs['sourcemap'] = { component: dropdown };
            dropdown.addOption("false", "No Sourcemap")
                    .addOption("true", "Separate File (.map)")
                    .addOption("inline", "Inline Sourcemap")
                    .addOption("external", "External File (no link)")
                    .setValue(String(bo.sourcemap === undefined ? DEFAULT_PROJECT_BUILD_OPTIONS.sourcemap! : bo.sourcemap))
                    .onChange((value: string) => {
                        if (value === "inline" || value === "external") bo.sourcemap = value;
                        else bo.sourcemap = value === "true";
                    });
        });
        
        const targetSetting = new Setting(contentEl).setName('Target Environments').setDesc('Comma-separated (e.g., "chrome58,es2018").');
        const targetFeedbackEl = createDiv({ cls: 'setting-item-feedback' });
        targetSetting.controlEl.appendChild(targetFeedbackEl);
        targetSetting.addText(text => {
            this.inputRefs['target'] = { component: text, feedbackEl: targetFeedbackEl };
            const defaultTargetStr = Array.isArray(DEFAULT_PROJECT_BUILD_OPTIONS.target) ? DEFAULT_PROJECT_BUILD_OPTIONS.target.join(',') : DEFAULT_PROJECT_BUILD_OPTIONS.target!;
            const currentTargetStr = Array.isArray(bo.target) ? bo.target.join(',') : (bo.target || '');
            text.setPlaceholder(defaultTargetStr).setValue(currentTargetStr)
                .onChange(value => {
                    const trimmed = value.trim();
                    let isValid = true;
                    let message = '';
                    if (!trimmed) {
                        bo.target = DEFAULT_PROJECT_BUILD_OPTIONS.target;
                        message = 'Using default target.';
                    } else {
                        const parts = trimmed.split(',').map(s => s.trim()).filter(s => s);
                        // A safe but permissive regex for esbuild targets like 'es2020' or 'node14.5'
                        if (parts.some(p => !/^[a-z0-9.-]+$/i.test(p))) {
                            isValid = false;
                            message = 'Invalid characters in target.';
                            bo.target = DEFAULT_PROJECT_BUILD_OPTIONS.target;
                        } else {
                            bo.target = parts.length > 1 ? parts : parts[0];
                            message = '✓ Valid';
                        }
                    }
                    this._updateFeedback(targetFeedbackEl, isValid, message);
                    text.inputEl.toggleClass('in-app-builder-input-error', !isValid);
                });
        });

        new Setting(contentEl).setName('Format').addDropdown(dd => {
            this.inputRefs['format'] = { component: dd };
            dd.addOption('cjs', 'CommonJS (cjs)').addOption('esm', 'ES Modules (esm)').addOption('iife', 'IIFE (iife)')
              .setValue(bo.format || DEFAULT_PROJECT_BUILD_OPTIONS.format!).onChange(value => bo.format = value as EsbuildFormat);
        });
        new Setting(contentEl).setName('Platform').addDropdown(dd => {
            this.inputRefs['platform'] = { component: dd };
            dd.addOption('browser', 'Browser').addOption('node', 'Node.js').addOption('neutral', 'Neutral')
              .setValue(bo.platform || DEFAULT_PROJECT_BUILD_OPTIONS.platform!).onChange(value => bo.platform = value as EsbuildPlatform);
        });

        contentEl.createEl('h4', { text: 'Advanced Customization' });
        this._createJsonTextAreaSetting(contentEl, 'Define (Global Constants)', 'JSON: {"key": "value"} for global replacements.', 'e.g., {"API_KEY": "\\"123\\"}"}', 'define');
        
        const resolveExtSetting = new Setting(contentEl).setName('Resolve Extensions').setDesc('Comma-separated (e.g., ".ts,.js").');
        const resolveExtFeedbackEl = createDiv({ cls: 'setting-item-feedback' });
        resolveExtSetting.controlEl.appendChild(resolveExtFeedbackEl);
        resolveExtSetting.addText(text => {
            this.inputRefs['resolveExtensions'] = { component: text, feedbackEl: resolveExtFeedbackEl };
            const defaultExtStr = DEFAULT_PROJECT_BUILD_OPTIONS.resolveExtensions!.join(',');
            text.setPlaceholder(defaultExtStr).setValue(bo.resolveExtensions ? bo.resolveExtensions.join(',') : '')
                .onChange(value => {
                    const trimmed = value.trim();
                    let isValid = true;
                    let message = '';
                    if (!trimmed) {
                        bo.resolveExtensions = DEFAULT_PROJECT_BUILD_OPTIONS.resolveExtensions;
                        message = 'Using default extensions.';
                    } else {
                        const parts = trimmed.split(',').map(s => s.trim()).filter(s => s);
                        if (parts.some(p => !p.startsWith('.') || p.length < 2)) {
                            isValid = false;
                            message = 'Each extension must start with ".".';
                            bo.resolveExtensions = DEFAULT_PROJECT_BUILD_OPTIONS.resolveExtensions;
                        } else {
                            bo.resolveExtensions = parts;
                            message = '✓ Valid';
                        }
                    }
                     this._updateFeedback(resolveExtFeedbackEl, isValid, message);
                     text.inputEl.toggleClass('in-app-builder-input-error', !isValid);
                });
        });

        this._createJsonTextAreaSetting(contentEl, 'Loaders (File Extension to Loader)', 'JSON: {".ext": "loader"} for custom loaders.', 'e.g., {".mydata": "text"}', 'loader');

        const externalSetting = new Setting(contentEl).setName('External Modules').setDesc('Comma-separated module names to exclude.');
        const externalFeedbackEl = createDiv({ cls: 'setting-item-feedback' });
        externalSetting.controlEl.appendChild(externalFeedbackEl);
        externalSetting.addText(text => {
            this.inputRefs['external'] = { component: text, feedbackEl: externalFeedbackEl };
            const defaultExtStr = DEFAULT_PROJECT_BUILD_OPTIONS.external!.join(',');
            text.setPlaceholder(defaultExtStr).setValue(bo.external ? bo.external.join(',') : '')
                .onChange(value => {
                    const trimmed = value.trim();
                     let isValid = true;
                     let message = '';
                    if (!trimmed) {
                        bo.external = DEFAULT_PROJECT_BUILD_OPTIONS.external;
                        message = 'Using default external modules.';
                    } else {
                        const parts = trimmed.split(',').map(s => s.trim());
                        // Regex for valid package names, including scoped packages.
                        if (parts.some(p => !p || !/^[a-z0-9@_./-]+$/i.test(p))) {
                            isValid = false;
                            message = 'Contains invalid module names.';
                            bo.external = DEFAULT_PROJECT_BUILD_OPTIONS.external;
                        } else {
                            bo.external = parts.filter(p => p);
                            message = '✓ Valid';
                        }
                    }
                    this._updateFeedback(externalFeedbackEl, isValid, message);
                    text.inputEl.toggleClass('in-app-builder-input-error', !isValid);
                });
        });
    }

    /** Renders the dynamic list of external CDN dependencies. */
    private _renderExternalDependencies(contentEl: HTMLElement): void {
        contentEl.createEl('h3', { text: 'External CDN Dependencies' });
        contentEl.createEl('p', { text: "List external JS libraries from CDNs.", cls: 'setting-item-description' });

        const dependenciesEl = contentEl.createDiv({ cls: 'dependencies-list' });
        const renderDependencies = () => {
            dependenciesEl.empty();
            (this.project.dependencies || []).forEach((dep, index) => {
                const depItemEl = dependenciesEl.createDiv({ cls: 'dependency-item setting-item' });
                const controlsEl = depItemEl.createDiv({ cls: 'setting-item-control in-app-builder-dependency-controls' });
                const feedbackEl = createDiv({ cls: 'setting-item-feedback', style: 'width: 100%; margin-top: 0;' });

                const nameInput = new TextComponent(controlsEl).setPlaceholder('Module Name (e.g., moment)').setValue(dep.name);
                const urlInput = new TextComponent(controlsEl).setPlaceholder('Full HTTPS/HTTP URL').setValue(dep.url);
                
                const validateDepPair = () => {
                    dep.name = nameInput.getValue().trim();
                    dep.url = urlInput.getValue().trim();
                    const validation = validateDependency(dep);
                    if ((dep.name && !dep.url) || (!dep.name && dep.url) || (dep.name && dep.url && !validation.valid)) {
                        this._updateFeedback(feedbackEl, false, validation.error || "Both name and URL are required.");
                    } else if (dep.name && dep.url && validation.valid) {
                        this._updateFeedback(feedbackEl, true, "✓ Valid");
                    } else {
                        feedbackEl.setText('');
                    }
                    nameInput.inputEl.toggleClass('in-app-builder-input-error', !!(feedbackEl.textContent && !validation.valid && dep.name));
                    urlInput.inputEl.toggleClass('in-app-builder-input-error', !!(feedbackEl.textContent && !validation.valid && dep.url));
                };

                nameInput.onChange(validateDepPair);
                urlInput.onChange(validateDepPair);
                
                new ButtonComponent(controlsEl).setIcon('trash').setTooltip('Remove Dependency').onClick(() => {
                    this.project.dependencies!.splice(index, 1);
                    renderDependencies();
                });
                depItemEl.appendChild(feedbackEl);
                validateDepPair();
            });
        };
        if (!this.project.dependencies) this.project.dependencies = [];
        renderDependencies();

        new Setting(contentEl).addButton(button => button.setButtonText('Add CDN Dependency').onClick(() => {
            if (!this.project.dependencies) this.project.dependencies = [];
            this.project.dependencies.push({ name: '', url: '' });
            renderDependencies();
        }));
    }

    /** Renders advanced settings like logging level. */
    private _renderAdvancedSettings(contentEl: HTMLElement): void {
        contentEl.createEl('h3', { text: 'Logging' });
        new Setting(contentEl).setName('Build Log Level').setDesc('Verbosity of logs for this project\'s build process.').addDropdown(dropdown => {
            this.inputRefs['logLevel'] = { component: dropdown };
            dropdown.addOption('error', 'Error').addOption('warn', 'Warning').addOption('info', 'Info (Default)').addOption('verbose', 'Verbose (Debug)').addOption('silent', 'Silent')
                    .setValue(this.project.logLevel || DEFAULT_PROJECT_LOG_LEVEL).onChange((value: string) => this.project.logLevel = value as LogLevel);
        });
    }
    
    /**
     * A robust method to check if the entire form is valid.
     * It programmatically triggers all `onChange` handlers to ensure state is current,
     * then inspects the DOM for any visible error indicators.
     * @returns `true` if all fields are valid, `false` otherwise.
     */
    private _validateAllFields(): boolean {
        let allValid = true;

        // Programmatically trigger validation for all registered inputs to update their state.
        Object.values(this.inputRefs).forEach(ref => {
            if (ref.component instanceof TextComponent || ref.component instanceof TextAreaComponent) {
                // `onChanged` is the method on TextComponent/TextAreaComponent that triggers the `onChange` handler.
                ref.component.onChanged();
            }
        });

        // Check the DOM for any visible error states. This is more robust than checking a list of fields.
        this.contentEl.querySelectorAll('.in-app-builder-input-error').forEach(_ => {
            allValid = false;
        });
        
        // Also check feedback elements that might show an error without styling the input itself.
        this.contentEl.querySelectorAll('.setting-item-feedback-error').forEach(el => {
            if (el.textContent?.trim()) {
                allValid = false;
            }
        });

        // Final check on the entire buildOptions object as a safeguard.
        const buildOptionIssues: string[] = [];
        if (!isValidBuildOptions(this.project.buildOptions, buildOptionIssues)) {
            allValid = false;
            this.logger.log('warn', 'Modal validation failed on final isValidBuildOptions check.', buildOptionIssues);
        }

        return allValid;
    }

    /** Renders the final action buttons (Save/Add, Cancel). */
    private _renderActionButtons(contentEl: HTMLElement): void {
        new Setting(contentEl).addButton(button => button
            .setButtonText(this.isNewProject ? 'Add Project' : 'Save Changes')
            .setCta()
            .onClick(async () => {
                if (!this._validateAllFields()) {
                    new Notice('Please correct the errors in the form before submitting.', 7000);
                    return;
                }
                
                // Final cleanup before submitting.
                this.project.dependencies = (this.project.dependencies || []).filter(dep => dep.name && dep.url && validateDependency(dep).valid);
                this.project.buildOptions = { ...DEFAULT_PROJECT_BUILD_OPTIONS, ...this.project.buildOptions };
                this.project.logLevel = this.project.logLevel || DEFAULT_PROJECT_LOG_LEVEL;

                await this.onSubmit(this.project);
                this.close();
            }));
    }

    onClose(): void {
        this.contentEl.empty();
        this.inputRefs = {};
    }
}
