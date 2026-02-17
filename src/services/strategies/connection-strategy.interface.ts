
import * as Y from 'yjs';
import * as awarenessProtocol from 'y-protocols/awareness';
import { PeerInfo } from '../p2p-types';

export type StrategyId = 'mqtt' | 'local' | string;

export interface ConnectionStrategy {
    id: StrategyId;
    name: string; // Human readable name

    /**
     * Initialize the strategy with the document and awareness instance.
     * Use this to set up event listeners on the awareness or doc if needed.
     */
    initialize(doc: Y.Doc, awareness: awarenessProtocol.Awareness): void;

    /**
     * Connect to the signaling server/room.
     * @param roomName Base room name (strategies may append prefixes like 'mqtt-' or 'lan-')
     * @param settings The full P2P settings object. Strategies should check their specific settings.
     */
    connect(roomName: string, settings: any): Promise<void>;

    /**
     * Disconnect from the room/signaling.
     */
    disconnect(): void;

    /**
     * Permanent teardown of the strategy.
     */
    destroy(): void;

    // Status
    isConnected(): boolean;

    /**
     * Get list of peers currently visible to this strategy.
     * Note: Since awareness is shared, this requires the strategy to track 
     * which peers came from its own provider/origin.
     */
    getPeers(): PeerInfo[];

    // Events
    /**
     * Subscribe to peer updates specific to this strategy.
     */
    onPeerUpdate(callback: (peers: PeerInfo[]) => void): void;

    /**
     * Returns the underlying provider instance (e.g. TrysteroProvider).
     * Used for file transfer actions.
     */
    getUnderlyingProvider(): any;
}
