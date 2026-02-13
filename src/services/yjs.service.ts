import * as Y from 'yjs';
import { App, TFile, TAbstractFile, debounce } from 'obsidian';
// @ts-ignore - no types for this package
import { TrysteroProvider } from '@winstonfassett/y-webrtc-trystero';
// @ts-ignore
import { joinRoom } from 'trystero/mqtt';
// @ts-ignore
import { WebrtcProvider } from 'y-webrtc';
import * as awarenessProtocol from 'y-protocols/awareness';
import { P2PSettings } from '../settings';

export interface PeerInfo {
    name: string;
    ip?: string;
    clientId: number;
}

export class YjsService {
    ydoc: Y.Doc;
    yMap: Y.Map<Y.Text>;
    awareness: awarenessProtocol.Awareness;
    isRemoteUpdate: boolean = false;

    /** Internet P2P provider (Trystero + MQTT signaling) */
    trysteroProvider: any | null = null;
    /** Local LAN P2P provider (y-webrtc + WebSocket signaling) */
    localWebrtcProvider: any | null = null;

    /** Callback when peer list changes */
    onPeersUpdated: (peers: PeerInfo[]) => void = () => { };

    constructor(private app: App, private settings: P2PSettings) {
        this.ydoc = new Y.Doc();
        this.yMap = this.ydoc.getMap('obsidian-vault');

        // Shared awareness instance — used by both providers
        this.awareness = new awarenessProtocol.Awareness(this.ydoc);

        // Set our own device name in awareness
        this.awareness.setLocalState({
            name: this.settings.deviceName,
        });

        // Listen for awareness changes to track peers
        this.awareness.on('change', () => {
            this.emitPeerList();
        });

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

    /** Collect all peers from awareness and notify via callback */
    private emitPeerList() {
        const peers: PeerInfo[] = [];
        this.awareness.getStates().forEach((state: any, clientId: number) => {
            if (clientId === this.ydoc.clientID) return; // Skip self
            if (state && state.name) {
                peers.push({ name: state.name, ip: state.ip, clientId });
            }
        });
        this.log(`Peers updated: [${peers.map(p => p.name).join(', ')}]`);
        this.onPeersUpdated(peers);
    }

    // ─── Internet P2P (Trystero + MQTT) ─────────────────────────

    startTrysteroProvider(roomName: string, password?: string) {
        if (this.trysteroProvider) {
            this.log('Destroying existing Trystero provider');
            this.trysteroProvider.destroy();
            this.trysteroProvider = null;
        }

        this.log(`Starting TrysteroProvider for room: ${roomName}`);
        try {
            this.trysteroProvider = new TrysteroProvider(
                roomName,
                this.ydoc,
                {
                    awareness: this.awareness,
                    joinRoom: (config: any, roomId: string) => {
                        return joinRoom({
                            ...config,
                            appId: config.appId || 'obsidian-p2p-sync',
                            password: password || undefined,
                        }, roomId);
                    },
                    password: password || undefined,
                }
            );

            this.trysteroProvider.on('synced', (event: any) => {
                this.log(`Trystero synced: ${JSON.stringify(event)}`);
            });

            this.trysteroProvider.on('peers', (event: any) => {
                this.log(`Trystero peers: added=${event.added}, removed=${event.removed}`);
            });

            this.log('TrysteroProvider started');
        } catch (e) {
            console.error('[P2P Yjs] Failed to start TrysteroProvider', e);
        }
    }

    stopTrysteroProvider() {
        if (this.trysteroProvider) {
            this.log('Stopping TrysteroProvider');
            this.trysteroProvider.destroy();
            this.trysteroProvider = null;
        }
    }

    // ─── Local LAN P2P (y-webrtc + WebSocket signaling) ─────────

    startLocalWebrtcProvider(signalingUrl: string, roomName: string, password?: string) {
        if (this.localWebrtcProvider) {
            this.log('Destroying existing local WebRTC provider');
            this.localWebrtcProvider.destroy();
            this.localWebrtcProvider = null;
        }

        this.log(`Starting local WebrtcProvider: signaling=${signalingUrl}, room=${roomName}`);
        try {
            this.localWebrtcProvider = new WebrtcProvider(
                roomName,
                this.ydoc,
                {
                    signaling: [signalingUrl],
                    password: password || null,
                    maxConns: 20,
                    awareness: this.awareness,
                }
            );

            this.localWebrtcProvider.on('synced', (event: any) => {
                this.log(`Local WebRTC synced: ${JSON.stringify(event)}`);
            });

            this.localWebrtcProvider.on('peers', (event: any) => {
                this.log(`Local WebRTC peers changed`);
            });

            this.log('Local WebrtcProvider started');
        } catch (e) {
            console.error('[P2P Yjs] Failed to start local WebrtcProvider', e);
        }
    }

    stopLocalWebrtcProvider() {
        if (this.localWebrtcProvider) {
            this.log('Stopping local WebrtcProvider');
            this.localWebrtcProvider.destroy();
            this.localWebrtcProvider = null;
        }
    }

    // ─── Lifecycle ──────────────────────────────────────────────

    destroy() {
        this.stopTrysteroProvider();
        this.stopLocalWebrtcProvider();
        this.awareness.destroy();
        this.ydoc.destroy();
    }

    // ─── Vault ↔ Yjs sync ───────────────────────────────────────

    async handleLocalModify(file: TAbstractFile) {
        if (this.isRemoteUpdate) return;
        if (!(file instanceof TFile) || file.extension !== 'md') return;

        const content = await this.app.vault.read(file);

        this.ydoc.transact(() => {
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
            for (const [path, yText] of this.yMap.entries()) {
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
        } catch (e) { console.error("Sync Write Error", e); }
        finally { this.isRemoteUpdate = false; }
    }, 500, true);

    async syncLocalToYjs() {
        const files = this.app.vault.getMarkdownFiles();
        this.ydoc.transact(() => {
            files.forEach(async (file) => {
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
