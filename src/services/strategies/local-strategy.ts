
import * as Y from 'yjs';
import * as awarenessProtocol from 'y-protocols/awareness';
import { ConnectionStrategy, StrategyId } from './connection-strategy.interface';
import { Platform } from 'obsidian';
import { PeerInfo } from '../p2p-types';
import { P2PSettings } from '../../settings'; // Needed for local strategy joinRoom config
// @ts-ignore
import { TrysteroProvider } from '@winstonfassett/y-webrtc-trystero';
import { joinRoom as joinLocalRoom } from '../trystero-local-strategy';
import { Logger } from '../logger.service';

export class LocalStrategy implements ConnectionStrategy {
    id: StrategyId = 'local';
    name: string = 'Local Network (LAN)';

    private doc: Y.Doc | null = null;
    private awareness: awarenessProtocol.Awareness | null = null;
    private provider: any | null = null;
    private logger: Logger;

    // Track peers visible to THIS provider
    private myPeers: Map<number, any> = new Map();
    private peerUpdateCallback: ((peers: PeerInfo[]) => void) | null = null;
    private activeNetworkIds: string[] = [];

    constructor(logger: Logger) {
        this.logger = logger;
    }

    initialize(doc: Y.Doc, awareness: awarenessProtocol.Awareness): void {
        this.doc = doc;
        this.awareness = awareness;
        if (this.awareness) {
            this.awareness.on('update', ({ added, removed, updated }: any, origin: any) => {
                this.handleAwarenessUpdate(added, removed, origin);
            });
        }
        this.logger.log('[LocalStrategy] Initialized with awareness: ', this.awareness);
    }

    async connect(roomName: string, settings: any): Promise<void> {
        // Local strategy handles both Host and Client modes.
        // It connects if either server is enabled (host) OR client is enabled + address set.

        let shouldConnect = false;
        let signalingUrl = '';

        // Mobile cannot host
        const canHost = typeof process !== 'undefined' && !('isMobile' in process.versions); // Simple check, or pass Platform via settings/init
        // Actually we passed Platform in main.ts logic. 
        // Let's rely on settings being passed correctly or check Platform here if possible. 
        // We don't have direct access to 'Platform' from obsidian here unless we import it.
        // But we are in a strategy file. We can import { Platform } from 'obsidian' if needed, or rely on passed context.
        // For now, let's assume 'settings' contains everything or we import Platform.
        // Import Platform is best.

        // Host Mode
        // We need to know if we successfully started the server? 
        // Actually, LocalStrategy connects to a signaling url. 
        // If we are Host, we connect to localhost.
        // If we are Client, we connect to remote.
        // If BOTH, we connect to BOTH? Trystero doesn't support connecting to multiple signaling servers in one instance easily 
        // without multiple instances. 
        // BUT Trystero Local uses ONE socket.
        // Our 'LocalStrategy' wraps 'TrysteroLocalProvider', which wraps a websocket.

        // Wait, the previous logic in main.ts distinguished between 'Host' implementation connecting to localhost 
        // and 'Client' implementation connecting to remote.
        // And it created ONE 'local' strategy? 
        // No, main.ts registered ONE 'local' strategy.
        // If both were enabled, it would call connectStrategy TWICE? 
        // PROVIDER MANAGER: "connectStrategy" gets the strategy and calls connect.
        // If you call it twice, it might disconnect the first one?
        // Let's check LocalStrategy implementation.

        // LocalStrategy holds ONE 'provider'. 
        // If we call connect() again, it overwrites 'this.provider'.
        // So we can only have ONE active LocalStrategy connection.
        // This means we can either be a Host (connected to localhost) OR a Client (connected to remote).
        // Can we be both? 
        // If I am Host, I am the server. I connect to myself.
        // If I am Client, I connect to Host.
        // Usually you are one or the other in this model (or if you are Host, you don't need to be Client to someone else usually, unless mesh).
        // The settings imply:
        // "Enable Local Server" -> I am Host.
        // "Enable Local Client" -> I connect to Host.

        // If I am Host, I connect to `ws://localhost:port`.
        // If I am Client, I connect to `ws://remote:port`.

        // If both are enabled? Valid use case? Maybe acting as relay? 
        // For now, let's prioritize Host if enabled (we are the server), otherwise Client.

        if (settings.enableLocalServer && !Platform.isMobile) {
            signalingUrl = `ws://localhost:${settings.localServerPort}`;
            shouldConnect = true;
        } else if (settings.enableLocalClient && settings.localServerAddress) {
            signalingUrl = settings.localServerAddress;
            shouldConnect = true;
        }

        if (!shouldConnect) {
            // console.log('[LocalStrategy] Disabled or invalid settings. Skipping.');
            return;
        }

        if (!signalingUrl) {
            console.error('[LocalStrategy] Missing signalingUrl in connect options');
            return;
        }

        // console.log(`[LocalStrategy] Connecting to ${signalingUrl}...`);

        const password = settings.secretKey;
        if (!this.doc || !this.awareness) {
            throw new Error('LocalStrategy not initialized with doc and awareness');
        }
        if (this.provider) this.disconnect();

        // const signalingUrl = options?.signalingUrl; // This line is now redundant
        // const password = options?.password; // This line is now redundant



        const fullRoomName = `lan-${roomName}`;
        console.log(`[LocalStrategy] Connecting to room: ${fullRoomName} via ${signalingUrl}`);

        try {
            this.provider = new TrysteroProvider(
                fullRoomName,
                this.doc,
                {
                    appId: 'obsidian-p2p-local',
                    password: password || undefined,
                    joinRoom: (config: any, roomId: string) => {
                        return joinLocalRoom({
                            ...config,
                            clientUrl: signalingUrl,
                            settings: settings
                        }, roomId);
                    },
                    awareness: this.awareness,
                    filterBcConns: false, // We rely on doc sync, avoiding broadcast channel duplicate complications
                    disableBc: true,
                }
            );

            this.provider.on('status', (event: any) => {
                // console.log(`[LocalStrategy] Status:`, event);

                // When we connect, explicitly update our awareness state to force a broadcast
                // Trystero without BroadcastChannel may miss initial presence propagation on reconnect
                if (event && event.connected === true && this.awareness) {
                    this.logger?.debug('[LocalStrategy] Connected, forcing awareness broadcast');
                    const localState = this.awareness.getLocalState() || {};
                    // Briefly set a connecting timestamp to force awareness protocol to broadcast changes
                    this.awareness.setLocalStateField('__reconnectedAt', Date.now());
                }
            });

            this.provider.on('peers', (event: any) => {
                if (event && event.length > 0) {
                    this.activeNetworkIds = event[0].trysteroPeers || [];
                    this.recomputePeers();
                }
            });

            // Trigger initial peer check?
            // TrysteroProvider generally emits events when connected.

        } catch (e) {
            console.error('[LocalStrategy] Failed to start TrysteroProvider', e);
            throw e;
        }
    }

