import * as bc from 'lib0/broadcastchannel';
import * as encoding from 'lib0/encoding';
import * as decoding from 'lib0/decoding';
import * as math from 'lib0/math';
import * as random from 'lib0/random';
import { createMutex } from 'lib0/mutex';
import { ObservableV2 } from 'lib0/observable';

import * as Y from 'yjs';
import * as syncProtocol from 'y-protocols/sync';
import * as awarenessProtocol from 'y-protocols/awareness';

import { PeerState } from './peer-state';
import type { TrysteroRoom, YTrysteroProviderOptions, YTrysteroProviderEvents, SendAction } from './types';

// Message type constants — matches y-webrtc protocol
const MESSAGE_SYNC = 0;
const MESSAGE_AWARENESS = 1;
const MESSAGE_QUERY_AWARENESS = 3;
const MESSAGE_BC_PEER_ID = 4;

/**
 * Y.js document synchronization provider backed by a Trystero room.
 *
 * Key design decisions:
 * - `makeAction()` is called FIRST, before any peer join handlers —
 *   this eliminates the race condition in y-webrtc-trystero where
 *   fast-connecting peers were silently dropped.
 * - The Trystero Room is injected via the constructor, making the
 *   provider backend-agnostic (MQTT, Firebase, IPFS, etc.).
 * - A single action channel ('yjs') is used for all messages,
 *   preserving message ordering.
 * - Awareness updates pass `this.room` as `origin`, so consumers
 *   can attribute peers to this specific provider instance.
 */
export class YTrysteroProvider extends ObservableV2<YTrysteroProviderEvents> {
    readonly doc: Y.Doc;
    readonly awareness: awarenessProtocol.Awareness;
    readonly maxConns: number;
    readonly filterBcConns: boolean;
    readonly roomName: string;

    /**
     * Public room reference. Used by mqtt-strategy for:
     * - `provider.room.trysteroConns.size` (connection count)
     * - `origin === provider.room` (awareness attribution)
     */
    readonly room: {
        readonly trysteroConns: Map<string, PeerState>;
    };

    /** The underlying Trystero room (for advanced consumers) */
    readonly trystero: TrysteroRoom;

    // ─── Private State ───────────────────────────────────────
    private readonly trysteroConns: Map<string, PeerState> = new Map();
    private readonly bcConns: Set<string> = new Set();
    private readonly peerId: string;
    private readonly mux = createMutex();
    private readonly disableBc: boolean;

    private sendYjs!: SendAction<Uint8Array>;
    private bcConnected = false;
    private synced = false;
    private destroyed = false;

    // ─── Bound Handlers (for cleanup) ────────────────────────
    private readonly _docUpdateHandler: (update: Uint8Array, origin: any) => void;
    private readonly _awarenessUpdateHandler: (changes: { added: number[]; updated: number[]; removed: number[] }, origin: any) => void;
    private readonly _bcSubscriber: (data: ArrayBuffer) => void;
    private readonly _beforeUnloadHandler: () => void;
    private readonly _destroyHandler: () => void;

