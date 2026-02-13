import { Plugin, App, TFile, Notice, TAbstractFile, Platform, normalizePath, debounce } from 'obsidian';
import * as mqtt from 'mqtt';
import { SecurityService } from './security';
import { P2PSettings, DEFAULT_SETTINGS, P2PSyncSettingTab } from './settings';
import { MqttService } from './services/mqtt.service';
import { WebrtcService, SignalMessage, SyncMessage, SyncType } from './services/webrtc.service';
import { YjsService } from './services/yjs.service';
import { LocalServerService } from './services/local-server.service';

export default class P2PSyncPlugin extends Plugin {
    settings: P2PSettings;
    security: SecurityService;
    statusBarItem: HTMLElement;

    mqttService: MqttService;
    webrtcService: WebrtcService;
    yjsService: YjsService;
    localServerService: LocalServerService;

    connectedClients: string[] = [];
    settingsTab: P2PSyncSettingTab;

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

        this.localServerService = new LocalServerService(this.settings);
        this.localServerService.setCallbacks(
            (msg) => this.handleSignalMessage(msg),
            (clients) => {
                this.connectedClients = clients;
                if (this.settingsTab) this.settingsTab.display(); // Refresh UI
            },
            () => { // On Client Connect
                this.sendSignal('HELLO', 'broadcast', {});
            },
            (msg) => this.security.decrypt(msg)
        );

        // UI & Commands
        this.settingsTab = new P2PSyncSettingTab(this.app, this);
        this.addSettingTab(this.settingsTab);

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

        if (!Platform.isMobile && this.settings.enableLocalServer) {
            await this.localServerService.startServer();
        }

        if (this.settings.localServerAddress) {
            this.localServerService.connectToHost();
        }
    }

    disconnect() {
        this.mqttService.disconnect();
        this.webrtcService.destroy();
        this.localServerService.stopServer();
        this.localServerService.disconnectFromHost();
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
            } else if (target === 'announce') {
                const h = await this.security.hashString(this.settings.secretKey);
                topic = `obsidian-p2p/v1/${h}/announce`;
            } else if (!target.includes('/')) {
                const h = await this.security.hashString(this.settings.secretKey);
                topic = `obsidian-p2p/v1/${h}/signal/${target}`;
            }
            this.mqttService.publish(topic, encrypted);
        }

        this.localServerService.broadcast(encrypted);
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

    // Helper needed for Settings Tab now that getLocalIPs is in service
    async getLocalIPs() {
        return this.localServerService.getLocalIPs();
    }
}