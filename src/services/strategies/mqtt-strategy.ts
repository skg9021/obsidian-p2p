
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
                // console.log(`[MqttStrategy] Trystero peers changed:`, event);
                // The provider emits 'peers', but awareness is the source of truth for user info.
                // We rely on awareness logic to populate 'myPeers' map.
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
        // TrysteroProvider (or y-webrtc-trystero) typically sets origin as the provider instance
        // or an object containing room info?
        // In the original code: `const roomName = origin?.roomName || origin?.room?.name;`

        // If the origin matches THIS provider's signature, we track/untrack the client IDs.

        // For TrysteroProvider, we need to verify how it sets origin.
        // Assuming it sets 'this' (the provider itself) or an object with roomName matching ours.

        let isFromMe = false;

        this.logger.debug('[MqttStrategy] Awareness update:', { added, removed, origin });

        if (origin === this.provider) {
            isFromMe = true;
        } else if (origin && typeof origin === 'object') {
            // Check if origin is the Room object which has a reference to the provider
            if (origin.provider && origin.provider === this.provider) {
                isFromMe = true;
            } else {
                const originRoom = origin.roomName || origin.room?.name || origin.name;
                const myRoom = this.provider?.roomName;

                this.logger.trace(`[MqttStrategy] Origin check: originRoom=${originRoom}, myRoom=${myRoom}`);

                // Our room name includes 'mqtt-' prefix
                if (originRoom && myRoom && myRoom === originRoom) {
                    isFromMe = true;
                }
            }
        }

        if (!isFromMe) {
            this.logger.trace('[MqttStrategy] Ignoring awareness update from other origin');
            // Check implicit: if I am the ONLY provider, assume it's me? 
            // Risky if we have multiple.
            // But if 'origin' is null/undefined (local changes), we ignore.
            // Remote changes usually have origin.
            return;
        }

        if (!this.awareness) return;

        if (added) {
            added.forEach(clientId => {
                // awareness.getStates() returns map.
                const allStates = this.awareness!.getStates();
                const clientState = allStates.get(clientId);
                if (clientState) {
                    this.myPeers.set(clientId, clientState);
                }
            });
        }

        if (removed) {
            removed.forEach(clientId => {
                this.myPeers.delete(clientId);
            });
        }

        // Also update existing peers states if they changed?
        // Awareness 'change' event covers additions/removals/updates.
        // If it's an update to existing peer, it usually comes in 'added' or 'updated'?
        // The awareness event sig is ({ added, updated, removed }, origin)

        // We should check 'updated' too.
        // But for simply tracking "Who is connected via Me", added/removed is key.
        // For "What is their latest state", we rely on accessing awareness.getStates() 

        // Let's re-scan all 'myPeers' to ensure we have latest data (like name changes)
        // actually we just store the ID in myPeers? 
        // No, we store state.

        // Let's safe-guard: Refill myPeers from awareness for all known IDs
        this.myPeers.forEach((_, clientId) => {
            const state = this.awareness!.getStates().get(clientId);
            if (state) {
                this.myPeers.set(clientId, state);
            } else {
                // Should have been removed, but just in case
                this.myPeers.delete(clientId);
            }
        });

        this.notifyPeersChanged();
    }

    private notifyPeersChanged() {
        if (this.peerUpdateCallback) {
            this.peerUpdateCallback(this.getPeers());
        }
    }
}
