import { App, TFile, TFolder, Vault, normalizePath as obsidianNormalizePath, TAbstractFile } from 'obsidian';
import { Logger } from '../utils/Logger';
import { FileSystemError, createChainedMessage, PluginError } from '../errors/CustomErrors';
import { VaultPathResolver } from '../utils/VaultPathResolver';
import { container, ServiceTokens } from '../utils/DIContainer';

// --- Constants ---
const MAX_PATH_LENGTH = 1024; // A reasonable upper limit for path lengths.

// --- State Machine and Operation Queue ---

/**
 * Defines the operational states of the FileService.
 * - `idle`: The service is ready and not processing any write operations.
 * - `processing`: The service is actively processing a write operation from its queue.
 * - `unloading`: The service is shutting down. No new operations are accepted, and the queue is being cleared.
 */
type FileServiceState = 'idle' | 'processing' | 'unloading';

/**
 * Represents a write operation that is pending in the queue.
 * This ensures that all file modifications are serialized, preventing race conditions.
 */
interface QueuedOperation<T> {
    operation: () => Promise<T>;
    resolve: (value: T | PromiseLike<T>) => void;
    reject: (reason?: any) => void;
    description: string; // For logging purposes
}

/**
 * Provides a highly robust, resilient, and stateful service for all file system operations.
 * This service implements:
 * - A formal state machine (`idle`, `processing`, `unloading`) for predictable lifecycle management.
 * - A serialized write operation queue to eliminate internal race conditions (e.g., creating a folder and writing a file to it in quick succession).
 * - Graceful shutdown and cancellation of all queued write operations on plugin unload.
 * - Aggressive validation and defensive checks for all inputs and states.
 * - Resilient logic with retries for handling eventual consistency in Obsidian's file cache.
 */
export class FileService {
    private app: App;
    private vault: Vault;
    private readonly logger: Logger;

    private state: FileServiceState = 'idle';
    private readonly operationQueue: QueuedOperation<any>[] = [];
    private readonly textSourceExtensions = ['.ts', '.tsx', '.js', '.jsx', '.json', '.css', '.html', '.md', '.txt', '.yaml', '.yml'];

    constructor(app: App) {
        this.app = app;
        this.vault = app.vault;
        // Cache the logger instance to prevent resolution errors during unload.
        this.logger = container.resolve<Logger>(ServiceTokens.Logger);
        this.logger.log('verbose', 'FileService initialized.');
    }

    /**
     * Initiates a graceful shutdown of the service, to be called from the plugin's `onunload`.
     * - Sets the state to `unloading`.
     * - Rejects all queued write operations that have not yet started.
     */
    public unload(): void {
        if (this.state === 'unloading') {
            return;
        }
        this.logger.log('info', `FileService is unloading. Rejecting ${this.operationQueue.length} queued write operations.`);
        this.state = 'unloading';

        // Reject all operations that haven't started yet.
        while (this.operationQueue.length > 0) {
            const queuedItem = this.operationQueue.shift()!;
            const shutdownError = new FileSystemError('File operation cancelled due to service shutdown.', undefined, { operation: queuedItem.description, state: 'unloading' });
            queuedItem.reject(shutdownError);
        }
    }

    // --- PUBLIC READ API (Concurrent, does not use the queue) ---

    /**
     * Reads the content of a text file from the vault. Strips the Byte Order Mark (BOM) if present.
     * This is a read operation and does not use the write queue.
     * @param {string} filePath The vault-relative path to the file.
     * @returns {Promise<string>} A promise that resolves with the string content of the file.
     * @throws {FileSystemError} If the path is invalid, the file is not found, or reading fails.
     */
    public async readFile(filePath: string): Promise<string> {
        this._assertServiceIsRunning('readFile');
        this._validatePathInput(filePath, 'readFile');

        const normalizedPath = VaultPathResolver.normalize(filePath);
        const file = this.vault.getAbstractFileByPath(normalizedPath);

        if (!(file instanceof TFile)) {
            throw new FileSystemError(`File not found or is not a TFile: ${normalizedPath}`, undefined, { path: normalizedPath, operation: 'readFile', fileType: file ? file.constructor.name : 'NotFound' });
        }

        // --- Attempt 1: Standard Vault API (cachedRead) ---
        try {
            const content = await this.vault.cachedRead(file);
            this.logger.log('verbose', `Successfully read file via Vault API: ${normalizedPath}`);
            return this._stripBom(content, normalizedPath);
        } catch (vaultApiError: unknown) {
            this.logger.log('warn', `Vault API (cachedRead) failed for '${normalizedPath}'. Retrying with direct adapter read.`, vaultApiError);

            // --- Attempt 2: Direct Adapter API ---
            try {
                const content = await this.vault.adapter.read(normalizedPath);
                this.logger.log('verbose', `Successfully read file via Adapter API fallback: ${normalizedPath}`);
                return this._stripBom(content, normalizedPath);
            } catch (adapterApiError: unknown) {
                // If both attempts fail, we throw a comprehensive error.
                const message = createChainedMessage(`All reliable read attempts failed for file ${normalizedPath}.`, adapterApiError);
                const finalError = new FileSystemError(message, adapterApiError instanceof Error ? adapterApiError : undefined, { path: normalizedPath, operation: 'readFile' });
                // Attach the first error for better diagnostics
                (finalError as any).causes = [vaultApiError];
                this.logger.log('error', `FileService.readFile failed for '${normalizedPath}' after all fallbacks.`, finalError);
                throw finalError;
            }
        }
    }

