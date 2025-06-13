import { EsbuildService } from '../EsbuildService';
import { Logger } from '../../utils/Logger';
import { NetworkService } from '../../services/NetworkService';
import { BuildContext, ProjectFileAsset } from './BuildContext';
import { BuildProcessError } from '../../errors/CustomErrors';
import { VaultPathResolver } from '../../utils/VaultPathResolver';
import { getCharacterContext } from '../../utils/FileContentUtils';
import { ESBUILD_NAMESPACE_PROJECTFILE, ESBUILD_NAMESPACE_EXTERNALDEP, DEFAULT_PROJECT_BUILD_OPTIONS, ESBUILD_BUILD_TIMEOUT_MS, LOG_LEVEL_MAP } from '../../constants';
import { EsbuildPlugin, EsbuildPluginBuild, EsbuildOnResolveArgs, EsbuildOnResolveResult, EsbuildOnLoadArgs, EsbuildOnLoadResult, EsbuildError, EsbuildLoader, EsbuildLogLevel, BuildOptions, EsbuildBuildOptions, EsbuildResult } from '../../types';
import { calculateStringHashSHA256, calculateStringHashFNV1aSync } from '../../utils/FileContentUtils';

export class Compiler {
    private esbuildService: EsbuildService;
    private logger: Logger;
    private networkService: NetworkService;

    constructor(esbuildService: EsbuildService, logger: Logger, networkService: NetworkService) {
        this.esbuildService = esbuildService;
        this.logger = logger;
        this.networkService = networkService;
    }

    public async compile(context: BuildContext): Promise<{ outputCode: string, sourceMapContent: string }> {
        const successfullyReadProjectFileAssets: Record<string, ProjectFileAsset> = {};
        for (const key in context.projectFileAssets) {
            if (!context.projectFileAssets[key].fileReadError) {
                successfullyReadProjectFileAssets[key] = context.projectFileAssets[key];
            }
        }

        const inMemoryPlugin = this._createEsbuildPlugin(context, successfullyReadProjectFileAssets);
        const esbuildApi = this.esbuildService.getEsbuildAPI()!;
        const effectiveEntryPointKey = this._normalizeVirtualPath(context.diagnostics.projectSettings.entryPoint);
        const effectiveEsbuildOptions = this._configureEsbuildOptions(context, effectiveEntryPointKey, [inMemoryPlugin]);
        
        context.updateProgress(65, "Compiling with esbuild...");
        context.setStatus('compiling');

        const buildPromise = esbuildApi.build(effectiveEsbuildOptions);
        const timeoutPromise = new Promise<EsbuildResult>((_, reject) => {
            setTimeout(() => {
                reject(new BuildProcessError(`esbuild.build() call timed out after ${ESBUILD_BUILD_TIMEOUT_MS / 1000} seconds.`, undefined, { projectId: context.projectId, stage: 'esbuild_internal_timeout' }));
            }, ESBUILD_BUILD_TIMEOUT_MS);
        });
        const result: EsbuildResult = await Promise.race([buildPromise, timeoutPromise]);
        context.cancellationToken.throwIfCancelled();

        context.updateProgress(90, "Processing esbuild results...");
        this._handleEsbuildDiagnostics(context, result);

        if (!result.outputFiles || result.outputFiles.length === 0) {
            const criticalReadErrors = Object.values(context.projectFileAssets).filter(asset => asset.fileReadError && asset.path === effectiveEntryPointKey);
            if (criticalReadErrors.length > 0) {
                 throw new BuildProcessError(`Build produced no output. Entry point '${effectiveEntryPointKey}' could not be read. Error: ${criticalReadErrors[0].fileReadError?.message}`, criticalReadErrors[0].fileReadError, { projectId: context.projectId, entryPointReadFailure: true });
            }
            throw new BuildProcessError("Build completed but produced no output files from esbuild.", undefined, { projectId: context.projectId });
        }

        return this._extractOutputFromEsbuildResult(context, result);
    }

