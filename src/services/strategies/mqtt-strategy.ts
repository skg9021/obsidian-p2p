
import * as Y from 'yjs';
import * as awarenessProtocol from 'y-protocols/awareness';
import { ConnectionStrategy, StrategyId } from './connection-strategy.interface';
import { PeerInfo } from '../p2p-types';
// @ts-ignore
import { TrysteroProvider } from '@winstonfassett/y-webrtc-trystero';
// @ts-ignore
import { joinRoom, closeAllClients } from 'trystero/mqtt';
import { Logger } from '../logger.service';

export class MqttStrategy implements ConnectionStrategy {
    id: StrategyId = 'mqtt';
    name: string = 'MQTT (Internet)';

    private doc: Y.Doc | null = null;
    private awareness: awarenessProtocol.Awareness | null = null;
    private provider: any | null = null;
    private logger: Logger;

    // Track peers visible to THIS provider
    private myPeers: Map<number, any> = new Map();
    private peerUpdateCallback: ((peers: PeerInfo[]) => void) | null = null;
    private recomputeInterval: any = null;

    constructor(logger: Logger) {
        this.logger = logger;
    }

    initialize(doc: Y.Doc, awareness: awarenessProtocol.Awareness): void {
        this.doc = doc;
        this.awareness = awareness;

        // Listen to awareness updates to track which peers are associated with this provider
        // We do this by checking the origin of the update
        if (this.awareness) {
            this.awareness.on('update', ({ added, removed, updated }: any, origin: any) => {
                this.handleAwarenessUpdate([...added, ...(updated || [])], removed, origin);
            });
        }
    }

    async connect(roomName: string, settings: any): Promise<void> {
        if (!this.doc || !this.awareness) {
            throw new Error('MqttStrategy not initialized with doc and awareness');
        }

        if (!settings.enableMqttDiscovery) {
            this.logger.log('[MqttStrategy] Disabled in settings. Skipping.');
            return;
        }

        if (this.provider) {
            this.disconnect();
        }

        // CRITICAL: provider.destroy() wipes awareness state to null.
        // Restore it so the clock bump below actually works.
        if (this.awareness && !this.awareness.getLocalState()) {
            this.logger.debug('[MqttStrategy] Restoring awareness state after disconnect wipe');
            this.awareness.setLocalState({
                name: settings.deviceName,
            });
        }

        const relayUrls = settings.discoveryServer
            ? [settings.discoveryServer]
            : undefined;

        const mqttCredentials = settings.mqttUsername
            ? { username: settings.mqttUsername, password: settings.mqttPassword || '' }
            : undefined;
        const password = settings.secretKey;

        const fullRoomName = `mqtt-${roomName}`;

        console.log(`[MqttStrategy] Connecting to room: ${fullRoomName}`);

        try {
            this.provider = new TrysteroProvider(
                fullRoomName,
                this.doc,
                {
                    awareness: this.awareness,
                    filterBcConns: false,
                    disableBc: true,
                    joinRoom: (config: any, roomId: string) => {
                        return joinRoom({
                            ...config,
                            appId: config.appId || 'obsidian-p2p-sync',
                            password: password || undefined,
                            ...(relayUrls && relayUrls.length > 0 ? { relayUrls } : {}),
                            ...(mqttCredentials?.username ? {
                                mqttUsername: mqttCredentials.username,
                                mqttPassword: mqttCredentials.password,
                            } : {}),
                        }, roomId);
                    },
                    password: password || undefined,
                }
            );

            // Bump the awareness clock so reconnecting peers see a higher clock
            this.awareness.setLocalStateField('__reconnectedAt', Date.now());

            this.provider.on('status', (event: any) => {
                if (event && event.connected === true && this.awareness) {
                    this.logger?.debug('[MqttStrategy] Connected, forcing awareness broadcast');
                    this.awareness.setLocalStateField('__reconnectedAt', Date.now());
                }
            });

            this.provider.on('synced', (event: any) => {
                // console.log(`[MqttStrategy] Synced:`, event);
            });

            this.provider.on('peers', (event: any) => {
                if (!this.provider?.room) return;
                const remaining = this.provider.room.trysteroConns?.size || 0;
                this.logger.debug(`[MqttStrategy] peers event: remaining WebRTC conns=${remaining}, tracked peers=${this.myPeers.size}`);
                if (remaining === 0 && this.myPeers.size > 0) {
                    setTimeout(() => {
                        if (!this.provider?.room) return;
                        const stillEmpty = (this.provider.room.trysteroConns?.size || 0) === 0;
                        if (stillEmpty && this.myPeers.size > 0) {
                            this.logger.debug('[MqttStrategy] All WebRTC connections confirmed closed, clearing peers');
                            this.myPeers.clear();
                            this.notifyPeersChanged();
                        }
                    }, 5000);
                }
            });

            // Periodic fallback: only ADDS peers, never removes.
            this.recomputeInterval = setInterval(() => {
                if (!this.provider?.room || !this.awareness) return;
                const hasConns = (this.provider.room.trysteroConns?.size || 0) > 0;

                if (hasConns && this.myPeers.size === 0) {
                    let changed = false;
                    this.awareness!.getStates().forEach((state, clientId) => {
                        if (clientId === this.awareness!.clientID) return;
                        if (!this.myPeers.has(clientId) && state.name) {
                            this.logger.debug(`[MqttStrategy] Fallback scan: adding peer ${state.name} (clientId=${clientId})`);
                            this.myPeers.set(clientId, state);
                            changed = true;
                        }
                    });
                    if (changed) this.notifyPeersChanged();
                }
            }, 2000);

        } catch (e) {
            this.logger.error('[MqttStrategy] Failed to start TrysteroProvider', e);
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
            // @ts-ignore
            closeAllClients();
            this.provider.destroy();
            this.provider = null;
            this.logger.log('[MqttStrategy] Disconnected');
        }

        // Restore awareness state (provider.destroy wipes it to null)
        if (this.awareness && savedState && !this.awareness.getLocalState()) {
            this.awareness.setLocalState(savedState);
        }

        this.myPeers.clear();
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
                source: 'internet' // Self-identified source
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
                        this.logger.debug(`[MqttStrategy] Peer ${state.name || clientId} tracked via origin (clientId=${clientId})`);
                        this.myPeers.set(clientId, state);
                        changed = true;
                    }
                }
            }
        }

        // Handle removals regardless of origin (peer is globally gone)
        for (const clientId of removed) {
            if (this.myPeers.has(clientId)) {
                this.logger.debug(`[MqttStrategy] Peer removed (clientId=${clientId})`);
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
