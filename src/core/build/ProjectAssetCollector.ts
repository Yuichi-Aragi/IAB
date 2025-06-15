import { TFile, TFolder } from 'obsidian';
import { FileService } from '../../services/FileService';
import { Logger } from '../../utils/Logger';
import { VaultPathResolver } from '../../utils/VaultPathResolver';
import { BuildContext } from './BuildContext';
import { BuildProcessError, FileSystemError, PluginError, ProjectValidationError, createChainedMessage } from '../../errors/CustomErrors';
import { calculateStringHashSHA256, calculateStringHashFNV1aSync, detectProblematicCharacters } from '../../utils/FileContentUtils';
import { hasLoggedHashFallbackWarning, setHashFallbackWarningLogged } from '../../constants/state';
import { DEFAULT_HASH_FALLBACK_WARNING_MESSAGE, MAX_SOURCE_FILE_SIZE_BYTES, DEFAULT_PROJECT_BUILD_OPTIONS } from '../../constants';
import { isValidVaultPath, isValidRelativeFilePath } from '../../utils/ValidationUtils';

export class ProjectAssetCollector {
    private fileService: FileService;
    private logger: Logger;
    private isUsingHashFallback: boolean = false;
    private readonly MAX_TOTAL_PROJECT_SIZE_BYTES = 100 * 1024 * 1024; // 100 MB hard cap

    constructor(fileService: FileService, logger: Logger) {
        this.fileService = fileService;
        this.logger = logger;

        if (typeof window === 'undefined' || !window.crypto?.subtle) {
            this.isUsingHashFallback = true;
            if (!hasLoggedHashFallbackWarning()) {
                this.logger.log('warn', DEFAULT_HASH_FALLBACK_WARNING_MESSAGE);
                setHashFallbackWarningLogged();
            }
        }
    }

    public async collect(context: BuildContext): Promise<void> {
        context.updateProgress(5, "Validating project structure...");
        context.logAnalysis('verbose', 'Starting asset collection: Validating project structure.');
        const project = context.diagnostics.projectSettings;
        this._validateProjectPathsOrThrow(project);

        const projectBasePath = project.path === '.' ? '' : VaultPathResolver.normalize(project.path);
        const projectPathForFileService = project.path === '.' ? this.fileService.getVaultRoot().path : VaultPathResolver.normalize(project.path);

        if (!(await this.fileService.exists(projectPathForFileService))) {
            const err = new FileSystemError(`Project path '${project.path}' (resolved: '${projectPathForFileService}') does not exist.`, undefined, { path: projectPathForFileService });
            context.logAnalysis('error', err.message, err);
            throw err;
        }
        context.logAnalysis('verbose', `Project path '${projectPathForFileService}' exists.`);

        if (project.path !== '.') {
            const projectFolder = this.fileService.getAbstractFileByPath(projectPathForFileService);
            if (!(projectFolder instanceof TFolder)) {
                const err = new FileSystemError(`Project path '${project.path}' (resolved: '${projectPathForFileService}') is not a folder.`, undefined, { path: projectPathForFileService });
                context.logAnalysis('error', err.message, err);
                throw err;
            }
        }
        context.cancellationToken.throwIfCancelled();

        context.updateProgress(10, "Locating entry point...");
        const entryPointFullPath = VaultPathResolver.join(projectBasePath, project.entryPoint);
        const entryFile = this.fileService.getAbstractFileByPath(entryPointFullPath);
        if (!(entryFile instanceof TFile)) {
            const err = new FileSystemError(`Entry point '${project.entryPoint}' not found at '${entryPointFullPath}'.`, undefined, { path: entryPointFullPath });
            context.logAnalysis('error', err.message, err);
            throw err;
        }
        context.logAnalysis('verbose', `Entry point found at '${entryPointFullPath}'.`);

        const filesToRead = await this._scanProjectFiles(context);
        context.cancellationToken.throwIfCancelled();
        
        await this._readFilesToContext(context, filesToRead);
        
        const effectiveEntryPointKey = this._normalizeVirtualPath(project.entryPoint);
        if (!context.projectFileAssets[effectiveEntryPointKey] || context.projectFileAssets[effectiveEntryPointKey].fileReadError) {
            const entryAsset = context.projectFileAssets[effectiveEntryPointKey];
            const baseError = entryAsset?.fileReadError ?? new BuildProcessError(`CRITICAL: Entry point content for '${effectiveEntryPointKey}' (Path: ${entryPointFullPath}) was not loaded.`);
            const err = new BuildProcessError(createChainedMessage(`CRITICAL: Entry point '${effectiveEntryPointKey}' (Path: ${entryPointFullPath}) could not be read.`, baseError), baseError, { path: entryPointFullPath, critical: true });
            context.logAnalysis('error', err.message, err);
            throw err;
        }
        this.logger.log('verbose', `[${project.name}] Collected and processed ${Object.keys(context.projectFileAssets).length} project files.`);
        context.logAnalysis('info', `Asset collection complete. Found ${Object.keys(context.projectFileAssets).length} relevant project files.`);
    }