    constructor(
        roomName: string,
        doc: Y.Doc,
        options: YTrysteroProviderOptions,
    ) {
        super();
        this.doc = doc;
        this.roomName = roomName;
        this.trystero = options.room;
        this.awareness = options.awareness ?? new awarenessProtocol.Awareness(doc);
        this.maxConns = options.maxConns ?? (20 + math.floor(random.rand() * 15));
        this.filterBcConns = options.filterBcConns ?? true;
        this.disableBc = options.disableBc ?? false;
        this.peerId = random.uuidv4();

        // Expose trysteroConns as a public readonly property via `room`
        this.room = { trysteroConns: this.trysteroConns };

        // ─── CRITICAL: Set up makeAction BEFORE registering peer handlers ───
        // This is the fix for the race condition in y-webrtc-trystero.
        // If a peer announces itself before makeAction is called, Trystero
        // drops the message with "received message with unregistered type".
        this.setupActions();

        // ─── Register Trystero lifecycle handlers ───
        this.setupPeerHandlers();

        // ─── Bind doc + awareness update handlers ───
        this._docUpdateHandler = this.onDocUpdate.bind(this);
        this._awarenessUpdateHandler = this.onAwarenessUpdate.bind(this);
        this._bcSubscriber = this.onBcMessage.bind(this);
        this._beforeUnloadHandler = () => {
            awarenessProtocol.removeAwarenessStates(this.awareness, [doc.clientID], 'window unload');
        };
        this._destroyHandler = this.destroy.bind(this);

        // ─── Connect to doc ───
        this.doc.on('update', this._docUpdateHandler);
        this.awareness.on('update', this._awarenessUpdateHandler);
        this.doc.on('destroy', this._destroyHandler);

        if (typeof window !== 'undefined') {
            window.addEventListener('beforeunload', this._beforeUnloadHandler);
        }

        // ─── BroadcastChannel (same-tab sync) ───
        if (!this.disableBc) {
            this.connectBc();
        }

        // Emit initial status
        this.emit('status', [{ connected: true }]);
    }

    // ═══════════════════════════════════════════════════════════
    // Setup
    // ═══════════════════════════════════════════════════════════

    private setupActions(): void {
        const [sendYjs, listenYjs] = this.trystero.makeAction<Uint8Array>('docdata');
        this.sendYjs = sendYjs;

        listenYjs((data: Uint8Array, peerId: string) => {
            if (this.destroyed) return;

            const peerState = this.trysteroConns.get(peerId);
            if (!peerState) {
                // Peer sent data but we haven't processed their join yet.
                // This can happen if makeAction delivers data before onPeerJoin fires.
                // Queue a late join.
                this.onPeerJoin(peerId);
                const newPeer = this.trysteroConns.get(peerId);
                if (!newPeer) return;
                const reply = newPeer.handleMessage(new Uint8Array(data));
                if (reply) this.sendYjs(reply, peerId);
                return;
            }

            const reply = peerState.handleMessage(new Uint8Array(data));
            if (reply) {
                this.sendYjs(reply, peerId);
            }

            this.checkSynced();
        });
    }

    private setupPeerHandlers(): void {
        this.trystero.onPeerJoin((peerId: string) => {
            this.onPeerJoin(peerId);
        });

        this.trystero.onPeerLeave((peerId: string) => {
            this.onPeerLeave(peerId);
        });
    }

    // ═══════════════════════════════════════════════════════════
    // Peer Lifecycle
    // ═══════════════════════════════════════════════════════════

    private onPeerJoin(peerId: string): void {
        if (this.trysteroConns.has(peerId)) return;
        if (this.trysteroConns.size >= this.maxConns) return;

        const peerState = new PeerState(
            peerId,
            this.doc,
            this.awareness,
            this.sendYjs,
            this.room, // passed as origin for awareness updates
        );

        this.trysteroConns.set(peerId, peerState);

        this.emit('peers', [{
            added: [peerId],
            removed: [],
            trysteroConns: Array.from(this.trysteroConns.keys()),
            bcPeers: Array.from(this.bcConns),
        }]);
    }

    private onPeerLeave(peerId: string): void {
        const peerState = this.trysteroConns.get(peerId);
        if (!peerState) return;

        peerState.onClose();
        this.trysteroConns.delete(peerId);

        this.emit('peers', [{
            removed: [peerId],
            added: [],
            trysteroConns: Array.from(this.trysteroConns.keys()),
            bcPeers: Array.from(this.bcConns),
        }]);

        this.checkSynced();
    }

    // ═══════════════════════════════════════════════════════════
    // Doc + Awareness Handlers (broadcast to all peers)
    // ═══════════════════════════════════════════════════════════

