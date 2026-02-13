import { Plugin, App, TFile, Notice, TAbstractFile, Platform, normalizePath, debounce } from 'obsidian';
// Dependencies: npm install mqtt yjs ws
import * as mqtt from 'mqtt';
import * as Y from 'yjs';
import { SecurityService } from './security';
import { P2PSettings, DEFAULT_SETTINGS, P2PSyncSettingTab } from './settings';

// Dynamic import for 'ws' to avoid Mobile crashes
let WebSocketServer: any;
if (!Platform.isMobile) {
    import('ws').then(m => { WebSocketServer = m.WebSocketServer; }).catch(() => { });
}

// Protocol Types
type SignalType = 'HELLO' | 'OFFER' | 'ANSWER' | 'CANDIDATE';
interface SignalMessage {
    type: SignalType;
    sender: string;
    target?: string;
    payload: any;
}

type SyncType = 'YJS_UPDATE' | 'YJS_SYNC_STEP_1' | 'YJS_SYNC_STEP_2';
interface SyncMessage {
    type: SyncType;
    data: string; // Base64 encoded Uint8Array
}

export default class P2PSyncPlugin extends Plugin {
    settings: P2PSettings;
    security: SecurityService;
    statusBarItem: HTMLElement; // Promoted to class property

    // Yjs State
    ydoc: Y.Doc;
    yMap: Y.Map<Y.Text>;
    isRemoteUpdate: boolean = false;

    // Networking
    mqttClient: mqtt.MqttClient | null = null;
    localWss: any | null = null;
    localWsClient: WebSocket | null = null;

    peers: Map<string, RTCPeerConnection> = new Map();
    dataChannels: Map<string, RTCDataChannel> = new Map();

    saveSettingsDebounced = debounce(this.saveSettings.bind(this), 1000, true);

    async onload() {
        await this.loadSettings();

        // Initialize Security
        this.security = new SecurityService(this.settings.secretKey);
        await this.security.deriveKey(this.settings.secretKey);

        // Init Yjs
        this.ydoc = new Y.Doc();
        this.yMap = this.ydoc.getMap('obsidian-vault');

        // Broadcast local Yjs updates
        this.ydoc.on('update', (update, origin) => {
            if (origin !== 'local') {
                this.applyToDisk();
                this.broadcastSyncMessage('YJS_UPDATE', update);
            }
        });

        // UI & Commands
        this.addSettingTab(new P2PSyncSettingTab(this.app, this));
        this.statusBarItem = this.addStatusBarItem(); // Assign to property
        this.statusBarItem.setText('P2P: Init');

        this.addCommand({ id: 'p2p-connect', name: 'Connect', callback: () => this.connect() });
        this.addCommand({ id: 'p2p-force-sync', name: 'Force Sync', callback: () => this.syncLocalToYjs() });

        // File Watcher
        this.registerEvent(this.app.vault.on('modify', (file) => this.handleLocalModify(file)));

        // Startup
        this.app.workspace.onLayoutReady(() => {
            this.syncLocalToYjs();
            this.connect();
        });
    }

    async onunload() {
        this.disconnect();
        this.ydoc.destroy();
    }

    /** ------------------------------------------------------------------
     * SYNC LOGIC (Yjs)
     * ------------------------------------------------------------------ */

    async handleLocalModify(file: TAbstractFile) {
        if (this.isRemoteUpdate) return;
        if (!(file instanceof TFile) || file.extension !== 'md') return;

        const content = await this.app.vault.read(file);

        this.ydoc.transact(() => {
            let yText = this.yMap.get(file.path);
            if (!yText) { yText = new Y.Text(); this.yMap.set(file.path, yText); }

            const yContent = yText.toString();
            if (yContent !== content) {
                yText.delete(0, yText.length);
                yText.insert(0, content);
            }
        }, 'local');

        const update = Y.encodeStateAsUpdate(this.ydoc);
        this.broadcastSyncMessage('YJS_UPDATE', update);
    }

    applyToDisk = debounce(async () => {
        this.isRemoteUpdate = true;
        try {
            for (const [path, yText] of this.yMap.entries()) {
                const content = (yText as Y.Text).toString();
                const file = this.app.vault.getAbstractFileByPath(path);
                if (file instanceof TFile) {
                    const current = await this.app.vault.read(file);
                    if (current !== content) await this.app.vault.modify(file, content);
                } else if (!file) {
                    await this.ensureFolder(path);
                    await this.app.vault.create(path, content);
                }
            }
        } catch (e) { console.error("Sync Write Error", e); }
        finally { this.isRemoteUpdate = false; }
    }, 500, true);

