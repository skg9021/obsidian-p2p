import { App, TFile, Notice } from 'obsidian';
import { logger } from './logger.service';
import * as Y from 'yjs';
import { YjsService } from './yjs.service';
import { P2PSettings } from '../settings';

interface FileMetadata {
    hash: string;
    path: string; // Relative path in vault
    name: string;
    size: number;
    type: string;
    owners: number[]; // Client IDs that have this file
}

const CHUNK_SIZE = 16 * 1024; // 16KB

export class FileTransferService {
    private fileRegistry: Y.Map<FileMetadata>;
    private transferAction: { [key: string]: any } = {}; // Map provider -> actions
    private pendingDownloads: Set<string> = new Set();
    private cacheDir: string;
    private pathHashCache: Map<string, string> = new Map();

    constructor(
        private app: App,
        private yjs: YjsService,
        private settings: P2PSettings
    ) {
        this.fileRegistry = this.yjs.ydoc.getMap('file-registry');
        this.cacheDir = `${this.app.vault.adapter.getResourcePath('.').split('?')[0]}/.obsidian/plugins/obsidian-plugin-p2p/.transfer-cache`;
        // Ensure cache dir exists? Adapter API is better.
        this.ensureCacheDir();
    }

    async ensureCacheDir() {
        const cachePath = '.obsidian/plugins/obsidian-plugin-p2p/.transfer-cache';
        if (!(await this.app.vault.adapter.exists(cachePath))) {
            await this.app.vault.adapter.mkdir(cachePath);
        }
    }

    initialize() {
        // 0. Populate cache from existing registry
        for (const [hash, metadata] of this.fileRegistry.entries()) {
            // @ts-ignore
            const meta = metadata as FileMetadata;
            this.pathHashCache.set(meta.path, hash);
        }

        // 1. Listen for metadata changes
        this.fileRegistry.observe((event) => {
            event.changes.keys.forEach((change, key) => {
                const metadata = this.fileRegistry.get(key);
                if (change.action === 'add' || change.action === 'update') {
                    if (metadata) {
                        this.pathHashCache.set(metadata.path, key);
                        this.checkAndDownload(metadata);
                    }
                } else if (change.action === 'delete') {
                    // If remote deleted it, we might want to update our cache?
                    // But we don't know the path easily unless we search cache.
                    // We can find by value in cache.
                    for (const [p, h] of this.pathHashCache.entries()) {
                        if (h === key) {
                            this.pathHashCache.delete(p);
                            break;
                        }
                    }
                }
            });
        });

        // 2. Setup Trystero actions on providers when they become available
        this.setupProviderActions();

        // Poll for provider availability (or hook into YjsService events if we add them)
        // For now, let's just attempt setup periodically or expose a method YjsService calls.
        // Actually, YjsService recreates providers on connect/disconnect.
        // We should hook into YjsService.
    }

    // Call this whenever YjsService starts a provider
    setupProviderActions() {
        // Iterate over all strategies in manager
        const strategies = this.yjs.providerManager.getStrategies();

        strategies.forEach((strategy) => {
            const provider = strategy.getUnderlyingProvider();
            const name = strategy.id;

            if (provider && provider.trystero) {
                if (!this.transferAction[name]) {
                    try {
                        const room = provider.trystero;
                        // Trystero action names must be <= 12 bytes
                        const [sendRequest, getRequest] = room.makeAction('f-req');
                        const [sendChunk, getChunk, onProgress] = room.makeAction('f-data');
                        const [sendComplete, getComplete] = room.makeAction('f-done');

                        this.transferAction[name] = { sendRequest, sendChunk, sendComplete };

                        // Handle requests for files
                        getRequest(async (hash: string, peerId: string) => {
                            this.handleFileRequest(hash, peerId, name);
                        });

                        // Handle incoming chunks
                        getChunk((data: Uint8Array, peerId: string, metadata: any) => {
                            this.handleFileChunk(data, peerId, metadata);
                        });

                        // Handle completion
                        getComplete((hash: string, peerId: string) => {
                            // Verification?
                        });

                        logger.info(`[FileTransfer] Setup actions for ${name} provider`);
                    } catch (e) {
                        logger.error(`[FileTransfer] Failed to setup actions for ${name}`, e);
                    }
                } else {
                    // logger.info(`[FileTransfer] Actions already setup for ${name}`);
                }
            } else {
                // Provider is gone, cleanup actions
                if (this.transferAction[name]) {
                    delete this.transferAction[name];
                    logger.info(`[FileTransfer] Cleaned up actions for ${name} provider`);
                }
            }
        });
    }

