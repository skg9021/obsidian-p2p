import * as Y from 'yjs';
import { App, TFile, TAbstractFile, debounce } from 'obsidian';
// @ts-ignore - no types for this package
import { TrysteroProvider } from '@winstonfassett/y-webrtc-trystero';
// @ts-ignore
import { joinRoom, closeAllClients } from 'trystero/mqtt';
// @ts-ignore
import { WebrtcProvider } from 'y-webrtc';
import * as awarenessProtocol from 'y-protocols/awareness';
import { P2PSettings } from '../settings';
import { joinRoom as joinLocalRoom } from './trystero-local-strategy';
import { ProviderManager } from './provider-manager.service';
import { PeerInfo } from './p2p-types';





export class YjsService {
    ydoc: Y.Doc;
    yMap: Y.Map<Y.Text>;
    /** Tombstone map: path → { deletedBy, deletedAt } for soft-delete propagation */
    tombstones: Y.Map<any>;
    awareness: awarenessProtocol.Awareness;
    isRemoteUpdate: boolean = false;

    /** Provider Manager handling strategies */
    providerManager: ProviderManager;

    /** Callback when peer list changes */
    onPeersUpdated: (peers: PeerInfo[]) => void = () => { };

    constructor(private app: App, private settings: P2PSettings) {
        this.ydoc = new Y.Doc();
        this.yMap = this.ydoc.getMap('obsidian-vault');
        this.tombstones = this.ydoc.getMap('deleted-files');

        // Shared awareness instance — used by strategies
        this.awareness = new awarenessProtocol.Awareness(this.ydoc);

        // Set our own device name in awareness
        this.awareness.setLocalState({
            name: this.settings.deviceName,
        });

        // Initialize Provider Manager
        this.providerManager = new ProviderManager();
        this.providerManager.onPeersUpdated = (peers) => {
            this.log(`Peers updated: [${peers.map(p => `${p.name}(${p.source})`).join(', ')}]`);
            this.onPeersUpdated(peers);
        };

        this.ydoc.on('update', (update: Uint8Array, origin: any) => {
            if (origin !== 'local') {
                this.applyToDisk();
            }
        });
    }

    private log(msg: string, ...args: any[]) {
        if (this.settings.enableDebugLogs) console.log(`[P2P Yjs] ${msg}`, ...args);
    }

    /** Set local IPs in awareness so other peers can see our IP */
    setLocalIPs(ips: string[]) {
        const currentState = this.awareness.getLocalState() || {};
        this.awareness.setLocalState({
            ...currentState,
            ip: ips.length > 0 ? ips[0] : undefined,
        });
    }

    /** Public method to re-emit the current peer list (e.g. after reconnect) */
    refreshPeerList() {
        const peers = this.providerManager.getPeers();
        this.onPeersUpdated(peers);
    }

    /** 
     * Helper to determine the best provider for a given client ID 
     * (Delegated to Provider Mananger's source info)
     */
    getClientProvider(clientId: number): 'mqtt' | 'local' | null {
        const peers = this.providerManager.getPeers();
        const peer = peers.find(p => p.clientId === clientId);
        if (!peer) return null;

        if (peer.source === 'both') return 'local';
        if (peer.source === 'internet') return 'mqtt';
        if (peer.source === 'local') return 'local';
        return null;
    }

    // ─── Lifecycle ──────────────────────────────────────────────

    destroy() {
        this.providerManager.destroy();
        this.awareness.destroy();
        this.ydoc.destroy();
    }

    // ─── Vault ↔ Yjs sync ───────────────────────────────────────

    /**
     * Soft-delete: places a tombstone in the shared CRDT so all peers
     * move the file to trash instead of hard-deleting it.
     */
    handleLocalDelete(file: TAbstractFile) {
        if (this.isRemoteUpdate) return;
        if (!(file instanceof TFile) || file.extension !== 'md') return;

        this.log(`Soft-deleting ${file.path} (tombstone)`);
        this.ydoc.transact(() => {
            this.yMap.delete(file.path);
            this.tombstones.set(file.path, {
                deletedBy: this.settings.deviceName,
                deletedAt: Date.now(),
            });
        }, 'local');
    }

    async handleLocalModify(file: TAbstractFile) {
        if (this.isRemoteUpdate) return;
        if (!(file instanceof TFile) || file.extension !== 'md') return;

        const content = await this.app.vault.read(file);

        this.ydoc.transact(() => {
            // Clear any tombstone — re-creating/editing a file un-deletes it
            if (this.tombstones.has(file.path)) {
                this.log(`Clearing tombstone for ${file.path} (file modified/recreated)`);
                this.tombstones.delete(file.path);
            }

            let yText = this.yMap.get(file.path);
            if (!yText) { yText = new Y.Text(); this.yMap.set(file.path, yText); }

            const yContent = yText.toString();
            if (yContent !== content) {
                yText.delete(0, yText.length);
                yText.insert(0, content);
            }
        }, 'local');
    }

    applyToDisk = debounce(async () => {
        this.isRemoteUpdate = true;
        try {
            // 1) Apply content updates (create / modify)
            for (const [path, yText] of this.yMap.entries()) {
                // Skip files that have a tombstone — they're pending deletion
                if (this.tombstones.has(path)) continue;

                const content = (yText as Y.Text).toString();
                const file = this.app.vault.getAbstractFileByPath(path);
                if (file instanceof TFile) {
                    const current = await this.app.vault.read(file);
                    if (current !== content) await this.app.vault.modify(file, content);
                } else if (!file) {
                    await this.ensureFolder(path);
                    await this.app.vault.create(path, content);
                }
            }

            // 2) Apply tombstones — move deleted files to Obsidian's trash
            for (const [path, meta] of this.tombstones.entries()) {
                const file = this.app.vault.getAbstractFileByPath(path);
                if (file instanceof TFile) {
                    this.log(`Moving ${path} to trash (deleted by ${meta.deletedBy} at ${new Date(meta.deletedAt).toLocaleString()})`);
                    await this.app.vault.trash(file, false); // false = use Obsidian .trash/, not system trash
                }
            }
        } catch (e) { console.error("Sync Write Error", e); }
        finally { this.isRemoteUpdate = false; }
    }, 500, true);

    async syncLocalToYjs() {
        const files = this.app.vault.getMarkdownFiles();
        this.ydoc.transact(() => {
            files.forEach(async (file) => {
                // Skip files with active tombstones
                if (this.tombstones.has(file.path)) return;

                const content = await this.app.vault.read(file);
                let yText = this.yMap.get(file.path);
                if (!yText) { yText = new Y.Text(); this.yMap.set(file.path, yText); }
                if (yText.toString() !== content) { yText.delete(0, yText.length); yText.insert(0, content); }
            });
        }, 'local');
    }

    async ensureFolder(path: string) {
        const parts = path.split('/');
        parts.pop();
        let current = '';
        for (const part of parts) {
            current = current ? `${current}/${part}` : part;
            if (!this.app.vault.getAbstractFileByPath(current)) await this.app.vault.createFolder(current);
        }
    }
}
