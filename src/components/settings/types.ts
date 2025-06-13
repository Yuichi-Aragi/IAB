/**
 * @file Defines shared types for the settings UI components.
 */

import { NewProjectSettings, ProjectSettings, PluginSettings } from '../../types';

/**
 * A mapping of command types to their payload structures, used for type-safe
 * command dispatching from the settings UI.
 */
export type CommandPayloadMap = {
    REINITIALIZE_ESBUILD: { initiatorId: string };
    CLEAR_CACHE: {};
    ADD_PROJECT: { projectData: NewProjectSettings };
    UPDATE_PROJECT: { projectData: ProjectSettings };
    REMOVE_PROJECT: { projectId: string };
    BUILD_PROJECT: { projectId: string; initiator: string };
    COPY_DIAGNOSTICS: { projectId: string };
    SAVE_SETTINGS: { settings: PluginSettings };
};