    async handleFileRequest(hash: string, peerId: string, providerName: string) {
        logger.info(`[FileTransfer] Received request for hash ${hash} from ${peerId} via ${providerName}`);

        // 1. Find file metadata
        const metadata = this.fileRegistry.get(hash);
        if (!metadata) {
            logger.info(`[FileTransfer] File not found in registry: ${hash}`);
            return;
        }

        logger.info(`[FileTransfer] Request for ${metadata.name} (path: ${metadata.path})`);

        // 2. Check if we have the file
        const file = this.app.vault.getAbstractFileByPath(metadata.path);
        if (!file) {
            logger.info(`[FileTransfer] File not found locally at path: ${metadata.path}`);
            return;
        }

        if (file instanceof TFile) {
            // 3. Read and stream
            try {
                const arrayBuffer = await this.app.vault.readBinary(file);
                const buffer = new Uint8Array(arrayBuffer);

                const actions = this.transferAction[providerName];
                if (actions) {
                    await actions.sendChunk(buffer, peerId, { hash, index: 0, total: 1 }); // Trystero handles chunking!
                    // We don't need to manually chunk if Trystero does it.
                    // "Blobs are automatically handled... automatic chunking and throttling"
                    // So we just send the whole buffer!

                    // Sending metadata with the chunk helps identify which file it is.
                    logger.info(`[FileTransfer] Sent ${metadata.name} to ${peerId} via ${providerName}`);
                } else {
                    logger.info(`[FileTransfer] No actions available for provider ${providerName}`);
                }
            } catch (e) {
                logger.error(`[FileTransfer] Failed to read ${metadata.path}`, e);
            }
        } else {
            logger.info(`[FileTransfer] Path is not a TFile: ${metadata.path}`);
        }
    }

    async handleFileChunk(data: Uint8Array, peerId: string, metadata: any) {
        if (!metadata || !metadata.hash) return;
        logger.info(`[FileTransfer] Received ${metadata.hash} size=${data.byteLength}`);

        // Trystero reassembles chunks for us. 'data' is the full file!
        // We just need to save it.
        const meta = this.fileRegistry.get(metadata.hash);
        if (!meta) return;

        try {
            // Fix: Pass ArrayBuffer to writeBinary (force cast as it supports it but types are strict)
            await this.app.vault.adapter.writeBinary(meta.path, data.buffer as ArrayBuffer);
            new Notice(`Received file: ${meta.name}`);

            // Mark ourselves as owner
            meta.owners.push(this.yjs.ydoc.clientID);
            this.fileRegistry.set(meta.hash, meta);

            // Remove from pending
            this.pendingDownloads.delete(meta.hash);
        } catch (e) {
            logger.error(`[FileTransfer] Failed to write ${meta.path}`, e);
            this.pendingDownloads.delete(meta.hash);
        }
    }

    private checkAndDownload(metadata: FileMetadata) {
        // If we already have it, do nothing
        if (this.app.vault.getAbstractFileByPath(metadata.path)) return;
        if (this.pendingDownloads.has(metadata.hash)) return;

        // If we are already an owner, we should have it (maybe deleted locally?)
        if (metadata.owners.includes(this.yjs.ydoc.clientID)) return;

        logger.info(`[FileTransfer] Missing file: ${metadata.name} (${metadata.hash}). Looking for owners...`);

        // Find an available owner
        for (const ownerId of metadata.owners) {
            // Check if we are connected to this owner
            const providerName = this.yjs.getClientProvider(ownerId);

            logger.info(`[FileTransfer] Checking owner ${ownerId}. Provider: ${providerName}`);
            if (!providerName) {
                // Debug why provider is null
                // We can't access private sets from here directly unless we cast to any or add public debug method
                // But we can log what getClientProvider returned.
                // Actually let's assume YjsService logs if we enable debug there.
                // Or we can just log the raw sets if we change YjsService visibility... 
                // keeping it simple for now.
            }

            if (providerName && this.transferAction[providerName]) {
                logger.info(`[FileTransfer] Requesting ${metadata.name} from client ${ownerId} via ${providerName}`);

                this.pendingDownloads.add(metadata.hash);

                // We broadcast the request to all peers on that provider.
                // Owners will respond.
                this.transferAction[providerName].sendRequest(metadata.hash, null);
                return;
            }
        }


        logger.info(`[FileTransfer] No available owners found for ${metadata.name}`);
    }