    private _createEsbuildPlugin(context: BuildContext, projectFileAssets: Record<string, ProjectFileAsset>): EsbuildPlugin {
        const inMemoryPluginResolveCache: Map<string, EsbuildOnResolveResult> = new Map();
        const project = context.diagnostics.projectSettings;
        const projectResolveExtensions = project.buildOptions?.resolveExtensions || DEFAULT_PROJECT_BUILD_OPTIONS.resolveExtensions;
        const cdnModuleNameToUrl = context.diagnostics.cdnModuleNameToUrl;
        
        return {
            name: 'obsidian-in-memory-resolver-loader',
            setup: (build: EsbuildPluginBuild) => {
                const logPlugin = (level: 'verbose' | 'info' | 'warn' | 'error', ...msgArgs: unknown[]) => {
                    const formattedMessage = msgArgs.map(arg => typeof arg === 'string' ? arg : JSON.stringify(arg, null, 2)).join(' ');
                    context.diagnostics.resolutionLogs.push(`[${new Date().toLocaleTimeString()}] [${level.toUpperCase()}] ${formattedMessage}`);
                    if (LOG_LEVEL_MAP[level] >= LOG_LEVEL_MAP[project.logLevel]) {
                        this.logger.log(level, `[${project.name}][esbuild-plugin]`, ...msgArgs);
                    }
                };

                const resolvePathWithExtensionsAndIndex = (basePath: string): string | null => {
                    const potentialExtensions = ['', ...projectResolveExtensions];
                    if (basePath !== '.' && basePath !== '/') { 
                        for (const ext of potentialExtensions) {
                            if (projectFileAssets.hasOwnProperty(basePath + ext)) return basePath + ext;
                        }
                    }
                    for (const ext of projectResolveExtensions) {
                        const indexPath = this._normalizeVirtualPath(VaultPathResolver.join(basePath, `index${ext}`));
                        if (projectFileAssets.hasOwnProperty(indexPath)) return indexPath;
                    }
                    return null;
                };

                build.onResolve({ filter: /^\.?\.?\// }, (args: EsbuildOnResolveArgs): EsbuildOnResolveResult => {
                    const cacheKey = `relative:${args.resolveDir}%%${args.importer}%%${args.path}`;
                    if (inMemoryPluginResolveCache.has(cacheKey)) return inMemoryPluginResolveCache.get(cacheKey)!;

                    let result: EsbuildOnResolveResult;
                    if (args.namespace === ESBUILD_NAMESPACE_PROJECTFILE || args.namespace === '') {
                        const combinedVirtualPath = this._normalizeVirtualPath(VaultPathResolver.join(args.resolveDir, args.path));
                        const resolvedAssetPath = resolvePathWithExtensionsAndIndex(combinedVirtualPath);
                        if (resolvedAssetPath) {
                            result = { path: resolvedAssetPath, namespace: ESBUILD_NAMESPACE_PROJECTFILE };
                            logPlugin('verbose', `Resolved relative import '${args.path}' from '${args.importer}' to project file '${resolvedAssetPath}'`);
                        } else {
                            const errorText = `Could not resolve relative import '${args.path}' from project file '${args.importer}'. Processed path: '${combinedVirtualPath}'.`;
                            logPlugin('warn', errorText);
                            result = { errors: [{ text: errorText } as EsbuildError] };
                        }
                    } else if (args.namespace === ESBUILD_NAMESPACE_EXTERNALDEP) {
                        try {
                            const newFullUrl = new URL(args.path, args.importer).href;
                            logPlugin('verbose', `Resolved relative import '${args.path}' from CDN importer '${args.importer}' to new URL: '${newFullUrl}'`);
                            result = { path: newFullUrl, namespace: ESBUILD_NAMESPACE_EXTERNALDEP, external: true };
                        } catch (e: unknown) {
                            const errorText = `Error constructing URL for relative CDN import: path='${args.path}', base='${args.importer}'. Error: ${e instanceof Error ? e.message : String(e)}`;
                            logPlugin('error', errorText);
                            result = { errors: [{ text: errorText } as EsbuildError] };
                        }
                    } else {
                        const errorText = `Unhandled namespace '${args.namespace}' for relative import '${args.path}' from '${args.importer}'.`;
                        logPlugin('error', errorText);
                        result = { errors: [{ text: errorText } as EsbuildError] };
                    }
                    inMemoryPluginResolveCache.set(cacheKey, result);
                    return result;
                });

                build.onResolve({ filter: /^[^./]/ }, (args: EsbuildOnResolveArgs): EsbuildOnResolveResult => {
                    const cacheKey = `bare:${args.path}`;
                    if (inMemoryPluginResolveCache.has(cacheKey)) return inMemoryPluginResolveCache.get(cacheKey)!;

                    if (args.kind === 'entry-point') {
                        const entryKey = this._normalizeVirtualPath(args.path);
                        if (projectFileAssets.hasOwnProperty(entryKey)) { 
                            return { path: entryKey, namespace: ESBUILD_NAMESPACE_PROJECTFILE }; 
                        }
                        return { errors: [{ text: `Entry point '${entryKey}' not found in project files.` } as EsbuildError] };
                    }
                    
                    const externalModules = project.buildOptions?.external || DEFAULT_PROJECT_BUILD_OPTIONS.external;
                    if (externalModules.includes(args.path)) { 
                        logPlugin('verbose', `Resolving '${args.path}' as external (from project settings).`); 
                        return { path: args.path, external: true }; 
                    }

                    if (cdnModuleNameToUrl.hasOwnProperty(args.path)) {
                        const initialUrl = cdnModuleNameToUrl[args.path];
                        logPlugin('verbose', `Resolving bare import '${args.path}' to initial CDN URL '${initialUrl}'.`);
                        return { path: initialUrl, namespace: ESBUILD_NAMESPACE_EXTERNALDEP, external: true };
                    }
                    
                    const nodeModulesLookupKey = this._normalizeVirtualPath(VaultPathResolver.join('node_modules', args.path));
                    const resolvedNodeModulePath = resolvePathWithExtensionsAndIndex(nodeModulesLookupKey);
                    if (resolvedNodeModulePath) { 
                        logPlugin('verbose', `Resolved bare import '${args.path}' to project file (node_modules): ${resolvedNodeModulePath}`); 
                        return { path: resolvedNodeModulePath, namespace: ESBUILD_NAMESPACE_PROJECTFILE }; 
                    }
                    
                    logPlugin('verbose', `Bare import '${args.path}' not resolved locally or as CDN. Marking as external.`); 
                    return { path: args.path, external: true };
                });

                build.onLoad({ filter: /.*/, namespace: ESBUILD_NAMESPACE_EXTERNALDEP }, async (args: EsbuildOnLoadArgs): Promise<EsbuildOnLoadResult> => {
                    if (context.externalDependenciesContent.has(args.path)) {
                        logPlugin('verbose', `Loading cached CDN content for URL: ${args.path}.`);
                        return { contents: context.externalDependenciesContent.get(args.path), loader: 'js' };
                    }
                    logPlugin('info', `Fetching uncached dynamic CDN content for URL: ${args.path}`);
                    try {
                        const response = await this.networkService.requestUrlWithTimeout({ url: args.path, method: 'GET' });
                        if (response.status === 200) {
                            const content = response.text;
                            context.externalDependenciesContent.set(args.path, content);
                            return { contents: content, loader: 'js' };
                        }
                        return { errors: [{ text: `Failed to fetch CDN content from ${args.path}. Status: ${response.status}` } as EsbuildError] };
                    } catch (error: unknown) {
                        return { errors: [{ text: `Network error fetching CDN content from ${args.path}: ${error instanceof Error ? error.message : String(error)}` } as EsbuildError] };
                    }
                });

                build.onLoad({ filter: /.*/, namespace: ESBUILD_NAMESPACE_PROJECTFILE }, async (args: EsbuildOnLoadArgs): Promise<EsbuildOnLoadResult> => {
                    const pathKey = args.path; 
                    if (projectFileAssets.hasOwnProperty(pathKey)) {
                        const asset = projectFileAssets[pathKey];
                        const currentHash = await this._calculateFileContentHash(asset.content);
                        if (currentHash !== asset.initialHash) {
                            const criticalErrorMsg = `CRITICAL: Content hash mismatch for ${pathKey} before esbuild load! Initial: ${asset.initialHash}, Current: ${currentHash}.`; logPlugin('error', criticalErrorMsg);
                            return { errors: [{ text: `Internal plugin error: Content integrity check failed for ${pathKey}.` } as EsbuildError] };
                        }
                        
                        const fileExtension = (VaultPathResolver.getExtension(pathKey) || '').toLowerCase();
                        const loader: EsbuildLoader = project.buildOptions?.loader?.[fileExtension] || (fileExtension === '.js' ? 'js' : fileExtension === '.jsx' ? 'jsx' : fileExtension === '.tsx' ? 'tsx' : 'ts');
                        
                        const esbuildResolveDir = VaultPathResolver.getParent(pathKey);
                        return { contents: asset.content, loader, resolveDir: esbuildResolveDir };
                    }
                    return { errors: [{ text: `File content not found for project path: '${pathKey}'. Check for earlier read errors.` } as EsbuildError] };
                });
            }
        };
    }