    /**
     * Reads the content of a binary file from the vault.
     * This is a read operation and does not use the write queue.
     * @param {string} filePath The vault-relative path to the file.
     * @returns {Promise<ArrayBuffer>} A promise that resolves with the ArrayBuffer content of the file.
     * @throws {FileSystemError} If the path is invalid, the file is not found, or reading fails.
     */
    public async readBinaryFile(filePath: string): Promise<ArrayBuffer> {
        this._assertServiceIsRunning('readBinaryFile');
        this._validatePathInput(filePath, 'readBinaryFile');

        const normalizedPath = VaultPathResolver.normalize(filePath);
        const file = this.vault.getAbstractFileByPath(normalizedPath);

        if (!(file instanceof TFile)) {
            throw new FileSystemError(`Binary file not found or is not a TFile: ${normalizedPath}`, undefined, { path: normalizedPath, operation: 'readBinaryFile', fileType: file ? file.constructor.name : 'NotFound' });
        }

        // --- Attempt 1: Standard Vault API (readBinary) ---
        try {
            const content = await this.vault.readBinary(file);
            this.logger.log('verbose', `Successfully read binary file via Vault API: ${normalizedPath}`);
            return content;
        } catch (vaultApiError: unknown) {
            this.logger.log('warn', `Vault API (readBinary) failed for '${normalizedPath}'. Retrying with direct adapter read.`, vaultApiError);
            
            // --- Attempt 2: Direct Adapter API ---
            try {
                const content = await this.vault.adapter.readBinary(normalizedPath);
                this.logger.log('verbose', `Successfully read binary file via Adapter API fallback: ${normalizedPath}`);
                return content;
            } catch (adapterApiError: unknown) {
                // If both attempts fail, we throw a comprehensive error.
                const message = createChainedMessage(`All reliable read attempts failed for binary file ${normalizedPath}.`, adapterApiError);
                const finalError = new FileSystemError(message, adapterApiError instanceof Error ? adapterApiError : undefined, { path: normalizedPath, operation: 'readBinaryFile' });
                // Attach the first error for better diagnostics
                (finalError as any).causes = [vaultApiError];
                this.logger.log('error', `FileService.readBinaryFile failed for '${normalizedPath}' after all fallbacks.`, finalError);
                throw finalError;
            }
        }
    }

    /**
     * Checks if a file or folder exists at the given path. This method is enhanced to
     * be reliable for dotfiles by falling back to a direct adapter check.
     * This is a read operation and does not use the write queue.
     * @param {string} path The vault-relative path to check.
     * @returns {Promise<boolean>} A promise that resolves to `true` if the path exists, `false` otherwise.
     */
    public async exists(path: string): Promise<boolean> {
        this._assertServiceIsRunning('exists');
        if (!path || typeof path !== 'string' || path.trim() === '') {
            this.logger.log('verbose', `Existence check called with invalid path: ${path}. Assuming non-existent.`);
            return false;
        }
        const normalizedPath = VaultPathResolver.normalize(path);
        try {
            if (normalizedPath === '' || normalizedPath === '.' || normalizedPath === '/') {
                return true; // Vault root always exists.
            }

            // --- Primary Method: Fast, cached check via Obsidian's metadata ---
            const abstractFile = this.vault.getAbstractFileByPath(normalizedPath);
            if (abstractFile) {
                this.logger.log('verbose', `Existence check for '${normalizedPath}' (via getAbstractFileByPath): true`);
                return true;
            }

            // --- Fallback Method: Direct adapter check for uncached/dotfiles ---
            // This is crucial for dotfiles which might not be in the vault's metadata cache,
            // especially right after they have been created.
            this.logger.log('verbose', `Existence check for '${normalizedPath}' (via getAbstractFileByPath) failed. Trying adapter.exists().`);
            const adapterExists = await this.vault.adapter.exists(normalizedPath);
            this.logger.log('verbose', `Existence check for '${normalizedPath}' (via adapter.exists()): ${adapterExists}`);
            return adapterExists;

        } catch (error: unknown) {
            this.logger.log('warn', `Error during existence check for '${normalizedPath}', assuming non-existent for safety:`, error);
            return false;
        }
    }