    private onDocUpdate(update: Uint8Array, _origin: any): void {
        const encoder = encoding.createEncoder();
        encoding.writeVarUint(encoder, MESSAGE_SYNC);
        syncProtocol.writeUpdate(encoder, update);
        const msg = encoding.toUint8Array(encoder);
        this.broadcastToTrysteroPeers(msg);
        if (this.bcConnected) this.broadcastBcMessage(msg);
    }

    private onAwarenessUpdate(
        { added, updated, removed }: { added: number[]; updated: number[]; removed: number[] },
        _origin: any,
    ): void {
        const changedClients = [...added, ...updated, ...removed];
        const encoder = encoding.createEncoder();
        encoding.writeVarUint(encoder, MESSAGE_AWARENESS);
        encoding.writeVarUint8Array(
            encoder,
            awarenessProtocol.encodeAwarenessUpdate(this.awareness, changedClients),
        );
        const msg = encoding.toUint8Array(encoder);
        this.broadcastToTrysteroPeers(msg);
        if (this.bcConnected) this.broadcastBcMessage(msg);
    }

    // ═══════════════════════════════════════════════════════════
    // Transport: Trystero
    // ═══════════════════════════════════════════════════════════

    private broadcastToTrysteroPeers(msg: Uint8Array): void {
        this.trysteroConns.forEach((_peer, peerId) => {
            try {
                this.sendYjs(msg, peerId);
            } catch (e) {
                // Peer may have disconnected
            }
        });
    }

    // ═══════════════════════════════════════════════════════════
    // Transport: BroadcastChannel (same-tab sync)
    // ═══════════════════════════════════════════════════════════

    private connectBc(): void {
        bc.subscribe(this.roomName, this._bcSubscriber);
        this.bcConnected = true;

        // Announce our peerId via BC
        this.broadcastBcPeerId();

        // Send sync step 1 via BC
        const syncEncoder = encoding.createEncoder();
        encoding.writeVarUint(syncEncoder, MESSAGE_SYNC);
        syncProtocol.writeSyncStep1(syncEncoder, this.doc);
        this.broadcastBcMessage(encoding.toUint8Array(syncEncoder));

        // Send full doc state via BC
        const stateEncoder = encoding.createEncoder();
        encoding.writeVarUint(stateEncoder, MESSAGE_SYNC);
        syncProtocol.writeSyncStep2(stateEncoder, this.doc);
        this.broadcastBcMessage(encoding.toUint8Array(stateEncoder));

        // Query awareness via BC
        const queryEncoder = encoding.createEncoder();
        encoding.writeVarUint(queryEncoder, MESSAGE_QUERY_AWARENESS);
        this.broadcastBcMessage(encoding.toUint8Array(queryEncoder));

        // Broadcast our awareness state via BC
        const awarenessEncoder = encoding.createEncoder();
        encoding.writeVarUint(awarenessEncoder, MESSAGE_AWARENESS);
        encoding.writeVarUint8Array(
            awarenessEncoder,
            awarenessProtocol.encodeAwarenessUpdate(this.awareness, [this.doc.clientID]),
        );
        this.broadcastBcMessage(encoding.toUint8Array(awarenessEncoder));
    }

    private disconnectBc(): void {
        // Announce removal via BC
        const encoder = encoding.createEncoder();
        encoding.writeVarUint(encoder, MESSAGE_BC_PEER_ID);
        encoding.writeUint8(encoder, 0); // remove
        encoding.writeVarString(encoder, this.peerId);
        this.broadcastBcMessage(encoding.toUint8Array(encoder));

        bc.unsubscribe(this.roomName, this._bcSubscriber);
        this.bcConnected = false;
    }