    async syncLocalToYjs() {
        const files = this.app.vault.getMarkdownFiles();
        this.ydoc.transact(() => {
            files.forEach(async (file) => {
                const content = await this.app.vault.read(file);
                let yText = this.yMap.get(file.path);
                if (!yText) { yText = new Y.Text(); this.yMap.set(file.path, yText); }
                if (yText.toString() !== content) { yText.delete(0, yText.length); yText.insert(0, content); }
            });
        }, 'local');
    }

    async ensureFolder(path: string) {
        const parts = path.split('/');
        parts.pop();
        let current = '';
        for (const part of parts) {
            current = current ? `${current}/${part}` : part;
            if (!this.app.vault.getAbstractFileByPath(current)) await this.app.vault.createFolder(current);
        }
    }

    /** ------------------------------------------------------------------
     * NETWORKING
     * ------------------------------------------------------------------ */

    async connect() {
        this.disconnect();
        this.statusBarItem.setText('P2P: Connecting...');

        try { await this.setupMQTT(); } catch (e) { console.error('MQTT Init Failed', e); }

        if (!Platform.isMobile && this.settings.enableLocalServer && WebSocketServer) {
            this.setupLocalServer();
        }

        if (this.settings.localServerAddress) {
            this.setupLocalClient();
        }
    }

    disconnect() {
        if (this.mqttClient) { this.mqttClient.end(); this.mqttClient = null; }
        if (this.localWss) { this.localWss.close(); this.localWss = null; }
        if (this.localWsClient) { this.localWsClient.close(); this.localWsClient = null; }
        this.peers.forEach(p => p.close());
        this.peers.clear();
        this.dataChannels.clear();
    }

    // --- Signaling ---

    async setupMQTT() {
        const topicHash = await this.security.hashString(this.settings.secretKey);
        const announceTopic = `obsidian-p2p/v1/${topicHash}/announce`;
        // Use deviceName here to create a unique signal topic
        const signalTopic = `obsidian-p2p/v1/${topicHash}/signal/${this.settings.deviceName}`;

        this.mqttClient = mqtt.connect(this.settings.discoveryServer, {
            reconnectPeriod: 5000,
            connectTimeout: 30 * 1000,
        });

        this.mqttClient.on('connect', () => {
            this.statusBarItem.setText('P2P: Online');
            this.mqttClient?.subscribe(announceTopic);
            this.mqttClient?.subscribe(signalTopic);
            // Include deviceName in the HELLO packet
            this.sendSignal('HELLO', announceTopic, { supported: true });
        });

        this.mqttClient.on('message', async (topic, message) => {
            const rawStr = message.toString();
            try {
                const decrypted = await this.security.decrypt(rawStr);
                if (decrypted) this.handleSignal(decrypted);
            } catch (e) { }
        });
    }

    setupLocalServer() {
        try {
            this.localWss = new WebSocketServer({ port: this.settings.localServerPort });
            new Notice(`Local Server: Port ${this.settings.localServerPort}`);
            this.localWss.on('connection', (ws: any) => {
                ws.on('message', async (data: any) => {
                    this.localWss.clients.forEach((c: any) => {
                        if (c !== ws && c.readyState === 1) c.send(data.toString());
                    });
                    try {
                        const decrypted = await this.security.decrypt(data.toString());
                        if (decrypted) this.handleSignal(decrypted);
                    } catch (e) { }
                });
            });
        } catch (e) { console.error("Local Server Start Failed", e); }
    }

    setupLocalClient() {
        try {
            this.localWsClient = new WebSocket(this.settings.localServerAddress);
            this.localWsClient.onopen = () => {
                new Notice("Connected to Local Relay");
                this.sendSignal('HELLO', 'broadcast', {});
            };
            this.localWsClient.onmessage = async (ev) => {
                try {
                    const decrypted = await this.security.decrypt(ev.data.toString());
                    if (decrypted) this.handleSignal(decrypted);
                } catch (e) { }
            };
        } catch (e) { console.error("Local Client Failed", e); }
    }

