import { Plugin, App, TFile, Notice, TAbstractFile, Platform, debounce } from 'obsidian';
import { SecurityService } from './security';
import { P2PSettings, DEFAULT_SETTINGS, P2PSyncSettingTab } from './settings';
import { YjsService } from './services/yjs.service';
import { LocalServerService } from './services/local-server.service';
import { Logger } from './services/logger.service';

export default class P2PSyncPlugin extends Plugin {
    settings: P2PSettings;
    security: SecurityService;
    statusBarItem: HTMLElement;
    logger: Logger;

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

        // Initialize Yjs Service (manages Y.Doc + both P2P providers + awareness)
        this.yjsService = new YjsService(this.app, this.settings);
        this.yjsService.onPeersUpdated = (peers) => {
            const peerLabels = peers.map(p => p.ip ? `${p.name} - ${p.ip}` : p.name);
            this.logger.log(`Awareness peers: [${peerLabels.join(', ')}]`);
            this.connectedClients = peerLabels;
            if (this.settingsTab) this.settingsTab.display();
        };
        // Set our local IPs in awareness
        this.localServerService = new LocalServerService(this.settings);
        this.localServerService.getLocalIPs().then(ips => {
            this.yjsService.setLocalIPs(ips);
        });
        this.logger.log('Yjs service initialized');

        this.localServerService.setCallbacks(
            (clients) => {
                this.logger.log(`Signaling server connections: [${clients.join(', ')}]`);
            },
        );
        this.logger.log('Local signaling server service initialized');

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

        // Derive a room name from the secret key
        const roomHash = await this.security.hashString(this.settings.secretKey);
        const roomName = `obsidian-p2p-${roomHash.substring(0, 16)}`;

        // ─── Internet P2P (Trystero + MQTT signaling) ───────────
        if (this.settings.enableMqttDiscovery) {
            this.logger.log('Starting Trystero provider (MQTT signaling)...');
            try {
                this.yjsService.startTrysteroProvider(roomName, this.settings.secretKey);
                this.statusBarItem.setText('P2P: Online');
                this.logger.log(`Trystero provider started for room: ${roomName}`);
            } catch (e) {
                this.logger.error('Trystero Init Failed', e);
            }
        } else {
            this.logger.log('MQTT Discovery disabled');
        }

        // ─── Local LAN: Start signaling server (Host Mode) ─────
        if (!Platform.isMobile && this.settings.enableLocalServer) {
            this.logger.log(`Starting local signaling server on port ${this.settings.localServerPort}...`);
            await this.localServerService.startServer();

            // Also connect as a local peer via our own signaling server
            const localSignalingUrl = `ws://localhost:${this.settings.localServerPort}`;
            this.yjsService.startLocalWebrtcProvider(localSignalingUrl, roomName, this.settings.secretKey);
            this.logger.log('Host: signaling server + local WebRTC provider started');
        }

        // ─── Local LAN: Connect to remote host's signaling server ─
        if (this.settings.localServerAddress && !this.settings.enableLocalServer) {
            this.logger.log(`Connecting to remote signaling server at ${this.settings.localServerAddress}...`);
            this.yjsService.startLocalWebrtcProvider(
                this.settings.localServerAddress,
                roomName,
                this.settings.secretKey
            );
            this.logger.log('Client: local WebRTC provider started');
        }

        this.statusBarItem.setText('P2P: Connected');
        this.logger.log('--- connect() complete ---');
    }

    disconnect() {
        this.logger.log('--- disconnect() called ---');
        this.yjsService.stopTrysteroProvider();
        this.yjsService.stopLocalWebrtcProvider();
        this.localServerService.stopServer();
        this.logger.log('All services disconnected');
    }

    async restartLocalServer() {
        this.logger.log('--- restartLocalServer() called ---');
        this.localServerService.stopServer();
        this.yjsService.stopLocalWebrtcProvider();
        if (!Platform.isMobile && this.settings.enableLocalServer) {
            this.logger.log(`Restarting signaling server on port ${this.settings.localServerPort}...`);
            await this.localServerService.startServer();

            const roomHash = await this.security.hashString(this.settings.secretKey);
            const roomName = `obsidian-p2p-${roomHash.substring(0, 16)}`;
            const localSignalingUrl = `ws://localhost:${this.settings.localServerPort}`;
            this.yjsService.startLocalWebrtcProvider(localSignalingUrl, roomName, this.settings.secretKey);
            this.logger.log('Signaling server and local provider restarted');
        }
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

    async getLocalIPs() {
        return this.localServerService.getLocalIPs();
    }
}