import { App } from 'obsidian';
import { FileService } from '../../services/FileService';
import { Logger } from '../../utils/Logger';
import { BuildContext } from './BuildContext';
import { BuildProcessError, FileSystemError, PluginError, createChainedMessage } from '../../errors/CustomErrors';
import { VaultPathResolver } from '../../utils/VaultPathResolver';

export class OutputWriter {
    private app: App;
    private fileService: FileService;
    private logger: Logger;

    constructor(app: App, fileService: FileService, logger: Logger) {
        this.app = app;
        this.fileService = fileService;
        this.logger = logger;
    }

    public async write(context: BuildContext, code: string, sourceMapContent: string): Promise<string> {
        context.updateProgress(95, "Writing output files to vault...");
        context.setStatus('writing');

        const project = context.diagnostics.projectSettings;
        const projectBasePath = project.path === '.' ? '' : VaultPathResolver.normalize(project.path);
        const outputPath = VaultPathResolver.join(projectBasePath, project.outputFile);
        const vaultRootAbs = this.app.vault.getRoot().path === '/' ? '' : this.app.vault.getRoot().path;
        const absVaultOutputPath = VaultPathResolver.join(vaultRootAbs, outputPath);
        const absVaultProjectPath = VaultPathResolver.join(vaultRootAbs, projectBasePath);
        
        const isContained = project.path === '.' || VaultPathResolver.normalize(absVaultOutputPath).startsWith(VaultPathResolver.normalize(absVaultProjectPath));
        if (!isContained) throw new BuildProcessError(`Security: Output path "${outputPath}" is outside project directory "${project.path}".`, undefined, { outputPath, projectPath: project.path });

        try {
            let finalCode = code;
            if (project.buildOptions.sourcemap && sourceMapContent && project.buildOptions.sourcemap !== 'inline') {
                const mapFileNameOnly = VaultPathResolver.getFilename(project.outputFile) + '.map';
                const sourceMapPath = VaultPathResolver.join(VaultPathResolver.getParent(outputPath), mapFileNameOnly);
                finalCode = finalCode.replace(/\/\/# sourceMappingURL=.*/g, '').trimEnd() + `\n//# sourceMappingURL=${mapFileNameOnly}\n`;
                await this.fileService.writeFile(sourceMapPath, sourceMapContent);
                this.logger.log('info', `[${project.name}] Wrote source map to: ${sourceMapPath}`);
            }
            await this.fileService.writeFile(outputPath, finalCode);
            this.logger.log('info', `[${project.name}] Wrote bundled code to: ${outputPath}`);
            return outputPath;
        } catch (error: unknown) {
            const writeError = error instanceof PluginError ? error : new FileSystemError(createChainedMessage(`Error writing output for "${project.name}".`, error), error instanceof Error ? error : undefined);
            throw new BuildProcessError(createChainedMessage(`Failed to write output files for "${project.name}".`, writeError), writeError);
        }
    }
}