    async sendSignal(type: SignalType, target: string, payload: any) {
        const msg: SignalMessage = {
            type,
            sender: this.settings.deviceName,
            target: target === 'broadcast' || target.includes('announce') ? undefined : target,
            payload
        };

        const encrypted = await this.security.encrypt(msg);

        if (this.mqttClient?.connected) {
            let topic = target;
            if (target === 'broadcast') {
                const h = await this.security.hashString(this.settings.secretKey);
                topic = `obsidian-p2p/v1/${h}/announce`;
            } else if (!target.includes('/')) {
                const h = await this.security.hashString(this.settings.secretKey);
                topic = `obsidian-p2p/v1/${h}/signal/${target}`;
            }
            this.mqttClient.publish(topic, encrypted);
        }

        if (this.localWsClient?.readyState === WebSocket.OPEN) {
            this.localWsClient.send(encrypted);
        }

        if (this.localWss) {
            this.localWss.clients.forEach((c: any) => { if (c.readyState === 1) c.send(encrypted); });
        }
    }

    // --- WebRTC ---

    async handleSignal(msg: SignalMessage) {
        if (msg.sender === this.settings.deviceName) return;
        if (msg.target && msg.target !== this.settings.deviceName) return;

        const peerId = msg.sender;

        switch (msg.type) {
            case 'HELLO':
                // Use string comparison of Device Names to decide who initiates
                if (this.settings.deviceName > peerId) this.createPeer(peerId, true);
                break;
            case 'OFFER':
                await this.createPeer(peerId, false);
                const pc = this.peers.get(peerId);
                if (pc) {
                    await pc.setRemoteDescription(new RTCSessionDescription(msg.payload));
                    const answer = await pc.createAnswer();
                    await pc.setLocalDescription(answer);
                    this.sendSignal('ANSWER', peerId, answer);
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
            if (event.candidate) this.sendSignal('CANDIDATE', remoteId, event.candidate);
        };

        pc.onconnectionstatechange = () => {
            if (pc.connectionState === 'connected') {
                new Notice(`Connected to ${remoteId}`);
                const vector = Y.encodeStateVector(this.ydoc);
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
            this.sendSignal('OFFER', remoteId, offer);
        } else {
            pc.ondatachannel = (event) => { this.setupDataChannel(event.channel, remoteId); };
        }
    }

    setupDataChannel(dc: RTCDataChannel, remoteId: string) {
        dc.onopen = () => { this.dataChannels.set(remoteId, dc); };
        dc.onmessage = (event) => { this.handleSyncMessage(JSON.parse(event.data)); };
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

    handleSyncMessage(msg: SyncMessage) {
        const data = this.base64ToArrayBuffer(msg.data);
        const uint8 = new Uint8Array(data);

        this.ydoc.transact(() => {
            switch (msg.type) {
                case 'YJS_SYNC_STEP_1':
                    const update = Y.encodeStateAsUpdate(this.ydoc, uint8);
                    this.broadcastSyncMessage('YJS_SYNC_STEP_2', update);
                    break;
                case 'YJS_SYNC_STEP_2':
                case 'YJS_UPDATE':
                    Y.applyUpdate(this.ydoc, uint8, 'remote');
                    break;
            }
        }, 'remote');
    }

    async loadSettings() {
        this.settings = Object.assign({}, DEFAULT_SETTINGS, await this.loadData());
    }

    async saveSettings() {
        await this.saveData(this.settings);

        // Update encryption key if secret changed
        if (this.security) {
            await this.security.deriveKey(this.settings.secretKey);
        }

        // Reconnect networking to apply new settings (Device Name, Server, Secret)
        // This ensures the new Device Name is broadcasted and subscribed correctly
        this.connect();
    }

    // --- Helpers (Internal) ---
    private arrayBufferToBase64(buffer: ArrayBuffer): string {
        let binary = '';
        const bytes = new Uint8Array(buffer);
        const len = bytes.byteLength;
        for (let i = 0; i < len; i++) binary += String.fromCharCode(bytes[i]);
        return window.btoa(binary);
    }

    private base64ToArrayBuffer(base64: string): ArrayBuffer {
        const binary_string = window.atob(base64);
        const len = binary_string.length;
        const bytes = new Uint8Array(len);
        for (let i = 0; i < len; i++) bytes[i] = binary_string.charCodeAt(i);
        return bytes.buffer;
    }
}