    private _configureEsbuildOptions(context: BuildContext, entryPointKey: string, plugins: EsbuildPlugin[]): EsbuildBuildOptions {
        const project = context.diagnostics.projectSettings;
        const mergedProjectBuildOptions: BuildOptions = {
            ...DEFAULT_PROJECT_BUILD_OPTIONS,
            ...project.buildOptions,
        };
        const esbuildLogLevel: EsbuildLogLevel = project.logLevel === 'verbose' ? 'debug' : project.logLevel === 'info' ? 'info' : project.logLevel === 'warn' ? 'warning' : project.logLevel === 'error' ? 'error' : 'silent';
        const options: EsbuildBuildOptions = {
            entryPoints: [entryPointKey],
            outfile: project.outputFile,
            bundle: mergedProjectBuildOptions.bundle,
            write: false,
            format: mergedProjectBuildOptions.format,
            platform: mergedProjectBuildOptions.platform,
            target: mergedProjectBuildOptions.target,
            sourcemap: mergedProjectBuildOptions.sourcemap,
            minify: mergedProjectBuildOptions.minify,
            minifyWhitespace: mergedProjectBuildOptions.minify ? mergedProjectBuildOptions.minifyWhitespace : undefined,
            minifyIdentifiers: mergedProjectBuildOptions.minify ? mergedProjectBuildOptions.minifyIdentifiers : undefined,
            minifySyntax: mergedProjectBuildOptions.minify ? mergedProjectBuildOptions.minifySyntax : undefined,
            define: mergedProjectBuildOptions.define,
            external: mergedProjectBuildOptions.external,
            resolveExtensions: mergedProjectBuildOptions.resolveExtensions,
            loader: mergedProjectBuildOptions.loader,
            plugins: plugins,
            absWorkingDir: '/',
            logLevel: esbuildLogLevel,
        };
        for (const key in options) if (options[key as keyof EsbuildBuildOptions] === undefined) delete options[key as keyof EsbuildBuildOptions];
        return options;
    }

