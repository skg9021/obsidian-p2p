
import * as Y from 'yjs';
import * as awarenessProtocol from 'y-protocols/awareness';
import { ConnectionStrategy, StrategyId } from './connection-strategy.interface';
import { Platform } from 'obsidian';
import { PeerInfo, ConnectionStatus } from '../p2p-types';
import { P2PSettings } from '../../settings'; // Needed for local strategy joinRoom config
import { YTrysteroProvider } from '../y-trystero';
import { joinRoom as joinLocalRoom } from '../trystero-local-strategy';
import { logger } from '../logger.service';

export class LocalStrategy implements ConnectionStrategy {
    id: StrategyId = 'local';
    name: string = 'Local Network (LAN)';

    private doc: Y.Doc | null = null;
    private awareness: awarenessProtocol.Awareness | null = null;
    private provider: any | null = null;

    // Track peers visible to THIS provider
    private myPeers: Map<number, any> = new Map();
    private peerUpdateCallback: ((peers: PeerInfo[]) => void) | null = null;
    private recomputeInterval: any = null;

    /** Callback for status changes */
    private statusCallback: (status: ConnectionStatus) => void = () => { };
    private currentStatus: ConnectionStatus = 'disconnected';

    constructor() {
    }

    initialize(doc: Y.Doc, awareness: awarenessProtocol.Awareness): void {
        this.doc = doc;
        this.awareness = awareness;
        if (this.awareness) {
            this.awareness.on('update', ({ added, removed, updated }: any, origin: any) => {
                this.handleAwarenessUpdate([...added, ...(updated || [])], removed, origin);
            });
        }
        logger.info('[LocalStrategy] Initialized with awareness: ', this.awareness);
    }

    async connect(roomName: string, settings: any): Promise<void> {
        // Local strategy handles both Host and Client modes.
        // It connects if either server is enabled (host) OR client is enabled + address set.

        let shouldConnect = false;
        let signalingUrl = '';

        // Host check uses Platform.isMobile (imported from obsidian) — see line below

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
            // logger.info('[LocalStrategy] Disabled or invalid settings. Skipping.');
            return;
        }

        if (!signalingUrl) {
            logger.error('[LocalStrategy] Missing signalingUrl in connect options');
            return;
        }

        // logger.info(`[LocalStrategy] Connecting to ${signalingUrl}...`);

        const password = settings.secretKey;
        if (!this.doc || !this.awareness) {
            throw new Error('LocalStrategy not initialized with doc and awareness');
        }
        if (this.provider) this.disconnect();

        // CRITICAL: provider.destroy() wipes awareness state to null.
        // Restore it so the clock bump below actually works and
        // TrysteroConn can broadcast a valid state to the remote peer.
        if (this.awareness && !this.awareness.getLocalState()) {
            logger.debug('[LocalStrategy] Restoring awareness state after disconnect wipe');
            this.awareness.setLocalState({
                name: settings.deviceName,
            });
        }

        const fullRoomName = `lan-${roomName}`;
        logger.info(`[LocalStrategy] Connecting to room: ${fullRoomName} via ${signalingUrl}`);
        this.emitStatus('connecting');

