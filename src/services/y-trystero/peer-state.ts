import * as encoding from 'lib0/encoding';
import * as decoding from 'lib0/decoding';
import * as syncProtocol from 'y-protocols/sync';
import * as awarenessProtocol from 'y-protocols/awareness';
import type { Doc } from 'yjs';
import type { Awareness } from 'y-protocols/awareness';
import type { SendAction } from './types';

// Message type constants — matches y-webrtc protocol exactly
const MESSAGE_SYNC = 0;
const MESSAGE_AWARENESS = 1;
const MESSAGE_QUERY_AWARENESS = 3;

/**
 * Tracks Y.js sync state for a single remote peer.
 *
 * When a peer joins, we immediately send:
 * 1. Sync step 1 (our state vector, so the peer knows what to send us)
 * 2. Full awareness state (so the peer sees all connected users)
 *
 * The peer responds with sync step 2 (the actual document diff).
 * Once we receive sync step 2, we consider this peer "synced".
 */
export class PeerState {
    readonly remotePeerId: string;
    synced = false;
    connected = true;

    constructor(
        remotePeerId: string,
        private readonly doc: Doc,
        private readonly awareness: Awareness,
        private readonly send: SendAction<Uint8Array>,
        private readonly room: object,
    ) {
        this.remotePeerId = remotePeerId;
        this.initSync();
    }

    /**
     * Send sync step 1 + full awareness state to the peer.
     * Called once immediately after connection.
     */
    private initSync(): void {
        // Sync step 1: send our state vector
        const syncEncoder = encoding.createEncoder();
        encoding.writeVarUint(syncEncoder, MESSAGE_SYNC);
        syncProtocol.writeSyncStep1(syncEncoder, this.doc);
        this.sendData(encoding.toUint8Array(syncEncoder));

        // Awareness: send full awareness state
        const awarenessStates = this.awareness.getStates();
        if (awarenessStates.size > 0) {
            const awarenessEncoder = encoding.createEncoder();
            encoding.writeVarUint(awarenessEncoder, MESSAGE_AWARENESS);
            encoding.writeVarUint8Array(
                awarenessEncoder,
                awarenessProtocol.encodeAwarenessUpdate(
                    this.awareness,
                    Array.from(awarenessStates.keys()),
                ),
            );
            this.sendData(encoding.toUint8Array(awarenessEncoder));
        }
    }

    /**
     * Process an incoming message from this peer.
     * Returns an encoded reply if one is needed, or null.
     */
    handleMessage(data: Uint8Array): Uint8Array | null {
        const decoder = decoding.createDecoder(data);
        const encoder = encoding.createEncoder();
        const messageType = decoding.readVarUint(decoder);
        let sendReply = false;

        switch (messageType) {
            case MESSAGE_SYNC: {
                encoding.writeVarUint(encoder, MESSAGE_SYNC);
                const syncMessageType = syncProtocol.readSyncMessage(
                    decoder,
                    encoder,
                    this.doc,
                    this.room, // origin — mqtt-strategy checks `origin === provider.room`
                );
                if (syncMessageType === syncProtocol.messageYjsSyncStep2 && !this.synced) {
                    this.synced = true;
                }
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
                    this.room, // origin — so mqtt-strategy can attribute this peer to this provider
                );
                break;
            }
            default:
                console.error('[y-trystero] Unknown message type:', messageType);
                return null;
        }

        return sendReply ? encoding.toUint8Array(encoder) : null;
    }

    /**
     * Mark this peer as disconnected.
     */
    onClose(): void {
        this.connected = false;
    }

    private sendData(data: Uint8Array): void {
        try {
            this.send(data, this.remotePeerId);
        } catch (e) {
            console.error(`[y-trystero] Error sending to ${this.remotePeerId}:`, e);
        }
    }
}