    private _handleEsbuildDiagnostics(context: BuildContext, result: EsbuildResult): void {
        if (result.errors && result.errors.length > 0) {
            const errorHeader = `[${context.diagnostics.projectName}] esbuild reported ${result.errors.length} error(s):`;
            this.logger.log('error', errorHeader);
            let errorSummaryForException = "";

            result.errors.forEach((err, idx) => {
                this.logger.log('verbose', `[${context.diagnostics.projectName}] Raw esbuild error object ${idx + 1}:`, err);
                let detailedMessage = `--- Esbuild Error ${idx + 1} ---\nText: ${err.text}\n`;
                if (err.location) {
                    detailedMessage += `File: ${err.location.file}\nLine: ${err.location.line}, Column: ${err.location.column} (0-based)\n`;
                    const fileAsset = context.projectFileAssets[err.location.file]; 
                    if (fileAsset && !fileAsset.fileReadError) {
                        const { snippetLines, charInfo, hexDump } = getCharacterContext(fileAsset.content, err.location.column, 3, 15);
                        detailedMessage += `Original File Hash (${context.diagnostics.hashingMethod}): ${fileAsset.initialHash}\n`;
                        detailedMessage += `Code Snippet (L:${err.location.line}):\n${snippetLines.map(s => "  " + s).join('\n')}\n`;
                        detailedMessage += `Character Analysis (Col ${err.location.column + 1}): ${charInfo}\n`;
                        detailedMessage += `UTF-8 Hex Dump:\n${hexDump.split('\n').map(s => "  " + s).join('\n')}\n`;
                    }
                }
                context.diagnostics.esbuildOutput.errors.push(detailedMessage);
                if (idx < 1) errorSummaryForException = `${err.text.substring(0, 100)}... (File: ${err.location?.file || 'N/A'})`;
            });
            throw new BuildProcessError(`Build failed with ${result.errors.length} esbuild error(s). ${errorSummaryForException.trim()}`, undefined, { projectId: context.projectId, esbuildErrors: result.errors });
        }

        if (result.warnings && result.warnings.length > 0) {
            const warnHeader = `[${context.diagnostics.projectName}] esbuild reported ${result.warnings.length} warning(s):`;
            this.logger.log('warn', warnHeader);
            result.warnings.forEach((warn, idx) => {
                let detailedMessage = `--- Esbuild Warning ${idx + 1} ---\nText: ${warn.text}\n`;
                if (warn.location) detailedMessage += `File: ${warn.location.file}, Line: ${warn.location.line}, Col: ${warn.location.column}\n`;
                if (warn.location?.lineText) detailedMessage += `  Line Text (L${warn.location.line}): ${warn.location.lineText}\n`;
                warn.notes?.forEach(note => detailedMessage += `  Note: ${note.text}${note.location ? ` (at ${note.location.file}:${note.location.line})` : ''}\n`);
                context.diagnostics.esbuildOutput.warnings.push(detailedMessage);
                this.esbuildService.eventBus.publish({ type: 'BUILD_WARNING', payload: { projectId: context.projectId, warning: `Build Warning: ${warn.text.substring(0, 150)}...`, initiator: context.initiator } });
            });
        }
    }

