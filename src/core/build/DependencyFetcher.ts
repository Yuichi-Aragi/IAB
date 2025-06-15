import { NetworkService } from '../../services/NetworkService';
import { Logger } from '../../utils/Logger';
import { BuildContext } from './BuildContext';
import { BuildProcessError, NetworkError, createChainedMessage } from '../../errors/CustomErrors';

interface ExternalDepCacheEntry {
    content: string;
    fetchedAt: number;
}

export class DependencyFetcher {
    private networkService: NetworkService;
    private logger: Logger;
    private externalDependencyCache: Map<string, ExternalDepCacheEntry> = new Map();
    private readonly EXTERNAL_DEP_CACHE_TTL_MS = 1000 * 60 * 30; // 30 minutes cache

    constructor(networkService: NetworkService, logger: Logger) {
        this.networkService = networkService;
        this.logger = logger;
    }

    public async fetch(context: BuildContext): Promise<void> {
        context.updateProgress(55, "Fetching external dependencies...");
        context.logAnalysis('verbose', 'Starting external dependency fetch.');
        const project = context.diagnostics.projectSettings;
        const cdnModuleNameToUrl: Record<string, string> = {};

        if (project.dependencies && project.dependencies.length > 0) {
            for (let i = 0; i < project.dependencies.length; i++) {
                context.cancellationToken.throwIfCancelled();
                const dep = project.dependencies[i];
                if (!dep.name || !dep.url || dep.name.toLowerCase() === 'obsidian') continue;

                cdnModuleNameToUrl[dep.name] = dep.url;
                const cached = this.externalDependencyCache.get(dep.url);
                if (cached && (Date.now() - cached.fetchedAt < this.EXTERNAL_DEP_CACHE_TTL_MS)) {
                    this.logger.log('info', `[${project.name}] Using cached dependency: ${dep.name} from ${dep.url}`);
                    context.logAnalysis('info', `Using cached dependency: ${dep.name}`, { url: dep.url });
                    context.externalDependenciesContent.set(dep.url, cached.content);
                    continue;
                }

                this.logger.log('info', `[${project.name}] Fetching dependency: ${dep.name} from ${dep.url}`);
                context.logAnalysis('info', `Fetching dependency: ${dep.name}`, { url: dep.url });
                context.updateProgress(55 + Math.round(((i + 1) / project.dependencies.length) * 5), `Fetching ${dep.name}...`);
                try {
                    const response = await this.networkService.requestUrlWithTimeout({ url: dep.url, method: 'GET' });
                    if (response.status === 200) {
                        const content = response.text;
                        context.externalDependenciesContent.set(dep.url, content);
                        this.externalDependencyCache.set(dep.url, { content, fetchedAt: Date.now() });
                    } else {
                        throw new NetworkError(`Failed to fetch dependency '${dep.name}' from ${dep.url}. Status: ${response.status}`, undefined, { url: dep.url, status: response.status });
                    }
                } catch (error: unknown) {
                    const depError = error instanceof NetworkError ? error : new NetworkError(createChainedMessage(`Error fetching dependency '${dep.name}'.`, error), error instanceof Error ? error : undefined, { url: dep.url });
                    context.logAnalysis('error', `Failed to fetch external dependency: ${dep.name}`, depError);
                    throw new BuildProcessError(createChainedMessage(`Failed to fetch external dependency: ${dep.name}.`, depError), depError, { dependencyName: dep.name });
                }
            }
        }
        context.diagnostics.cdnModuleNameToUrl = cdnModuleNameToUrl;
        this.logger.log('verbose', `[${project.name}] Processed ${project.dependencies?.length || 0} external dependencies.`);
        context.logAnalysis('info', `Finished processing ${project.dependencies?.length || 0} external dependencies.`);
    }
}