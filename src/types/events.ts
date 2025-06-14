/**
 * @file Defines the types for the Event Bus architecture. This file is the single source of
 *       truth for all possible events published by the core logic. Events represent facts
 *       about things that have already happened in the system.
 *
 *       Core Principles:
 *       - **Immutability**: All event and payload properties are `readonly`. Events are immutable
 *         records of past occurrences. They must not be mutated by any listener. This prevents
 *         side effects where one listener's actions could affect another.
 *       - **Explicitness**: Each event has a unique, descriptive `type` and a strongly-typed
 *         `payload`, ensuring clarity about what information is being broadcast.
 *       - **Decoupling**: The event system allows services to broadcast state changes without
 *         being coupled to the UI components or other services that need to react to them.
 *       - **Type Safety**: The discriminated union pattern for `AppEvent` allows subscribers
 *         to safely access the correct payload based on the `type` property, with compile-time
 *         guarantees from TypeScript.
 */

import { EsbuildInitializationError } from '../errors/CustomErrors';
import { ProjectSettings, PluginSettings, BuildInitiator } from './index';

/** The possible states of the esbuild service, broadcast via `EsbuildStatusChangedEvent`. */
export type EsbuildStatus = 'initializing' | 'initialized' | 'error' | 'uninitialized';

// --- Individual Event Definitions ---
// For clarity and TSDoc, each event is defined as a separate type before being combined.

/** Published when a project build is initiated. */
export type BuildStartedEvent = {
    readonly type: 'BUILD_STARTED';
    readonly payload: {
        readonly projectId: string;
        readonly initiator: BuildInitiator;
    };
};

/** Published periodically during a build to update on progress. */
export type BuildProgressEvent = {
    readonly type: 'BUILD_PROGRESS';
    readonly payload: {
        readonly projectId: string;
        readonly progress: number; // A number between 0 and 100
        readonly message: string;
        readonly initiator: BuildInitiator;
    };
};

/** Published when a project build completes successfully. */
export type BuildSucceededEvent = {
    readonly type: 'BUILD_SUCCEEDED';
    readonly payload: {
        readonly projectId: string;
        readonly outputPath: string;
        readonly initiator: BuildInitiator;
    };
};

/** Published when a project build fails with an error. */
export type BuildFailedEvent = {
    readonly type: 'BUILD_FAILED';
    readonly payload: {
        readonly projectId: string;
        readonly error: string; // A summary of the error message
        readonly initiator: BuildInitiator;
    };
};

/** Published when esbuild reports warnings during a build. */
export type BuildWarningEvent = {
    readonly type: 'BUILD_WARNING';
    readonly payload: {
        readonly projectId: string;
        readonly warning: string; // A summary of the warning message
        readonly initiator: BuildInitiator;
    };
};

/** Published whenever the status of the esbuild service changes. */
export type EsbuildStatusChangedEvent = {
    readonly type: 'ESBUILD_STATUS_CHANGED';
    readonly payload: {
        readonly status: EsbuildStatus;
        readonly error?: EsbuildInitializationError | null;
    };
};

/** Published whenever the plugin's settings have been successfully saved. */
export type SettingsChangedEvent = {
    readonly type: 'SETTINGS_CHANGED';
    readonly payload: {
        readonly newSettings: PluginSettings;
    };
};

/** Published after an attempt to copy build diagnostics to the clipboard. */
export type DiagnosticCopiedEvent = {
    readonly type: 'DIAGNOSTIC_COPIED';
    readonly payload: {
        readonly success: boolean;
        readonly message: string;
    };
};

/**
 * A discriminated union of all possible events that can be published on the EventBus.
 * This is the central type for all reactive state updates in the plugin.
 */
export type AppEvent =
    | BuildStartedEvent
    | BuildProgressEvent
    | BuildSucceededEvent
    | BuildFailedEvent
    | BuildWarningEvent
    | EsbuildStatusChangedEvent
    | SettingsChangedEvent
    | DiagnosticCopiedEvent;