    disconnect(): void {
        if (this.provider) {
            try {
                // Fix: Manually leave the room to close the socket
                // TrysteroProvider.destroy() creates a new room but doesn't close the old one's socket
                if (this.provider.trystero && typeof this.provider.trystero.leave === 'function') {
                    this.provider.trystero.leave();
                }

                this.provider.destroy();
            } catch (e) {
                console.error('[LocalStrategy] Error destroying provider', e);
            }
            this.provider = null;
            this.logger.log('[LocalStrategy] Disconnected');
        }
        this.myPeers.clear();
        this.activeNetworkIds = [];
        this.notifyPeersChanged();
    }

    destroy(): void {
        this.disconnect();
        this.doc = null;
        this.awareness = null;
        this.peerUpdateCallback = null;
    }

    isConnected(): boolean {
        return !!this.provider;
    }

    getPeers(): PeerInfo[] {
        const peers: PeerInfo[] = [];
        this.myPeers.forEach((state, clientId) => {
            peers.push({
                clientId,
                name: state.name || 'Unknown',
                ip: state.ip,
                source: 'local'
            });
        });
        return peers;
    }

    onPeerUpdate(callback: (peers: PeerInfo[]) => void): void {
        this.peerUpdateCallback = callback;
    }

    getUnderlyingProvider(): any {
        return this.provider;
    }

    private handleAwarenessUpdate(added: number[], removed: number[], origin: any) {
        // With Network-Layer Tracking, we don't need to guess the origin.
        // We just recompute based on the current active WebRTC network IDs.
        this.recomputePeers();
    }

    private recomputePeers() {
        if (!this.awareness) return;

        let stateChanged = false;
        const newPeers = new Map<number, any>();

        this.awareness.getStates().forEach((state, clientId) => {
            if (state.networkId && this.activeNetworkIds.includes(state.networkId)) {
                newPeers.set(clientId, state);
            }
        });

        if (this.myPeers.size !== newPeers.size) {
            stateChanged = true;
        } else {
            newPeers.forEach((state, clientId) => {
                const oldState = this.myPeers.get(clientId);
                if (!oldState || JSON.stringify(oldState) !== JSON.stringify(state)) {
                    stateChanged = true;
                }
            });
        }

        if (stateChanged) {
            this.myPeers = newPeers;
            this.notifyPeersChanged();
        }
    }

    private notifyPeersChanged() {
        if (this.peerUpdateCallback) {
            this.peerUpdateCallback(this.getPeers());
        }
    }
}