    /**
     * A wrapper for `vault.getAbstractFileByPath` for direct access when needed.
     * This is a read operation and does not use the write queue.
     * @param {string} path The vault-relative path.
     * @returns {TAbstractFile | null} The `TFile`, `TFolder`, or `null` if not found.
     */
    public getAbstractFileByPath(path: string): TAbstractFile | null {
        this._assertServiceIsRunning('getAbstractFileByPath');
        return this.vault.getAbstractFileByPath(obsidianNormalizePath(path));
    }

    /**
     * Gets the root folder (`TFolder`) of the vault.
     * This is a read operation and does not use the write queue.
     * @returns {TFolder} The `TFolder` representing the vault's root.
     */
    public getVaultRoot(): TFolder {
        this._assertServiceIsRunning('getVaultRoot');
        return this.vault.getRoot();
    }

    // --- PUBLIC WRITE API (Serialized via Operation Queue) ---

    /**
     * Writes or overwrites a text file in the vault. This method is resilient to file cache race conditions.
     * This operation is queued and serialized to prevent race conditions.
     * @param {string} filePath The vault-relative path to the file.
     * @param {string} content The string content to write.
     * @returns {Promise<void>} A promise that resolves when the write is complete.
     * @throws {FileSystemError} If the path is invalid, writing fails, or a folder exists at the target path.
     */
    public writeFile(filePath: string, content: string): Promise<void> {
        return this._enqueueWriteOperation(async () => {
            this._validatePathInput(filePath, 'writeFile');
            const normalizedPath = VaultPathResolver.normalize(filePath);
            try {
                const parentDir = VaultPathResolver.getParent(normalizedPath);
                await this._createFolderInternal(parentDir);

                // Optimistic creation
                await this.vault.create(normalizedPath, content);
                this.logger.log('info', `Successfully created and wrote file: ${normalizedPath}`);
            } catch (createError: unknown) {
                // If creation fails because the file already exists, try deleting and recreating it.
                if (createError instanceof Error && createError.message.toLowerCase().includes('file already exists')) {
                    this.logger.log('warn', `File '${normalizedPath}' already exists. Attempting to delete and re-create to overcome cache issues.`);
                    try {
                        // Use the adapter for a direct deletion.
                        await this.vault.adapter.remove(normalizedPath);
                        
                        // Re-attempt creation.
                        await this.vault.create(normalizedPath, content);
                        this.logger.log('info', `Successfully re-created file after deletion: ${normalizedPath}`);
                    } catch (deleteAndRecreateError: unknown) {
                        const message = createChainedMessage(`Failed to delete and re-create existing file ${normalizedPath}.`, deleteAndRecreateError);
                        throw new FileSystemError(message, deleteAndRecreateError instanceof Error ? deleteAndRecreateError : undefined, { path: normalizedPath, operation: 'writeFile', stage: 'deleteAndRecreate' });
                    }
                } else {
                    // If the creation error was for a different reason, re-throw it.
                    const message = createChainedMessage(`Failed to write file ${normalizedPath}`, createError);
                    throw new FileSystemError(message, createError instanceof Error ? createError : undefined, { path: normalizedPath, operation: 'writeFile', stage: 'initialCreate' });
                }
            }
        }, `writeFile: ${filePath}`);
    }