        try {
            // Create the Trystero room FIRST, then inject it into the provider.
            const trysteroRoom = joinLocalRoom({
                appId: 'obsidian-p2p-local',
                password: password || undefined,
                clientUrl: signalingUrl,
                settings: settings,
            }, fullRoomName);

            this.provider = new YTrysteroProvider(
                fullRoomName,
                this.doc,
                {
                    room: trysteroRoom,
                    awareness: this.awareness,
                    filterBcConns: false,
                    disableBc: true,
                }
            );

            // Bump the awareness clock so reconnecting peers see a higher clock
            // and fire an awareness update event (which triggers origin-based tracking).
            this.awareness.setLocalStateField('__reconnectedAt', Date.now());

            this.provider.on('status', (event: any) => {
                // When we connect, explicitly update our awareness state to force a broadcast
                if (event && event.connected === true && this.awareness) {
                    logger.debug('[LocalStrategy] Connected, forcing awareness broadcast');
                    this.emitStatus('connected');

                    // Briefly set a connecting timestamp to force awareness protocol to broadcast changesField('__reconnectedAt', Date.now());
                }
            });

            this.provider.on('peers', (event: any) => {
                // If we get any peer events, we are definitely connected to the signaling server
                this.emitStatus('connected');

                // Grace period: Wait 5 seconds before clearing local peers if WebRTC connections drop
                if (!this.provider?.room) return;
                const remainingRaw = this.provider.room.trysteroConns?.size || 0;
                logger.debug(`[LocalStrategy] peers event: remaining WebRTC conns=${remainingRaw}, tracked peers=${this.myPeers.size}`);

                if (remainingRaw === 0 && this.myPeers.size > 0) {
                    setTimeout(() => {
                        if (!this.provider?.room) return;
                        const stillEmpty = (this.provider.room.trysteroConns?.size || 0) === 0;
                        if (stillEmpty && this.myPeers.size > 0) {
                            logger.debug('[LocalStrategy] All WebRTC connections confirmed closed, clearing peers');
                            this.myPeers.clear();
                            this.notifyPeersChanged();
                        }
                    }, 5000);
                }
            });

            // Periodic fallback: if trysteroConns has active entries but myPeers is empty,
            // origin-based tracking missed the event — scan all awareness states.
            // NOTE: This interval only ADDS peers, never removes them.
            // Removal is handled by awareness `removed` events and the peers event above.
            this.recomputeInterval = setInterval(() => {
                if (!this.provider?.room || !this.awareness) return;

                // If we have active connections, we must be connected
                if (this.provider.room.trysteroConns?.size > 0) {
                    this.emitStatus('connected');
                }

                const hasConns = (this.provider.room.trysteroConns?.size || 0) > 0;

                if (hasConns && this.myPeers.size === 0) {
                    let changed = false;
                    this.awareness!.getStates().forEach((state, clientId) => {
                        if (clientId === this.awareness!.clientID) return;
                        if (!this.myPeers.has(clientId) && state.name) {
                            logger.debug(`[LocalStrategy] Fallback scan: adding peer ${state.name} (clientId=${clientId})`);
                            this.myPeers.set(clientId, state);
                            changed = true;
                        }
                    });
                    if (changed) this.notifyPeersChanged();
                }
            }, 2000);

            // Trigger initial peer check?
            // TrysteroProvider generally emits events when connected.

        } catch (e) {
            logger.error('[LocalStrategy] Failed to start TrysteroProvider', e);
            this.emitStatus('error');
            throw e;
        }
    }

    disconnect(): void {
        if (this.recomputeInterval) {
            clearInterval(this.recomputeInterval);
            this.recomputeInterval = null;
        }

        // Save awareness state BEFORE destroy wipes it to null
        const savedState = this.awareness?.getLocalState();

        if (this.provider) {
            try {
                if (this.provider.trystero && typeof this.provider.trystero.leave === 'function') {
                    this.provider.trystero.leave();
                }
                this.provider.destroy();
            } catch (e) {
                logger.error('[LocalStrategy] Error destroying provider', e);
            }
            this.provider = null;
            logger.info('[LocalStrategy] Disconnected');
        }

        // Restore awareness state (provider.destroy wipes it to null)
        if (this.awareness && savedState && !this.awareness.getLocalState()) {
            this.awareness.setLocalState(savedState);
        }

        this.myPeers.clear();
        this.notifyPeersChanged();
        this.emitStatus('disconnected');
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

    onStatusChanged(callback: (status: ConnectionStatus) => void): void {
        this.statusCallback = callback;
    }

    private emitStatus(status: ConnectionStatus) {
        if (this.currentStatus !== status) {
            this.currentStatus = status;
            this.statusCallback(status);
        }
    }

    getUnderlyingProvider(): any {
        return this.provider;
    }

    private handleAwarenessUpdate(addedOrUpdated: number[], removed: number[], origin: any) {
        if (!this.provider || !this.awareness) return;

        let changed = false;

        // Only track peers whose awareness updates arrived via OUR provider's WebRTC channel.
        // y-webrtc-trystero passes `room` as origin when applying awareness from WebRTC data.
        if (origin === this.provider.room) {
            for (const clientId of addedOrUpdated) {
                if (clientId === this.awareness.clientID) continue; // Skip self
                const state = this.awareness.getStates().get(clientId);
                if (state) {
                    const prev = this.myPeers.get(clientId);
                    if (!prev || JSON.stringify(prev) !== JSON.stringify(state)) {
                        logger.debug(`[LocalStrategy] Peer ${state.name || clientId} tracked via origin (clientId=${clientId})`);
                        this.myPeers.set(clientId, state);
                        changed = true;
                    }
                }
            }
        }

        // Handle removals regardless of origin (peer is globally gone)
        for (const clientId of removed) {
            if (this.myPeers.has(clientId)) {
                logger.debug(`[LocalStrategy] Peer removed (clientId=${clientId})`);
                this.myPeers.delete(clientId);
                changed = true;
            }
        }

        if (changed) this.notifyPeersChanged();
    }

    private notifyPeersChanged() {
        if (this.peerUpdateCallback) {
            this.peerUpdateCallback(this.getPeers());
        }
    }
}
