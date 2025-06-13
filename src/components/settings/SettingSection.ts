/**
 * @file Abstract base class for all sections within the settings tab.
 *       Provides common dependencies and lifecycle hooks.
 */

import { App } from 'obsidian';
import { InAppBuilderPlugin } from '../../core/InAppBuilderPlugin';
import { CommandBus } from '../../services/CommandBus';
import { EventBus } from '../../services/EventBus';
import { SettingsService } from '../../services/SettingsService';
import { EsbuildService } from '../../core/EsbuildService';
import { container, ServiceTokens } from '../../utils/DIContainer';
import { PluginSettings } from '../../types';
import { CommandPayloadMap } from './types';

export abstract class SettingSection {
    protected app: App;
    protected plugin: InAppBuilderPlugin;
    protected unsubscribeCallbacks: (() => void)[] = [];

    constructor(app: App, plugin: InAppBuilderPlugin) {
        this.app = app;
        this.plugin = plugin;
    }

    // --- Service Accessors ---
    protected get commandBus(): CommandBus { return container.resolve<CommandBus>(ServiceTokens.CommandBus); }
    protected get eventBus(): EventBus { return container.resolve<EventBus>(ServiceTokens.EventBus); }
    protected get settingsService(): SettingsService { return container.resolve<SettingsService>(ServiceTokens.SettingsService); }
    protected get esbuildService(): EsbuildService { return container.resolve<EsbuildService>(ServiceTokens.EsbuildService); }
    protected get logger() { return this.plugin.logger; }

    // --- Lifecycle Methods ---

    /** Renders the section's UI into the container. */
    public abstract render(containerEl: HTMLElement): void;

    /** Loads initial data and subscribes to events. */
    public load(settings: PluginSettings): void { /* Optional to implement by subclasses */ }

    /** Unsubscribes from all events to prevent memory leaks. */
    public unload(): void {
        while (this.unsubscribeCallbacks.length > 0) {
            this.unsubscribeCallbacks.pop()?.();
        }
    }

    /**
     * Safely dispatches a command to the command bus.
     * @param type The type of the command.
     * @param payload The command's payload.
     * @throws Re-throws any error from the command bus for the caller to handle.
     */
    protected async _safeCommandDispatch<T extends keyof CommandPayloadMap>(type: T, payload: CommandPayloadMap[T]): Promise<void> {
        try {
            await this.commandBus.dispatch({ type, payload });
        } catch (e) {
            this.logger.log('error', `Command ${type} failed in settings section`, e);
            throw e; // Re-throw to be caught by UI logic (e.g., modal)
        }
    }
}