    /**
     * Writes or overwrites a binary file in the vault. This method is resilient to file cache race conditions.
     * This operation is queued and serialized to prevent race conditions.
     * @param {string} filePath The vault-relative path to the file.
     * @param {ArrayBuffer} data The ArrayBuffer content to write.
     * @returns {Promise<void>} A promise that resolves when the write is complete.
     * @throws {FileSystemError} If the path is invalid, writing fails, or a folder exists at the target path.
     */
    public writeBinaryFile(filePath: string, data: ArrayBuffer): Promise<void> {
        return this._enqueueWriteOperation(async () => {
            this._validatePathInput(filePath, 'writeBinaryFile');
            const normalizedPath = VaultPathResolver.normalize(filePath);
            try {
                const parentDir = VaultPathResolver.getParent(normalizedPath);
                await this._createFolderInternal(parentDir);

                // Optimistic creation
                await this.vault.createBinary(normalizedPath, data);
                this.logger.log('info', `Successfully created and wrote binary file: ${normalizedPath}`);
            } catch (createError: unknown) {
                // If creation fails because the file already exists, try deleting and recreating it.
                if (createError instanceof Error && createError.message.toLowerCase().includes('file already exists')) {
                    this.logger.log('warn', `Binary file '${normalizedPath}' already exists. Attempting to delete and re-create to overcome cache issues.`);
                    try {
                        // Use the adapter for a direct deletion, bypassing the TFile cache.
                        await this.vault.adapter.remove(normalizedPath);
                        
                        // Now, re-attempt the creation.
                        await this.vault.createBinary(normalizedPath, data);
                        this.logger.log('info', `Successfully re-created binary file after deletion: ${normalizedPath}`);
                    } catch (deleteAndRecreateError: unknown) {
                        // If this more robust approach fails, we have a more serious problem.
                        const message = createChainedMessage(`Failed to delete and re-create existing binary file ${normalizedPath}.`, deleteAndRecreateError);
                        throw new FileSystemError(message, deleteAndRecreateError instanceof Error ? deleteAndRecreateError : undefined, { path: normalizedPath, operation: 'writeBinaryFile', stage: 'deleteAndRecreate' });
                    }
                } else {
                    // If the creation error was for a different reason, re-throw it.
                    const message = createChainedMessage(`Failed to write binary file ${normalizedPath}`, createError);
                    throw new FileSystemError(message, createError instanceof Error ? createError : undefined, { path: normalizedPath, operation: 'writeBinaryFile', stage: 'initialCreate' });
                }
            }
        }, `writeBinaryFile: ${filePath}`);
    }

    /**
     * Ensures a folder exists at the specified path, creating it recursively if necessary.
     * This operation is queued and serialized to prevent race conditions.
     * @param {string} folderPath The vault-relative path of the folder to create.
     * @returns {Promise<void>} A promise that resolves when the folder exists.
     * @throws {FileSystemError} If the path is invalid or if a file exists at the path.
     */
    public createFolder(folderPath: string): Promise<void> {
        return this._enqueueWriteOperation(
            () => this._createFolderInternal(folderPath),
            `createFolder: ${folderPath}`
        );
    }

    /**
     * Moves a file or folder to the vault's trash (or system trash).
     * This operation is queued and serialized to prevent race conditions.
     * @param {string} path The vault-relative path of the item to delete.
     * @returns {Promise<void>} A promise that resolves when the deletion is complete.
     * @throws {FileSystemError} If the path is invalid or the deletion fails.
     */
    public delete(path: string): Promise<void> {
        return this._enqueueWriteOperation(async () => {
            this._validatePathInput(path, 'delete');
            const normalizedPath = VaultPathResolver.normalize(path);
            if (normalizedPath === '' || normalizedPath === '.' || normalizedPath === '/') {
                this.logger.log('warn', `Attempt to delete vault root ('${path}') was blocked.`);
                return;
            }

            try {
                const abstractFile = this.vault.getAbstractFileByPath(normalizedPath);
                if (abstractFile) {
                    await this.vault.trash(abstractFile, true); // true for system trash
                    this.logger.log('info', `Successfully moved to trash: ${normalizedPath}`);
                } else {
                    this.logger.log('verbose', `Attempted to delete non-existent path: ${normalizedPath}. No action taken.`);
                }
            } catch (error: unknown) {
                const message = createChainedMessage(`Failed to move path to trash ${normalizedPath}`, error);
                throw new FileSystemError(message, error instanceof Error ? error : undefined, { path: normalizedPath, operation: 'delete' });
            }
        }, `delete: ${path}`);
    }

    // --- PRIVATE: QUEUE AND STATE MANAGEMENT ---

    /**
     * Enqueues a write operation to be executed serially.
     * @param operation The async function to execute.
     * @param description A short description of the operation for logging.
     * @returns A promise that resolves or rejects when the operation is complete.
     */
    private _enqueueWriteOperation<T>(operation: () => Promise<T>, description: string): Promise<T> {
        this._assertServiceIsRunning(description);

        return new Promise<T>((resolve, reject) => {
            this.operationQueue.push({ operation, resolve, reject, description });
            this.logger.log('verbose', `Queued operation: '${description}'. Queue size: ${this.operationQueue.length}.`);
            
            // If the service was idle, kick off processing.
            if (this.state === 'idle') {
                this._processQueue();
            }
        });
    }