    private _extractOutputFromEsbuildResult(context: BuildContext, result: EsbuildResult): { outputCode: string, sourceMapContent: string } {
        const outputFiles = result.outputFiles!;
        const project = context.diagnostics.projectSettings;
        const expectedOutfilePath = '/' + this._normalizeVirtualPath(project.outputFile);
        const jsOutput = outputFiles.find(f => f.path === expectedOutfilePath);
        if (!jsOutput) throw new BuildProcessError("No suitable JavaScript output found in esbuild result.", undefined, { projectId: project.id });
        const mapOutput = outputFiles.find(f => f.path === expectedOutfilePath + '.map');
        return { outputCode: jsOutput.text, sourceMapContent: mapOutput ? mapOutput.text : '' };
    }

    private _normalizeVirtualPath(path: string): string {
        let key = VaultPathResolver.normalize(path);
        if (key.startsWith('./')) key = key.substring(2);
        if (key.startsWith('/')) key = key.substring(1);
        return key;
    }

    private async _calculateFileContentHash(content: string): Promise<string> {
        if (typeof window === 'undefined' || !window.crypto?.subtle) {
            return calculateStringHashFNV1aSync(content);
        }
        try {
            return await calculateStringHashSHA256(content);
        } catch (hashError: unknown) {
            return calculateStringHashFNV1aSync(content);
        }
    }
}
