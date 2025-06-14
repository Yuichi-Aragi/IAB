/**
 * @file Defines the core types for the Command Bus architecture. This file is the single
 *       source of truth for all possible state-mutating operations within the plugin.
 *
 *       Core Principles:
 *       - **Immutability**: All command and payload properties are `readonly`. Commands are
 *         data-transfer objects (DTOs) representing an intent to change state, not the state
 *         itself. They must not be mutated after creation.
 *       - **Explicitness**: Each command has a unique, descriptive `type` and a strongly-typed
 *         `payload`, eliminating ambiguity.
 *       - **Decoupling**: This structure decouples the "what" (the command) from the "how"
 *         (the command handler), which is fundamental to the plugin's architecture. It allows
 *         UI components to dispatch commands without knowing anything about the business logic
 *         that executes them.
 *       - **Type Safety**: The discriminated union pattern for `Command` ensures that any code
 *         handling a command can safely access the correct payload properties based on the
 *         `type` property, guaranteed by the TypeScript compiler.
 */

import { ProjectSettings, NewProjectSettings, PluginSettings, BuildInitiator } from './index';

// --- Individual Command Definitions ---
// For clarity and TSDoc, each command is defined as a separate type before being combined.

/** A command to initiate the build process for a specific project. */
export type BuildProjectCommand = {
    readonly type: 'BUILD_PROJECT';
    readonly payload: {
        readonly projectId: string;
        readonly initiator?: BuildInitiator;
    };
};

/** A command to add a new project configuration to the plugin settings. */
export type AddProjectCommand = {
    readonly type: 'ADD_PROJECT';
    readonly payload: {
        readonly projectData: NewProjectSettings;
    };
};

/** A command to update an existing project's configuration. */
export type UpdateProjectCommand = {
    readonly type: 'UPDATE_PROJECT';
    readonly payload: {
        readonly projectData: ProjectSettings;
    };
};

/** A command to remove a project configuration from the plugin settings. */
export type RemoveProjectCommand = {
    readonly type: 'REMOVE_PROJECT';
    readonly payload: {
        readonly projectId: string;
    };
};

/** A command to force a re-initialization of the esbuild service. */
export type ReinitializeEsbuildCommand = {
    readonly type: 'REINITIALIZE_ESBUILD';
    readonly payload: {
        readonly initiatorId: string;
    };
};

/** A command to copy the last build's diagnostic information for a project to the clipboard. */
export type CopyDiagnosticsCommand = {
    readonly type: 'COPY_DIAGNOSTICS';
    readonly payload: {
        readonly projectId: string;
    };
};

/** A command to save the entire plugin settings object. */
export type SaveSettingsCommand = {
    readonly type: 'SAVE_SETTINGS';
    readonly payload: {
        readonly settings: PluginSettings;
    };
};


/**
 * A discriminated union of all possible commands that can be dispatched through the CommandBus.
 * This is the central type for all state-changing actions in the plugin.
 */
export type Command =
    | BuildProjectCommand
    | AddProjectCommand
    | UpdateProjectCommand
    | RemoveProjectCommand
    | ReinitializeEsbuildCommand
    | CopyDiagnosticsCommand
    | SaveSettingsCommand;

/**
 * Defines the contract for a command handler. Each handler is a self-contained unit of business
 * logic responsible for executing a single type of command. This interface ensures that all
 * handlers are discoverable and executable by the CommandBus in a uniform way.
 *
 * @template T The specific `Command` subtype that this handler is responsible for.
 */
export interface ICommandHandler<T extends Command> {
    /**
     * The unique type of the command this handler can process. This property is used by the
     * CommandBus to map an incoming command to its correct handler. It must be `readonly`
     * to prevent runtime modification.
     */
    readonly commandType: T['type'];

    /**
     * The core logic for executing the command. This method is called by the CommandBus when
     * a matching command is dispatched. It is an `async` function to accommodate I/O operations
     * like file system access or network requests.
     *
     * @param command The command object, containing the `type` and `payload`. The payload is
     *                guaranteed by the type system to match the `commandType`.
     * @returns A promise that resolves with an `unknown` value. The return value is typically
     *          not used by the CommandBus itself, but can be passed back to the original
     *          dispatcher if needed. Using `unknown` is safer than `any` as it forces the
     *          caller to explicitly handle the type of the result. Many handlers will simply
     *          return `Promise<void>`.
     */
    handle(command: T): Promise<unknown>;
}