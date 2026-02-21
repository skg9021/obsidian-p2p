
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
    private activeNetworkIds: string[] = [];

    constructor(logger: Logger) {
        this.logger = logger;
    }

    initialize(doc: Y.Doc, awareness: awarenessProtocol.Awareness): void {
        this.doc = doc;
        this.awareness = awareness;

        // Listen to awareness updates to track which peers are associated with this provider
        // We do this by checking the origin of the update
        if (this.awareness) {
            this.awareness.on('update', ({ added, removed }: any, origin: any) => {
                this.handleAwarenessUpdate(added, removed, origin);
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

            this.provider.on('synced', (event: any) => {
                // console.log(`[MqttStrategy] Synced:`, event);
            });

            this.provider.on('peers', (event: any) => {
                if (event && event.length > 0) {
                    this.activeNetworkIds = event[0].trysteroPeers || [];
                    this.recomputePeers();
                }
            });

        } catch (e) {
            this.logger.error('[MqttStrategy] Failed to start TrysteroProvider', e);
            throw e;
        }
    }

    disconnect(): void {
        if (this.provider) {
            // @ts-ignore
            closeAllClients(); // Close Trystero MQTT clients
            this.provider.destroy();
            this.provider = null;
            this.logger.log('[MqttStrategy] Disconnected');
        }

        // Clear peers tracked by this strategy
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
