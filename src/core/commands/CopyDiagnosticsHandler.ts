/**
 * @file Implements the handler for the 'COPY_DIAGNOSTICS' command.
 *       This file defines a robust, transactional, and fault-tolerant operation
 *       that ensures diagnostic information can be retrieved by the user under all circumstances.
 *
 *       Core Principles:
 *       - **Transactional Integrity**: The `handle` method is structured as a formal,
 *         atomic operation with clear stages: acquire state, validate, attempt primary
 *         action (clipboard), execute fallback (modal), and finalize (publish event).
 *         This guarantees predictable behavior.
 *       - **Aggressive Defensive Programming**: All inputs, service states, and external
 *         APIs (`navigator.clipboard`) are validated upfront. It operates on a "zero-trust"
 *         basis for all external dependencies.
 *       - **Guaranteed Feedback Loop**: A `DIAGNOSTIC_COPIED` event is published in every
 *         possible outcome, ensuring the UI never gets stuck in an inconsistent state.
 *       - **Robust Fallback Mechanism**: If the clipboard API is unavailable or fails,
 *         the handler seamlessly transitions to displaying the information in a modal,
 *         ensuring the user's intent is always fulfilled.
 *       - **Resource-Aware**: Handles potentially massive diagnostic strings gracefully by
 *         truncating them for UI display to prevent performance bottlenecks, while
 *         making the full content available in the developer console.
 */

import { ICommandHandler, CopyDiagnosticsCommand } from '../../types/commands';
import { InAppBuilderPlugin } from '../InAppBuilderPlugin';
import { container, ServiceTokens } from '../../utils/DIContainer';
import { App, Modal } from 'obsidian';
import { EventBus } from '../../services/EventBus';
import { Logger } from '../../utils/Logger';
import { SettingsService } from '../../services/SettingsService';
import { PluginError } from '../../errors/CustomErrors';

/**
 * The maximum number of characters to display in the fallback modal's textarea
 * to prevent UI performance degradation with extremely large diagnostic strings.
 */
const MAX_CHARS_FOR_MODAL_DISPLAY = 10000;

export class CopyDiagnosticsHandler implements ICommandHandler<CopyDiagnosticsCommand> {
    public readonly commandType = 'COPY_DIAGNOSTICS';

    // --- Service Accessors ---
    // Services are resolved once per handle call to ensure the latest instances from the container.
    private get plugin(): InAppBuilderPlugin { return container.resolve<InAppBuilderPlugin>(ServiceTokens.Plugin); }
    private get app(): App { return this.plugin.app; }
    private get eventBus(): EventBus { return container.resolve<EventBus>(ServiceTokens.EventBus); }
    private get logger(): Logger { return container.resolve<Logger>(ServiceTokens.Logger); }
    private get settingsService(): SettingsService { return container.resolve<SettingsService>(ServiceTokens.SettingsService); }

    /**
     * Handles the command to copy diagnostic information for a project.
     * It attempts to copy to the clipboard and provides a modal fallback on failure.
     * @param command The command object containing the projectId.
     */
    public async handle(command: CopyDiagnosticsCommand): Promise<void> {
        try {
            // --- 1. State Acquisition & Validation ---
            if (!command?.payload?.projectId) {
                this.logger.log('error', 'CopyDiagnosticsHandler: Invalid command received. Payload or projectId is missing.', command);
                this._publishOutcome(false, 'Invalid command: Project ID was not provided.');
                return;
            }

            const { projectId } = command.payload;
            const project = this.settingsService.getSettings().projects.find(p => p.id === projectId);

            if (!project) {
                const message = `Project not found for diagnostics copy. ID: ${projectId}`;
                this.logger.log('warn', `CopyDiagnosticsHandler: ${message}`);
                this._publishOutcome(false, message);
                return;
            }

            const diagnosticInfo = this.plugin.getLastBuildDiagnosticInfo(projectId);

            if (!diagnosticInfo) {
                const message = `No diagnostic information available for the last build of "${project.name}". The build may have succeeded or has not been run yet.`;
                this._publishOutcome(false, message);
                return;
            }

            // --- 2. Attempt Primary Action (Clipboard) ---
            const clipboardAvailable = navigator?.clipboard?.writeText;
            if (clipboardAvailable) {
                try {
                    await navigator.clipboard.writeText(diagnosticInfo);
                    const message = `Diagnostic info for "${project.name}" copied to clipboard.`;
                    this._publishOutcome(true, message);
                    return; // Success, transaction complete.
                } catch (clipboardError: unknown) {
                    this.logger.log('warn', `CopyDiagnosticsHandler: Clipboard API failed for project "${project.name}". Falling back to modal.`, clipboardError);
                    // Fall through to the fallback mechanism.
                }
            } else {
                this.logger.log('warn', `CopyDiagnosticsHandler: Clipboard API (navigator.clipboard.writeText) is not available. Falling back to modal.`);
            }

            // --- 3. Execute Fallback Action (Modal) ---
            this._showDiagnosticsModal(project.name, diagnosticInfo);
            const fallbackMessage = `Could not copy to clipboard. Displaying diagnostics in a modal instead.`;
            this._publishOutcome(false, fallbackMessage);

        } catch (error: unknown) {
            // --- 4. Final Catch-All for Unexpected Errors ---
            const unexpectedError = error instanceof PluginError ? error : new PluginError('An unexpected error occurred while copying diagnostics.', error instanceof Error ? error : undefined);
            this.logger.log('error', 'CopyDiagnosticsHandler: An unexpected error occurred.', unexpectedError);
            this._publishOutcome(false, `An unexpected error occurred: ${unexpectedError.message}`);
        }
    }

    /**
     * Displays the diagnostic information in a pop-up modal.
     * Truncates very large content for UI performance and logs the full content.
     * @param projectName The name of the project for the modal title.
     * @param diagnosticInfo The full diagnostic string.
     */
    private _showDiagnosticsModal(projectName: string, diagnosticInfo: string): void {
        let contentForModal = diagnosticInfo;
        let modalMessage = "Could not automatically copy to clipboard. Please copy the information below:";

        if (diagnosticInfo.length > MAX_CHARS_FOR_MODAL_DISPLAY) {
            contentForModal = diagnosticInfo.substring(0, MAX_CHARS_FOR_MODAL_DISPLAY) + '\n\n... (Content truncated for display)';
            modalMessage += "\nNOTE: The content was truncated in this view due to its size. The full diagnostic report has been logged to the developer console.";
            this.logger.log('warn', `Diagnostic Info for "${projectName}" was too large for the modal and was truncated. Full content follows:\n${diagnosticInfo}`);
        }

        new Modal(this.app)
            .setTitle(`Diagnostic Info: ${projectName}`)
            .setContent(el => {
                el.createEl('p', { text: modalMessage });
                el.createEl('textarea', {
                    text: contentForModal,
                    attr: {
                        rows: 15,
                        style: "width: 100%; font-family: monospace; white-space: pre; word-wrap: break-word;",
                        readonly: true
                    }
                });
            })
            .open();
    }

    /**
     * Centralized method to publish the final outcome of the operation to the EventBus.
     * @param success Whether the primary action (clipboard copy) was successful.
     * @param message The user-facing message describing the outcome.
     */
    private _publishOutcome(success: boolean, message: string): void {
        this.eventBus.publish({
            type: 'DIAGNOSTIC_COPIED',
            payload: { success, message }
        });
    }
}