    private onBcMessage(data: ArrayBuffer): void {
        this.mux(() => {
            const buf = new Uint8Array(data);
            const decoder = decoding.createDecoder(buf);
            const encoder = encoding.createEncoder();
            const messageType = decoding.readVarUint(decoder);
            let sendReply = false;

            switch (messageType) {
                case MESSAGE_SYNC: {
                    encoding.writeVarUint(encoder, MESSAGE_SYNC);
                    const syncMessageType = syncProtocol.readSyncMessage(
                        decoder, encoder, this.doc, this.room,
                    );
                    if (syncMessageType === syncProtocol.messageYjsSyncStep1) {
                        sendReply = true;
                    }
                    break;
                }
                case MESSAGE_QUERY_AWARENESS: {
                    encoding.writeVarUint(encoder, MESSAGE_AWARENESS);
                    encoding.writeVarUint8Array(
                        encoder,
                        awarenessProtocol.encodeAwarenessUpdate(
                            this.awareness,
                            Array.from(this.awareness.getStates().keys()),
                        ),
                    );
                    sendReply = true;
                    break;
                }
                case MESSAGE_AWARENESS: {
                    awarenessProtocol.applyAwarenessUpdate(
                        this.awareness,
                        decoding.readVarUint8Array(decoder),
                        this.room,
                    );
                    break;
                }
                case MESSAGE_BC_PEER_ID: {
                    const add = decoding.readUint8(decoder) === 1;
                    const peerName = decoding.readVarString(decoder);
                    if (peerName !== this.peerId) {
                        if (add && !this.bcConns.has(peerName)) {
                            this.bcConns.add(peerName);
                            this.emit('peers', [{
                                added: [peerName], removed: [],
                                trysteroConns: Array.from(this.trysteroConns.keys()),
                                bcPeers: Array.from(this.bcConns),
                            }]);
                            this.broadcastBcPeerId();
                        } else if (!add && this.bcConns.has(peerName)) {
                            this.bcConns.delete(peerName);
                            this.emit('peers', [{
                                added: [], removed: [peerName],
                                trysteroConns: Array.from(this.trysteroConns.keys()),
                                bcPeers: Array.from(this.bcConns),
                            }]);
                        }
                    }
                    break;
                }
            }

            if (sendReply) {
                this.broadcastBcMessage(encoding.toUint8Array(encoder));
            }
        });
    }

    private broadcastBcMessage(msg: Uint8Array): void {
        this.mux(() => {
            bc.publish(this.roomName, msg);
        });
    }

    private broadcastBcPeerId(): void {
        if (!this.filterBcConns) return;
        const encoder = encoding.createEncoder();
        encoding.writeVarUint(encoder, MESSAGE_BC_PEER_ID);
        encoding.writeUint8(encoder, 1); // add
        encoding.writeVarString(encoder, this.peerId);
        this.broadcastBcMessage(encoding.toUint8Array(encoder));
    }

    // ═══════════════════════════════════════════════════════════
    // Sync State
    // ═══════════════════════════════════════════════════════════

    private checkSynced(): void {
        let allSynced = true;
        this.trysteroConns.forEach((peer) => {
            if (!peer.synced) allSynced = false;
        });

        if (allSynced !== this.synced) {
            this.synced = allSynced;
            this.emit('synced', [{ synced: allSynced }]);
        }
    }

    // ═══════════════════════════════════════════════════════════
    // Lifecycle
    // ═══════════════════════════════════════════════════════════

    destroy(): void {
        if (this.destroyed) return;
        this.destroyed = true;

        // Unsubscribe from doc + awareness
        this.doc.off('update', this._docUpdateHandler);
        this.doc.off('destroy', this._destroyHandler);
        this.awareness.off('update', this._awarenessUpdateHandler);

        // Disconnect BC
        if (this.bcConnected) {
            this.disconnectBc();
        }

        // Remove awareness states
        awarenessProtocol.removeAwarenessStates(
            this.awareness,
            [this.doc.clientID],
            'provider destroy',
        );

        // Clean up peers
        this.trysteroConns.forEach((peer) => peer.onClose());
        this.trysteroConns.clear();

        // Clean up window listener
        if (typeof window !== 'undefined') {
            window.removeEventListener('beforeunload', this._beforeUnloadHandler);
        }

        this.emit('status', [{ connected: false }]);
        this.emit('destroy', []);
        super.destroy();
    }
}