    /**
     * Processes the next operation in the queue.
     * This method is the core of the serialized execution logic.
     */
    private async _processQueue(): Promise<void> {
        if (this.state !== 'idle' || this.operationQueue.length === 0) {
            return; // Stop processing if not idle or queue is empty
        }

        this.state = 'processing';
        const { operation, resolve, reject, description } = this.operationQueue.shift()!;
        this.logger.log('verbose', `Processing operation: '${description}'. Remaining in queue: ${this.operationQueue.length}.`);

        try {
            const result = await operation();
            resolve(result);
        } catch (error) {
            reject(error);
        } finally {
            // Transition back to idle and check for more work, regardless of outcome.
            this.state = 'idle';
            this.logger.log('verbose', `Finished operation: '${description}'. State is now 'idle'.`);
            
            // Use setTimeout to avoid deep call stacks and allow other UI events to process.
            setTimeout(() => this._processQueue(), 0);
        }
    }

    // --- PRIVATE: HELPERS AND VALIDATION ---

    /**
     * Internal implementation for creating a folder. This contains the core logic
     * and is called by the queued public `createFolder` method.
     */
    private async _createFolderInternal(folderPath: string): Promise<void> {
        this._validatePathInput(folderPath, 'createFolder');
        const normalizedPath = VaultPathResolver.normalize(folderPath);

        if (normalizedPath === '' || normalizedPath === '.' || normalizedPath === '/') {
            return; // Vault root always exists.
        }

        const existingItem = this.vault.getAbstractFileByPath(normalizedPath);
        if (existingItem instanceof TFolder) {
            return; // Already exists and is a folder, success.
        }
        if (existingItem instanceof TFile) {
            throw new FileSystemError(`Path '${normalizedPath}' already exists and is a file. Cannot create folder.`, undefined, { path: normalizedPath, operation: 'createFolder', conflict: 'file' });
        }

        try {
            await this.vault.createFolder(normalizedPath);
            this.logger.log('info', `Successfully created folder: ${normalizedPath}`);
        } catch (error: unknown) {
            // Handle race condition where folder was created between our check and the API call.
            // If the API says the folder already exists, we can trust it and proceed.
            // The cache might be stale, so verifying with getAbstractFileByPath is unreliable.
            // If something else exists at the path (e.g., a file), subsequent operations
            // that expect a folder will fail, which is the correct behavior.
            if (error instanceof Error && error.message.toLowerCase().includes('folder already exists')) {
                this.logger.log('info', `Attempted to create folder '${normalizedPath}', but it already exists. Assuming success due to likely race condition.`);
                return; // Treat as a success.
            }
            
            // For any other error, wrap and re-throw it.
            const message = createChainedMessage(`Failed to create folder ${normalizedPath}`, error);
            throw new FileSystemError(message, error instanceof Error ? error : undefined, { path: normalizedPath, operation: 'createFolder' });
        }
    }

    /**
     * Throws an error if the service is not in a runnable state.
     * @param operationName The name of the operation being attempted.
     */
    private _assertServiceIsRunning(operationName: string): void {
        if (this.state === 'unloading') {
            throw new FileSystemError(`Cannot perform operation '${operationName}' because the FileService is unloading.`, undefined, { state: this.state });
        }
    }

    /**
     * Performs aggressive validation on a path input string.
     * @param path The path to validate.
     * @param operationName The name of the operation for error context.
     * @throws {FileSystemError} if validation fails.
     */
    private _validatePathInput(path: string, operationName: string): void {
        if (path === null || path === undefined || typeof path !== 'string') {
            throw new FileSystemError(`Invalid path provided for ${operationName}: must be a string.`, undefined, { path, operation: operationName });
        }
        if (path.trim() === '') {
            throw new FileSystemError(`Invalid path provided for ${operationName}: cannot be empty or just whitespace.`, undefined, { path, operation: operationName });
        }
        if (path.length > MAX_PATH_LENGTH) {
            throw new FileSystemError(`Path exceeds maximum length of ${MAX_PATH_LENGTH} characters.`, undefined, { path, operation: operationName, length: path.length });
        }
    }

    /**
     * Helper to strip the Byte Order Mark (BOM) from text files.
     * @param content The string content.
     * @param normalizedPath The normalized path of the file for extension checking.
     * @returns The content, with the BOM removed if applicable.
     */
    private _stripBom(content: string, normalizedPath: string): string {
        const extension = VaultPathResolver.getExtension(normalizedPath).toLowerCase();
        if (this.textSourceExtensions.includes(extension) && content.startsWith('\uFEFF')) {
            this.logger.log('verbose', `BOM detected and stripped from: ${normalizedPath}`);
            return content.substring(1);
        }
        return content;
    }
}