    private _validateProjectPathsOrThrow(project: ProjectSettings): void {
        if (!isValidVaultPath(project.path)) throw new ProjectValidationError(`Invalid project path: "${project.path}".`, undefined, { projectId: project.id, field: 'path', value: project.path });
        if (!isValidRelativeFilePath(project.entryPoint)) throw new ProjectValidationError(`Invalid entry point: "${project.entryPoint}".`, undefined, { projectId: project.id, field: 'entryPoint', value: project.entryPoint });
        if (!isValidRelativeFilePath(project.outputFile)) throw new ProjectValidationError(`Invalid output file: "${project.outputFile}".`, undefined, { projectId: project.id, field: 'outputFile', value: project.outputFile });
    }

    private async _scanProjectFiles(context: BuildContext): Promise<{ file: TFile, virtualPath: string }[]> {
        context.updateProgress(15, "Scanning project files...");
        context.logAnalysis('verbose', 'Starting project file scan.');
        const project = context.diagnostics.projectSettings;
        const projectPathForFileService = project.path === '.' ? this.fileService.getVaultRoot().path : VaultPathResolver.normalize(project.path);
        const relevantExtensions = project.buildOptions?.resolveExtensions || DEFAULT_PROJECT_BUILD_OPTIONS.resolveExtensions;
        const checkExtensions = relevantExtensions.map(ext => ext.startsWith('.') ? ext.substring(1).toLowerCase() : ext.toLowerCase());
        const filesToRead: { file: TFile, virtualPath: string }[] = [];

        interface CollectQueueItem { pathInVault: string; relativeToProjectRoot: string; isInNodeModules: boolean; }
        const queue: CollectQueueItem[] = [{ pathInVault: projectPathForFileService, relativeToProjectRoot: '.', isInNodeModules: false }];
        const visitedFolders = new Set<string>();
        let scannedCount = 0;

        while (queue.length > 0) {
            context.cancellationToken.throwIfCancelled();
            const currentItem = queue.shift()!;
            const normalizedCurrentPathInVault = VaultPathResolver.normalize(currentItem.pathInVault);
            if (visitedFolders.has(normalizedCurrentPathInVault)) continue;
            const abstractCurrent = this.fileService.getAbstractFileByPath(normalizedCurrentPathInVault);
            if (!(abstractCurrent instanceof TFolder)) continue;
            visitedFolders.add(normalizedCurrentPathInVault);
            scannedCount++;
            if (scannedCount % 10 === 0) {
                context.updateProgress(15 + Math.min(20, Math.floor(scannedCount / 20)), `Scanning directories (${scannedCount} scanned)`);
                context.logAnalysis('verbose', `Scanning directory: ${normalizedCurrentPathInVault}`);
            }

            for (const child of abstractCurrent.children) {
                const childRelativePath = this._normalizeVirtualPath(VaultPathResolver.join(currentItem.relativeToProjectRoot, child.name));
                if (child instanceof TFile) {
                    const extension = child.extension?.toLowerCase();
                    if (extension && checkExtensions.includes(extension)) filesToRead.push({ file: child, virtualPath: childRelativePath });
                } else if (child instanceof TFolder) {
                    const childNameLower = child.name.toLowerCase();
                    const standardExclusions = ['.git', '.obsidian', '.trash', 'target', 'dist', 'Build', 'out'];
                    const nodeModulesExclusions = ['test', 'tests', 'doc', 'docs', 'example', 'examples', '__tests__', 'fixture', 'fixtures', 'script', 'scripts', 'benchmark', 'benchmarks', 'jest', 'eslint', 'prettier', '.bin'];
                    const isStandardExclusion = standardExclusions.includes(childNameLower);
                    const isNodeModuleSubExclusion = currentItem.isInNodeModules && (childNameLower.startsWith('.') || nodeModulesExclusions.includes(childNameLower));
                    const isOtherDotFolder = childNameLower.startsWith('.') && childNameLower !== '.node_modules';
                    
                    if (!isStandardExclusion && !isNodeModuleSubExclusion && !isOtherDotFolder) {
                        queue.push({ pathInVault: child.path, relativeToProjectRoot: childRelativePath, isInNodeModules: currentItem.isInNodeModules || child.name === 'node_modules' });
                    } else {
                        context.logAnalysis('verbose', `Excluding directory from scan: ${child.path}`);
                    }
                }
            }
        }
        context.logAnalysis('verbose', `File scan complete. Found ${filesToRead.length} potentially relevant files.`);
        return filesToRead;
    }

