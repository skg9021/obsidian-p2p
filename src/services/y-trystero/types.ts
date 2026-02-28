import type { Awareness } from 'y-protocols/awareness';

// ─── Trystero Room Interface ────────────────────────────────
// Minimal interface matching what Trystero's joinRoom() returns.
// Works with any backend: MQTT, Firebase, IPFS, Nostr, etc.

export type SendAction<T = any> = (data: T, targetPeerId?: string) => Promise<void>;
export type ListenAction<T = any> = (callback: (data: T, peerId: string) => void) => void;

/**
 * Minimal interface for a Trystero Room.
 * 
 * This avoids tightly coupling to any specific Trystero version. Any object
 * returned by trystero's `joinRoom()` satisfies this interface.
 */
export interface TrysteroRoom {
    makeAction<T = any>(type: string): [SendAction<T>, ListenAction<T>];
    onPeerJoin(callback: (peerId: string) => void): void;
    onPeerLeave(callback: (peerId: string) => void): void;
    leave(): Promise<void>;
    getPeers(): Record<string, RTCPeerConnection>;
}

// ─── Provider Options ───────────────────────────────────────

export interface YTrysteroProviderOptions {
    /** Pre-created Trystero room. The provider does NOT own lifecycle of this room. */
    room: TrysteroRoom;
    /** Awareness instance. If not provided, a new one will be created. */
    awareness?: Awareness;
    /** Maximum number of peer connections to accept. Defaults to 20–34 (randomized). */
    maxConns?: number;
    /** Disable BroadcastChannel for same-tab sync. Defaults to false. */
    disableBc?: boolean;
    /** Filter BC connections using peerId. Defaults to true. */
    filterBcConns?: boolean;
}

// ─── Provider Events ────────────────────────────────────────

export interface YTrysteroProviderEvents {
    status: (event: { connected: boolean }) => void;
    synced: (event: { synced: boolean }) => void;
    peers: (event: {
        added: string[];
        removed: string[];
        trysteroConns: string[];
        bcPeers: string[];
    }) => void;
    destroy: () => void;
}
