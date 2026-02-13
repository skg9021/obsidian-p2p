import { Plugin, App, TFile, Notice, TAbstractFile, Platform, normalizePath, debounce } from 'obsidian';
import * as mqtt from 'mqtt';
import { SecurityService } from './security';
import { P2PSettings, DEFAULT_SETTINGS, P2PSyncSettingTab } from './settings';
import { MqttService } from './services/mqtt.service';
import { WebrtcService, SignalMessage, SyncMessage, SyncType } from './services/webrtc.service';
import { YjsService } from './services/yjs.service';

// Dynamic import for 'ws' to avoid Mobile crashes
let WebSocketServer: any;
if (!Platform.isMobile) {
    import('ws').then(m => { WebSocketServer = m.WebSocketServer; }).catch(() => { });
}

export default class P2PSyncPlugin extends Plugin {
    settings: P2PSettings;
    security: SecurityService;
    statusBarItem: HTMLElement;

    mqttService: MqttService;
    webrtcService: WebrtcService;
    yjsService: YjsService;

    localWss: any | null = null;
    localWsClient: WebSocket | null = null;

    saveSettingsDebounced = debounce(this.saveSettings.bind(this), 1000, true);

    async onload() {
        await this.loadSettings();

        // Initialize Security
        this.security = new SecurityService(this.settings.secretKey);
        await this.security.deriveKey(this.settings.secretKey);

        // Initialize Services
        this.yjsService = new YjsService(this.app);
        this.yjsService.setUpdateCallback((update: Uint8Array) => {
            this.webrtcService.broadcastSyncMessage('YJS_UPDATE', update);
        });

        this.mqttService = new MqttService(this.settings, () => this.security.hashString(this.settings.secretKey));
        this.mqttService.setCallbacks(
            (msg) => this.handleSignalMessage(msg),
            () => {
                this.statusBarItem.setText('P2P: Online');
                this.sendSignal('HELLO', 'announce', { supported: true });
            }
        );

        this.webrtcService = new WebrtcService(this.settings);
        this.webrtcService.setCallbacks(
            (msg) => this.handleSyncMessage(msg),
            (type, target, payload) => this.sendSignal(type, target, payload),
            () => this.yjsService.stateVector
        );

        // UI & Commands
        this.addSettingTab(new P2PSyncSettingTab(this.app, this));
        this.statusBarItem = this.addStatusBarItem();
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
        this.yjsService.destroy();
        this.webrtcService.destroy();
    }

    async handleLocalModify(file: TAbstractFile) {
        this.yjsService.handleLocalModify(file);
    }

    async syncLocalToYjs() {
        this.yjsService.syncLocalToYjs();
    }

    // --- Networking ---

    async connect() {
        this.disconnect();
        this.statusBarItem.setText('P2P: Connecting...');

        try { await this.mqttService.connect(); } catch (e) { console.error('MQTT Init Failed', e); }

        if (!Platform.isMobile && this.settings.enableLocalServer && WebSocketServer) {
            await this.setupLocalServer();
        }

        if (this.settings.localServerAddress) {
            this.setupLocalClient();
        }
    }

    disconnect() {
        this.mqttService.disconnect();
        this.webrtcService.destroy();
        if (this.localWss) { this.localWss.close(); this.localWss = null; }
        if (this.localWsClient) { this.localWsClient.close(); this.localWsClient = null; }
    }

    // --- Signaling ---

    async handleSignalMessage(rawMsg: string) {
        try {
            const decrypted = await this.security.decrypt(rawMsg);
            if (decrypted) this.webrtcService.handleSignal(decrypted);
        } catch (e) { }
    }

    async sendSignal(type: any, target: string, payload: any) {
        const msg: SignalMessage = {
            type,
            sender: this.settings.deviceName,
            target: target === 'broadcast' || target.includes('announce') ? undefined : target,
            payload
        };

        const encrypted = await this.security.encrypt(msg);

        if (this.mqttService.connected) {
            let topic = target;
            if (target === 'broadcast') {
                const h = await this.security.hashString(this.settings.secretKey);
                topic = `obsidian-p2p/v1/${h}/announce`;
            } else if (target === 'announce') { // Handle 'announce' specifically if needed, logic above handles broadcast
                const h = await this.security.hashString(this.settings.secretKey);
                topic = `obsidian-p2p/v1/${h}/announce`;
            } else if (!target.includes('/')) {
                const h = await this.security.hashString(this.settings.secretKey);
                topic = `obsidian-p2p/v1/${h}/signal/${target}`;
            }
            this.mqttService.publish(topic, encrypted);
        }

        if (this.localWsClient?.readyState === WebSocket.OPEN) {
            this.localWsClient.send(encrypted);
        }

        if (this.localWss) {
            this.localWss.clients.forEach((c: any) => { if (c.readyState === 1) c.send(encrypted); });
        }
    }

    // --- Local Server ---

    async getLocalIPs() {
        try {
            const os = await import('os');
            const nets = os.networkInterfaces();
            const results: string[] = [];
            for (const name of Object.keys(nets)) {
                for (const net of nets[name] || []) {
                    if (net.family === 'IPv4' && !net.internal) {
                        results.push(net.address);
                    }
                }
            }
            return results;
        } catch (e) {
            console.error("Failed to get local IPs", e);
            return [];
        }
    }

    async setupLocalServer() {
        try {
            const ips = await this.getLocalIPs();
            const ipDisplay = ips.length > 0 ? ips.join(', ') : 'localhost';

            this.localWss = new WebSocketServer({ port: this.settings.localServerPort });
            new Notice(`Host Mode: ws://${ipDisplay}:${this.settings.localServerPort}`);
            console.log(`P2P Host Mode Active on: ${ips.map(ip => `ws://${ip}:${this.settings.localServerPort}`).join(', ')}`);

            this.localWss.on('connection', (ws: any) => {
                ws.on('message', async (data: any) => {
                    this.localWss.clients.forEach((c: any) => {
                        if (c !== ws && c.readyState === 1) c.send(data.toString());
                    });
                    this.handleSignalMessage(data.toString());
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
                this.handleSignalMessage(ev.data.toString());
            };
        } catch (e) { console.error("Local Client Failed", e); }
    }

    // --- Sync Handling ---

    handleSyncMessage(msg: SyncMessage) {
        const data = this.base64ToArrayBuffer(msg.data);
        const uint8 = new Uint8Array(data);

        this.yjsService.ydoc.transact(() => {
            switch (msg.type) {
                case 'YJS_SYNC_STEP_1':
                    const update = this.yjsService.encodeStateAsUpdate(uint8);
                    this.webrtcService.broadcastSyncMessage('YJS_SYNC_STEP_2', update);
                    break;
                case 'YJS_SYNC_STEP_2':
                case 'YJS_UPDATE':
                    this.yjsService.applyUpdate(uint8);
                    break;
            }
        }, 'remote');
    }

    async loadSettings() {
        this.settings = Object.assign({}, DEFAULT_SETTINGS, await this.loadData());
    }

    async saveSettings() {
        await this.saveData(this.settings);
        if (this.security) {
            await this.security.deriveKey(this.settings.secretKey);
        }
        this.connect();
    }

    private base64ToArrayBuffer(base64: string): ArrayBuffer {
        const binary_string = atob(base64);
        const len = binary_string.length;
        const bytes = new Uint8Array(len);
        for (let i = 0; i < len; i++) bytes[i] = binary_string.charCodeAt(i);
        return bytes.buffer;
    }
}