    private async _readFilesToContext(context: BuildContext, filesToRead: { file: TFile, virtualPath: string }[]): Promise<void> {
        context.updateProgress(35, "Reading project files content...");
        context.logAnalysis('verbose', `Reading content for ${filesToRead.length} files.`);
        let totalSize = 0;
        for (let i = 0; i < filesToRead.length; i++) {
            context.cancellationToken.throwIfCancelled();
            const item = filesToRead[i];
            const virtualPathKey = item.virtualPath; 
            if (context.projectFileAssets[virtualPathKey]) continue;
            try {
                const content = await this.fileService.readFile(item.file.path);
                totalSize += content.length;
                if (totalSize > this.MAX_TOTAL_PROJECT_SIZE_BYTES) {
                    const err = new BuildProcessError(`Project source size exceeds the maximum limit of ${this.MAX_TOTAL_PROJECT_SIZE_BYTES / 1024 / 1024} MB.`, undefined, { totalSize, limit: this.MAX_TOTAL_PROJECT_SIZE_BYTES });
                    context.logAnalysis('error', err.message, err);
                    throw err;
                }
                if (content.length > MAX_SOURCE_FILE_SIZE_BYTES) {
                    const msg = `Large source file detected: ${item.file.path}`;
                    context.logAnalysis('warn', msg, { size: content.length, limit: MAX_SOURCE_FILE_SIZE_BYTES });
                    this.logger.log('warn', `[${context.diagnostics.projectName}] ${msg}, Size: ${content.length} bytes.`);
                }
                const problematicChars = detectProblematicCharacters(content);
                if (problematicChars.length > 0) {
                    const msg = `File '${item.file.path}' contains problematic Unicode characters.`;
                    const details = problematicChars.map(pc => `${pc.name} (U+${pc.code.toString(16)}) at index ${pc.index}`).join(', ');
                    context.logAnalysis('warn', msg, { details, problematicChars });
                    this.logger.log('warn', `[${context.diagnostics.projectName}] ${msg}: ${details}`);
                }
                const hash = await this._calculateFileContentHash(content, item.file.path);
                context.projectFileAssets[virtualPathKey] = { content, initialHash: hash, path: virtualPathKey };
                context.logAnalysis('verbose', `Read file: ${item.file.path}`, { virtualPath: virtualPathKey, size: content.length, hash });
            } catch (readError: unknown) {
                const fileReadError = readError instanceof PluginError ? readError : new FileSystemError(createChainedMessage(`Failed to read project file: ${item.file.path}`, readError), readError instanceof Error ? readError : undefined, { path: item.file.path });
                context.projectFileAssets[virtualPathKey] = { content: '', initialHash: '', path: virtualPathKey, fileReadError };
                context.logAnalysis('error', `Failed to read file '${item.file.path}' (Virtual: ${virtualPathKey}).`, fileReadError);
                this.logger.log('error', `[${context.diagnostics.projectName}] Failed to read file '${item.file.path}' (Virtual: ${virtualPathKey}). Error:`, fileReadError.message);
                if (virtualPathKey === this._normalizeVirtualPath(context.diagnostics.projectSettings.entryPoint)) {
                    const err = new BuildProcessError(createChainedMessage(`CRITICAL: Failed to read entry point file: ${item.file.path}.`, fileReadError), fileReadError, { criticalFile: virtualPathKey });
                    context.logAnalysis('error', err.message, err);
                    throw err;
                }
            }
            if (filesToRead.length > 0) context.updateProgress(35 + Math.round(((i + 1) / filesToRead.length) * 20), `Reading files (${i + 1}/${filesToRead.length})`);
        }
        context.diagnostics.projectFileAssets = context.projectFileAssets;
    }

    private _normalizeVirtualPath(path: string): string {
        let key = VaultPathResolver.normalize(path);
        if (key.startsWith('./')) key = key.substring(2);
        if (key.startsWith('/')) key = key.substring(1);
        return key;
    }

    private async _calculateFileContentHash(content: string, filePathForLog: string): Promise<string> {
        if (this.isUsingHashFallback) return calculateStringHashFNV1aSync(content);
        try {
            return await calculateStringHashSHA256(content);
        } catch (hashError: unknown) {
            this.logger.log('warn', `[${filePathForLog}] SHA-256 hashing failed, falling back to FNV-1a for this file. Error:`, hashError);
            this.isUsingHashFallback = true;
            if (!hasLoggedHashFallbackWarning()) {
                 this.logger.log('warn', DEFAULT_HASH_FALLBACK_WARNING_MESSAGE);
                 setHashFallbackWarningLogged();
            }
            return calculateStringHashFNV1aSync(content);
        }
    }
}