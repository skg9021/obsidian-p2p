import { Notice } from 'obsidian';
import { P2PSettings } from '../settings';

type SignalType = 'HELLO' | 'OFFER' | 'ANSWER' | 'CANDIDATE';
export interface SignalMessage {
    type: SignalType;
    sender: string;
    target?: string;
    payload: any;
}

export type SyncType = 'YJS_UPDATE' | 'YJS_SYNC_STEP_1' | 'YJS_SYNC_STEP_2';
export interface SyncMessage {
    type: SyncType;
    data: string; // Base64 encoded Uint8Array
}

export class WebrtcService {
    peers: Map<string, RTCPeerConnection> = new Map();
    dataChannels: Map<string, RTCDataChannel> = new Map();

    private onSyncMessageCallback: (msg: SyncMessage) => void = () => { };
    private onSignalCallback: (type: SignalType, target: string, payload: any) => Promise<void> = async () => { };
    private onGetYjsStateVector: () => Uint8Array = () => new Uint8Array();

    constructor(private settings: P2PSettings) { }

    setCallbacks(
        onSyncMessage: (msg: SyncMessage) => void,
        onSignal: (type: SignalType, target: string, payload: any) => Promise<void>,
        onGetYjsStateVector: () => Uint8Array
    ) {
        this.onSyncMessageCallback = onSyncMessage;
        this.onSignalCallback = onSignal;
        this.onGetYjsStateVector = onGetYjsStateVector;
    }

    destroy() {
        this.peers.forEach(p => p.close());
        this.peers.clear();
        this.dataChannels.clear();
    }

    async handleSignal(msg: SignalMessage) {
        if (msg.sender === this.settings.deviceName) return;
        if (msg.target && msg.target !== this.settings.deviceName) return;

        const peerId = msg.sender;

        switch (msg.type) {
            case 'HELLO':
                if (this.settings.deviceName > peerId) this.createPeer(peerId, true);
                break;
            case 'OFFER':
                await this.createPeer(peerId, false);
                const pc = this.peers.get(peerId);
                if (pc) {
                    await pc.setRemoteDescription(new RTCSessionDescription(msg.payload));
                    const answer = await pc.createAnswer();
                    await pc.setLocalDescription(answer);
                    this.onSignalCallback('ANSWER', peerId, answer);
                }
                break;
            case 'ANSWER':
                const pc2 = this.peers.get(peerId);
                if (pc2) await pc2.setRemoteDescription(new RTCSessionDescription(msg.payload));
                break;
            case 'CANDIDATE':
                const pc3 = this.peers.get(peerId);
                if (pc3) await pc3.addIceCandidate(new RTCIceCandidate(msg.payload));
                break;
        }
    }

    getIceServers() {
        try {
            return JSON.parse(this.settings.iceServersJSON);
        } catch (e) {
            console.error("Invalid STUN/TURN JSON", e);
            return [{ urls: 'stun:stun.l.google.com:19302' }];
        }
    }

    async createPeer(remoteId: string, initiator: boolean) {
        if (this.peers.has(remoteId)) return;

        const pc = new RTCPeerConnection({ iceServers: this.getIceServers() });
        this.peers.set(remoteId, pc);

        pc.onicecandidate = (event) => {
            if (event.candidate) this.onSignalCallback('CANDIDATE', remoteId, event.candidate);
        };

        pc.onconnectionstatechange = () => {
            if (pc.connectionState === 'connected') {
                new Notice(`Connected to ${remoteId}`);
                const vector = this.onGetYjsStateVector();
                this.sendToPeer(remoteId, 'YJS_SYNC_STEP_1', vector);
            } else if (pc.connectionState === 'disconnected' || pc.connectionState === 'failed') {
                this.peers.delete(remoteId);
                this.dataChannels.delete(remoteId);
                new Notice(`Disconnected: ${remoteId}`);
            }
        };

        if (initiator) {
            const dc = pc.createDataChannel("obsidian-sync");
            this.setupDataChannel(dc, remoteId);
            const offer = await pc.createOffer();
            await pc.setLocalDescription(offer);
            this.onSignalCallback('OFFER', remoteId, offer);
        } else {
            pc.ondatachannel = (event) => { this.setupDataChannel(event.channel, remoteId); };
        }
    }

    setupDataChannel(dc: RTCDataChannel, remoteId: string) {
        dc.onopen = () => { this.dataChannels.set(remoteId, dc); };
        dc.onmessage = (event) => { this.onSyncMessageCallback(JSON.parse(event.data)); };
    }

    sendToPeer(peerId: string, type: SyncType, data: Uint8Array) {
        const dc = this.dataChannels.get(peerId);
        if (dc && dc.readyState === 'open') {
            const msg: SyncMessage = { type, data: this.arrayBufferToBase64(data) };
            dc.send(JSON.stringify(msg));
        }
    }

    broadcastSyncMessage(type: SyncType, data: Uint8Array) {
        this.dataChannels.forEach((dc, id) => {
            if (dc.readyState === 'open') this.sendToPeer(id, type, data);
        });
    }

    private arrayBufferToBase64(buffer: ArrayBuffer | Uint8Array): string {
        let binary = '';
        const bytes = buffer instanceof Uint8Array ? buffer : new Uint8Array(buffer);
        const len = bytes.byteLength;
        for (let i = 0; i < len; i++) binary += String.fromCharCode(bytes[i]);
        return btoa(binary); // global btoa
    }
}
