import { Plugin, App, TFile, Notice, TAbstractFile, Platform, normalizePath, debounce } from 'obsidian';
import * as mqtt from 'mqtt';
import { SecurityService } from './security';
import { P2PSettings, DEFAULT_SETTINGS, P2PSyncSettingTab } from './settings';
import { MqttService } from './services/mqtt.service';
import { WebrtcService, SignalMessage, SyncMessage, SyncType } from './services/webrtc.service';
import { YjsService } from './services/yjs.service';
import { LocalServerService } from './services/local-server.service';
import { Logger } from './services/logger.service';

export default class P2PSyncPlugin extends Plugin {
    settings: P2PSettings;
    security: SecurityService;
    statusBarItem: HTMLElement;
    logger: Logger;

    mqttService: MqttService;
    webrtcService: WebrtcService;
    yjsService: YjsService;
    localServerService: LocalServerService;

    connectedClients: string[] = [];
    settingsTab: P2PSyncSettingTab;

    saveSettingsDebounced = debounce(this.saveSettings.bind(this), 1000, true);

    async onload() {
        await this.loadSettings();

        // Initialize Logger
        this.logger = new Logger(this.settings);
        this.logger.log('Plugin loading...');

        // Initialize Security
        this.security = new SecurityService(this.settings.secretKey);
        await this.security.deriveKey(this.settings.secretKey);
        this.logger.log('Security service initialized');

        // Initialize Services
        this.yjsService = new YjsService(this.app);
        this.yjsService.setUpdateCallback((update: Uint8Array) => {
            this.logger.log('Yjs update detected, broadcasting to peers');
            this.webrtcService.broadcastSyncMessage('YJS_UPDATE', update);
        });
        this.logger.log('Yjs service initialized');

        this.mqttService = new MqttService(this.settings, () => this.security.hashString(this.settings.secretKey));
        this.mqttService.setCallbacks(
            (msg) => {
                this.logger.log('MQTT message received');
                this.handleSignalMessage(msg);
            },
            () => {
                this.logger.log('MQTT connected, sending HELLO');
                this.statusBarItem.setText('P2P: Online');
                this.sendSignal('HELLO', 'announce', { supported: true });
            }
        );
        this.logger.log('MQTT service initialized');

        this.webrtcService = new WebrtcService(this.settings);
        this.webrtcService.setCallbacks(
            (msg) => {
                this.logger.log(`Sync message received: ${msg.type}`);
                this.handleSyncMessage(msg);
            },
            (type, target, payload) => {
                this.logger.log(`WebRTC signal: ${type} -> ${target}`);
                return this.sendSignal(type, target, payload);
            },
            () => this.yjsService.stateVector
        );
        this.logger.log('WebRTC service initialized');

        this.localServerService = new LocalServerService(this.settings);
        this.localServerService.setCallbacks(
            (msg) => {
                this.logger.log('Local server/client message received');
                this.handleSignalMessage(msg);
            },
            (clients) => {
                this.logger.log(`Connected clients updated: [${clients.join(', ')}]`);
                this.connectedClients = clients;
                if (this.settingsTab) this.settingsTab.display();
            },
            () => {
                this.logger.log('Client connected to host, sending HELLO');
                this.sendSignal('HELLO', 'broadcast', {});
            },
            (msg) => this.security.decrypt(msg)
        );
        this.logger.log('Local server service initialized');

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
            this.logger.log('Layout ready, starting sync and connection');
            this.syncLocalToYjs();
            this.connect();
        });

        this.logger.log('Plugin loaded successfully');
    }

    async onunload() {
        this.logger.log('Plugin unloading...');
        this.disconnect();
        this.yjsService.destroy();
        this.webrtcService.destroy();
        this.logger.log('Plugin unloaded');
    }

    async handleLocalModify(file: TAbstractFile) {
        this.logger.log(`Local file modified: ${file instanceof TFile ? file.path : 'non-file'}`);
        this.yjsService.handleLocalModify(file);
    }

    async syncLocalToYjs() {
        this.logger.log('Syncing local vault to Yjs');
        this.yjsService.syncLocalToYjs();
    }

    // --- Networking ---

    async connect() {
        this.logger.log('--- connect() called ---');
        this.disconnect();
        this.statusBarItem.setText('P2P: Connecting...');

        if (this.settings.enableMqttDiscovery) {
            this.logger.log('Attempting MQTT connection...');
            try {
                await this.mqttService.connect();
                this.logger.log('MQTT connection initiated');
            } catch (e) {
                this.logger.error('MQTT Init Failed', e);
            }
        } else {
            this.logger.log('MQTT Discovery disabled in settings');
        }

        if (!Platform.isMobile && this.settings.enableLocalServer) {
            this.logger.log(`Starting local server on port ${this.settings.localServerPort}...`);
            await this.localServerService.startServer();
            this.logger.log('Local server started');
        } else {
            this.logger.log(`Local server skipped (isMobile=${Platform.isMobile}, enabled=${this.settings.enableLocalServer})`);
        }

        if (this.settings.localServerAddress) {
            this.logger.log(`Connecting to host at ${this.settings.localServerAddress}...`);
            this.localServerService.connectToHost();
        } else {
            this.logger.log('No host address configured, skipping client connection');
        }
        this.logger.log('--- connect() complete ---');
    }

    disconnect() {
        this.logger.log('--- disconnect() called ---');
        this.mqttService.disconnect();
        this.webrtcService.destroy();
        this.localServerService.stopServer();
        this.localServerService.disconnectFromHost();
        this.logger.log('All services disconnected');
    }

    async restartLocalServer() {
        this.logger.log('--- restartLocalServer() called ---');
        this.localServerService.stopServer();
        this.logger.log('Local server stopped');
        if (!Platform.isMobile && this.settings.enableLocalServer) {
            this.logger.log(`Restarting local server on port ${this.settings.localServerPort}...`);
            await this.localServerService.startServer();
            this.logger.log('Local server restarted');
        }
    }

    // --- Signaling ---

    async handleSignalMessage(rawMsg: string) {
        try {
            const decrypted = await this.security.decrypt(rawMsg);
            if (decrypted) {
                this.logger.log(`Signal received: type=${decrypted.type}, sender=${decrypted.sender}`);
                this.webrtcService.handleSignal(decrypted);
            }
        } catch (e) {
            this.logger.log('Failed to decrypt signal message (may be from self)');
        }
    }

    async sendSignal(type: any, target: string, payload: any) {
        this.logger.log(`Sending signal: type=${type}, target=${target}`);
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
            this.logger.log(`Publishing to MQTT topic: ${topic}`);
            this.mqttService.publish(topic, encrypted);
        } else {
            this.logger.log('MQTT not connected, skipping MQTT publish');
        }

        this.localServerService.broadcast(encrypted);
        this.logger.log('Signal broadcast to local server/client');
    }

    // --- Sync Handling ---

    handleSyncMessage(msg: SyncMessage) {
        this.logger.log(`Processing sync message: ${msg.type}`);
        const data = this.base64ToArrayBuffer(msg.data);
        const uint8 = new Uint8Array(data);

        this.yjsService.ydoc.transact(() => {
            switch (msg.type) {
                case 'YJS_SYNC_STEP_1':
                    this.logger.log('Responding to YJS_SYNC_STEP_1 with state update');
                    const update = this.yjsService.encodeStateAsUpdate(uint8);
                    this.webrtcService.broadcastSyncMessage('YJS_SYNC_STEP_2', update);
                    break;
                case 'YJS_SYNC_STEP_2':
                case 'YJS_UPDATE':
                    this.logger.log(`Applying remote Yjs update (${msg.type})`);
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

    async getLocalIPs() {
        return this.localServerService.getLocalIPs();
    }
}