    /**
     * Call this when a non-markdown file is added/modified locally.
     * Calculated hash and updates registry.
     */
    async handleLocalFile(file: TFile) {
        if (file.extension === 'md') return; // Handled by YjsService

        try {
            const arrayBuffer = await this.app.vault.readBinary(file);
            const hash = await this.computeHash(arrayBuffer);

            const metadata: FileMetadata = {
                hash,
                path: file.path,
                name: file.name,
                size: file.stat.size,
                type: file.extension,
                owners: [this.yjs.ydoc.clientID]
            };

            // Check if existing metadata needs update (e.g. new owner for same file content? 
            // or new content for same path?)
            // If path exists but hash is different, update hash mapping?
            // Actually, we index by Hash. But we need to know that 'path' changed content.
            // If content changed, hash changes.

            // We should also index by Path? Or just rely on Hash?
            // If I change a file, I generate a new Hash.
            // I should update the registry for the NEW hash.

            // TODO: Handle file deletion/rename/move?
            // For now, just register the new state.

            const existing = this.fileRegistry.get(hash);
            if (existing) {
                if (!existing.owners.includes(this.yjs.ydoc.clientID)) {
                    existing.owners.push(this.yjs.ydoc.clientID);
                    this.fileRegistry.set(hash, existing);
                }
            } else {
                this.fileRegistry.set(hash, metadata);
            }

            logger.info(`[FileTransfer] Registered local file: ${file.path} (${hash})`);
        } catch (e) {
            logger.error(`[FileTransfer] Failed to process local file ${file.path}`, e);
        }
    }

    async handleLocalRename(file: TFile, oldPath: string) {
        // Find old hash
        const hash = this.pathHashCache.get(oldPath);
        if (hash) {
            this.pathHashCache.delete(oldPath);
            this.handleLocalFile(file); // Registers new path

            // Should we clean up the old path entry in registry?
            // Since hash is same (content same), handleLocalFile updates the existing entry.
            // But if we want to be safe:
            // The verify logic in handleLocalFile will update the path.
        } else {
            // New file or missed
            this.handleLocalFile(file);
        }
    }

    async handleLocalDelete(file: TFile) {
        // Find hash from path cache
        const hash = this.pathHashCache.get(file.path);
        if (hash) {
            const metadata = this.fileRegistry.get(hash);
            if (metadata) {
                // Remove self from owners
                const index = metadata.owners.indexOf(this.yjs.ydoc.clientID);
                if (index > -1) {
                    metadata.owners.splice(index, 1);
                    if (metadata.owners.length === 0) {
                        // Optional: remove entry entirely if no owners?
                        // this.fileRegistry.delete(hash);
                        // Keeping it might be useful for history? No, it wastes space.
                        this.fileRegistry.delete(hash);
                        logger.info(`[FileTransfer] Removed file from registry: ${file.path} (${hash})`);
                    } else {
                        this.fileRegistry.set(hash, metadata);
                        logger.info(`[FileTransfer] Removed self as owner for: ${file.path} (${hash})`);
                    }
                }
            }
            this.pathHashCache.delete(file.path);
        }
    }

    debugState() {
        logger.info('--- FileTransferService State ---');
        logger.info('Transfer Actions:', Object.keys(this.transferAction));
        logger.info('Pending Downloads:', Array.from(this.pendingDownloads));
        //@ts-ignore
        logger.info('Registry Size:', this.fileRegistry.size);
        //@ts-ignore
        logger.info('Registry Keys:', Array.from(this.fileRegistry.keys()));
        // logger.info('Registry Entries:', this.fileRegistry.toJSON()); // Careful with large registry
    }

    private async computeHash(buffer: ArrayBuffer): Promise<string> {
        const hashBuffer = await crypto.subtle.digest('SHA-256', buffer);
        const hashArray = Array.from(new Uint8Array(hashBuffer));
        const hashHex = hashArray.map(b => b.toString(16).padStart(2, '0')).join('');
        return hashHex;
    }
}
