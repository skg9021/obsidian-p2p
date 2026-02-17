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

export interface PeerInfo {
    name: string;
    ip?: string;
    clientId: number;
    source: 'local' | 'internet' | 'both' | 'unknown';
}

export interface PeerState {
    name: string;
    ip?: string;
    [key: string]: any;
}

export class YjsService {
    ydoc: Y.Doc;
    yMap: Y.Map<Y.Text>;
    awareness: awarenessProtocol.Awareness;
    isRemoteUpdate: boolean = false;

    /** Internet P2P provider (Trystero + MQTT signaling) */
    trysteroProvider: any | null = null;
    /** Local LAN P2P provider (Trystero + Local Signaling) */
    localWebrtcProvider: any | null = null;

    /** Track which providers (origins) each awareness client ID isn't connected through */
    private peerOrigins: Map<number, Set<string>> = new Map();

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

        // Track which provider each peer's awareness came through.
        this.awareness.on('update', ({ added, removed }: any, origin: any) => {
            const roomName = origin?.roomName || origin?.room?.name;
            // console.log(`[P2P Yjs] Awareness update from origin:`, origin); 
            // The origin object structure might differ between providers.
            // Let's log it to find out what property holds the name.
            if (this.settings.enableDebugLogs) {
                console.log(`[P2P Yjs] Awareness update. Origin:`, origin);
                // console.log(`[P2P Yjs] Origin keys:`, origin ? Object.keys(origin) : 'null');
                // console.log(`[P2P Yjs] Origin roomName: ${origin?.roomName}, room.name: ${origin?.room?.name}`);
            }

            // Fix: Check for roomName property directly as TrysteroProvider might use that?
            // Or TrysteroProvider passes 'this' as origin.
            // Let's try to be more robust.

            const nameToUse = roomName || (origin && typeof origin === 'object' && origin.roomName);

            if (!nameToUse) return; // local change or non-WebRTC origin

            const updateOrigin = (clientId: number, action: 'add' | 'remove') => {
                if (!this.peerOrigins.has(clientId)) this.peerOrigins.set(clientId, new Set());
                const origins = this.peerOrigins.get(clientId)!;

                if (action === 'add') {
                    origins.add(nameToUse);
                } else {
                    origins.delete(nameToUse);
                    if (origins.size === 0) this.peerOrigins.delete(clientId);
                }
            };

            added?.forEach((id: number) => updateOrigin(id, 'add'));
            removed?.forEach((id: number) => updateOrigin(id, 'remove'));
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
                const origins = this.peerOrigins.get(clientId) || new Set();

                let isLocal = false;
                let isInternet = false;

                // Check origins to determine type
                for (const origin of origins) {
                    if (origin.startsWith('lan-')) isLocal = true;
                    if (origin.startsWith('mqtt-')) isInternet = true;
                }

                // Fallback inferencing if no origin recorded (e.g. missed update event)
                if (!isLocal && !isInternet) {
                    if (this.trysteroProvider && !this.localWebrtcProvider) isInternet = true;
                    else if (!this.trysteroProvider && this.localWebrtcProvider) isLocal = true;
                    else isLocal = true; // Default to local?
                }

                let source: PeerInfo['source'] = 'local';
                if (isLocal && isInternet) source = 'both';
                else if (isInternet) source = 'internet';
                else source = 'unknown';

                peers.push({ name: state.name, ip: state.ip, clientId, source });
            }
        });
        this.log(`Peers updated: [${peers.map(p => `${p.name}(${p.source})`).join(', ')}]`);
        this.onPeersUpdated(peers);
    }

    /** Public method to re-emit the current peer list (e.g. after reconnect) */
    refreshPeerList() {
        this.emitPeerList();
    }

    /** Helper to determine the best provider for a given client ID */
    getClientProvider(clientId: number): 'internet' | 'local' | null {
        const origins = this.peerOrigins.get(clientId);
        if (!origins) {
            console.log(`[P2P Yjs] Client ${clientId} has no recorded origins.`);
            return null;
        }

        // Prefer local
        for (const origin of origins) {
            if (origin.startsWith('lan-')) return 'local';
        }
        for (const origin of origins) {
            if (origin.startsWith('mqtt-')) return 'internet';
        }

        return null;
    }

    // ─── Internet P2P (Trystero + MQTT) ─────────────────────────

    startTrysteroProvider(roomName: string, password?: string, relayUrls?: string[], mqttCredentials?: { username: string; password: string }) {
        if (this.trysteroProvider) {
            this.log('Destroying existing Trystero provider');
            this.trysteroProvider.destroy();
            this.trysteroProvider = null;
        }

        this.log(`Starting TrysteroProvider for room: ${roomName}, relays: [${relayUrls?.join(', ') || 'defaults'}], auth: ${mqttCredentials?.username ? 'yes' : 'no'}`);
        try {
            this.trysteroProvider = new TrysteroProvider(
                `mqtt-${roomName}`,
                this.ydoc,
                {
                    awareness: this.awareness,
                    filterBcConns: false,
                    disableBc: true, // Disable BroadcastChannel — not useful in Obsidian/Electron
                    joinRoom: (config: any, roomId: string) => {
                        return joinRoom({
                            ...config,
                            appId: config.appId || 'obsidian-p2p-sync',
                            password: password || undefined,
                            // relayUrls tells trystero which MQTT brokers to connect to
                            ...(relayUrls && relayUrls.length > 0 ? { relayUrls } : {}),
                            // MQTT credentials passed directly to mqtt.connect() options
                            // via our patched mqtt.js (bypasses URL credential parsing)
                            ...(mqttCredentials?.username ? {
                                mqttUsername: mqttCredentials.username,
                                mqttPassword: mqttCredentials.password,
                            } : {}),
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
                this.emitPeerList();
            });

            this.log('TrysteroProvider started');
        } catch (e) {
            console.error('[P2P Yjs] Failed to start TrysteroProvider', e);
        }
    }

    stopTrysteroProvider() {
        if (this.trysteroProvider) {
            // @ts-ignore
            closeAllClients(); // Close Trystero MQTT clients
            this.trysteroProvider.destroy();
            this.trysteroProvider = null;
            this.log('Trystero provider stopped');
        }

        // Remove all MQTT origins
        for (const [clientId, origins] of this.peerOrigins) {
            const mqttOrigins = Array.from(origins).filter(o => o.startsWith('mqtt-'));
            mqttOrigins.forEach(o => origins.delete(o));
            if (origins.size === 0) this.peerOrigins.delete(clientId);
        }

        this.emitPeerList();
    }

    // ─── Local LAN P2P (Trystero via Local Signaling) ─────────

    startLocalWebrtcProvider(signalingUrl: string, roomName: string, password?: string) {
        if (this.localWebrtcProvider) {
            this.log('Destroying existing local provider');
            this.localWebrtcProvider.destroy();
            this.localWebrtcProvider = null;
        }

        this.log(`Starting local TrysteroProvider: signaling=${signalingUrl}, room=${roomName}`);
        try {
            // Use TrysteroProvider but with our custom local strategy
            this.localWebrtcProvider = new TrysteroProvider(
                `lan-${roomName}`,
                this.ydoc,
                {
                    appId: 'obsidian-p2p-local', // Identifier for the local app context
                    password: password || undefined,
                    joinRoom: (config: any, roomId: string) => {
                        return joinLocalRoom({
                            ...config,
                            clientUrl: signalingUrl,
                            settings: this.settings
                        }, roomId);
                    },
                    awareness: this.awareness,
                    filterBcConns: false,
                    disableBc: true,
                }
            );

            this.localWebrtcProvider.on('status', (event: any) => {
                this.log(`Local Trystero status: ${JSON.stringify(event)}`);
            });

            this.localWebrtcProvider.on('peers', (event: any) => {
                this.log(`Local Trystero peers changed`);
                this.emitPeerList();
            });

            this.log('Local TrysteroProvider started');
        } catch (e) {
            console.error('[P2P Yjs] Failed to start local TrysteroProvider', e);
        }
    }

    stopLocalWebrtcProvider() {
        if (this.localWebrtcProvider) {
            this.log('Stopping local WebrtcProvider');
            try {
                this.localWebrtcProvider.destroy();
            } catch (e) {
                console.error('[P2P Yjs] Error stopping WebrtcProvider', e);
            }
            this.localWebrtcProvider = null;
            this.log('Local WebRTC provider stopped');
        }

        // Remove all LAN origins
        for (const [clientId, origins] of this.peerOrigins) {
            const lanOrigins = Array.from(origins).filter(o => o.startsWith('lan-'));
            lanOrigins.forEach(o => origins.delete(o));
            if (origins.size === 0) this.peerOrigins.delete(clientId);
        }

        this.emitPeerList();
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
