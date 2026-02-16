import { App, TFile, Notice } from 'obsidian';
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
        // 1. Listen for metadata changes
        this.fileRegistry.observe((event) => {
            event.changes.keys.forEach((change, key) => {
                if (change.action === 'add' || change.action === 'update') {
                    const metadata = this.fileRegistry.get(key);
                    if (metadata) this.checkAndDownload(metadata);
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
        const providers = [
            { name: 'internet', provider: this.yjs.trysteroProvider },
            { name: 'local', provider: this.yjs.localWebrtcProvider }
        ];

        providers.forEach(({ name, provider }) => {
            if (provider && provider.trystero && !this.transferAction[name]) {
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

                console.log(`[FileTransfer] Setup actions for ${name} provider`);
            } else if (!provider) {
                delete this.transferAction[name];
            }
        });
    }

    async handleFileRequest(hash: string, peerId: string, providerName: string) {
        // 1. Find file metadata
        const metadata = this.fileRegistry.get(hash);
        if (!metadata) return;

        // 2. Check if we have the file
        const file = this.app.vault.getAbstractFileByPath(metadata.path);
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
                    console.log(`[FileTransfer] Sent ${metadata.name} to ${peerId}`);
                }
            } catch (e) {
                console.error(`[FileTransfer] Failed to read ${metadata.path}`, e);
            }
        }
    }

    async handleFileChunk(data: Uint8Array, peerId: string, metadata: any) {
        if (!metadata || !metadata.hash) return;
        console.log(`[FileTransfer] Received ${metadata.hash} size=${data.byteLength}`);

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
            console.error(`[FileTransfer] Failed to write ${meta.path}`, e);
            this.pendingDownloads.delete(meta.hash);
        }
    }

    private checkAndDownload(metadata: FileMetadata) {
        // If we already have it, do nothing
        if (this.app.vault.getAbstractFileByPath(metadata.path)) return;
        if (this.pendingDownloads.has(metadata.hash)) return;

        // If we are already an owner, we should have it (maybe deleted locally?)
        if (metadata.owners.includes(this.yjs.ydoc.clientID)) return;

        console.log(`[FileTransfer] Missing file: ${metadata.name} (${metadata.hash}). Looking for owners...`);

        // Find an available owner
        for (const ownerId of metadata.owners) {
            // Check if we are connected to this owner
            const providerName = this.yjs.getClientProvider(ownerId);

            if (providerName && this.transferAction[providerName]) {
                console.log(`[FileTransfer] Requesting ${metadata.name} from client ${ownerId} via ${providerName}`);

                this.pendingDownloads.add(metadata.hash);

                // We broadcast the request to all peers on that provider.
                // Owners will respond.
                this.transferAction[providerName].sendRequest(metadata.hash, null);
                return;
            }
        }


        console.log(`[FileTransfer] No available owners found for ${metadata.name}`);
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

            console.log(`[FileTransfer] Registered local file: ${file.path} (${hash})`);
        } catch (e) {
            console.error(`[FileTransfer] Failed to process local file ${file.path}`, e);
        }
    }

    private async computeHash(buffer: ArrayBuffer): Promise<string> {
        const hashBuffer = await crypto.subtle.digest('SHA-256', buffer);
        const hashArray = Array.from(new Uint8Array(hashBuffer));
        const hashHex = hashArray.map(b => b.toString(16).padStart(2, '0')).join('');
        return hashHex;
    }
}
