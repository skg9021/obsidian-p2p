import { Plugin, App, TFile, Notice, TAbstractFile, Platform, debounce } from 'obsidian';
import { SecurityService } from './security';
import { P2PSettings, DEFAULT_SETTINGS, P2PSyncSettingTab } from './settings';
import { YjsService } from './services/yjs.service';
import { PeerInfo } from './services/p2p-types';
import { MqttStrategy } from './services/strategies/mqtt-strategy';
import { LocalStrategy } from './services/strategies/local-strategy';
import { LocalServerService } from './services/local-server.service';
import { logger, updateLoggerSettings } from './services/logger.service';
import { FileTransferService } from './services/file-transfer.service';
import { buildCursorExtension } from './cursor-extension';

export default class P2PSyncPlugin extends Plugin {
    settings: P2PSettings;
    security: SecurityService;
    statusBarItem: HTMLElement;

    yjsService: YjsService;
    localServerService: LocalServerService;
    fileTransferService: FileTransferService;

    connectedClients: PeerInfo[] = [];
    settingsTab: P2PSyncSettingTab;

    clientReconnectTimeout: any = null;
    clientReconnectAttempts: number = 0;
    maxReconnectDelay: number = 30000;

    saveSettingsDebounced = debounce(this.saveSettings.bind(this), 1000, true);

    async onload() {
        // --- TEMPORARY WEBRTC DEBUGGING ---
        const OrigPeerConnection = window.RTCPeerConnection;
        window.RTCPeerConnection = function (...args: any[]) {
            // @ts-ignore
            const pc = new OrigPeerConnection(...args);
            const id = Math.random().toString(36).substring(2, 6);

            logger.info(`[WebRTC-${id}] Created PC with config:`, args[0]);

            pc.addEventListener('icecandidate', (e: any) => {
                if (e.candidate) {
                    logger.info(`[WebRTC-${id}] Gathered LOCAL ICE Candidate:`, e.candidate.candidate);
                } else {
                    logger.info(`[WebRTC-${id}] Finished gathering ICE candidates.`);
                }
            });

            pc.addEventListener('iceconnectionstatechange', () => {
                logger.info(`[WebRTC-${id}] ICE Connection State:`, pc.iceConnectionState);
            });

            pc.addEventListener('connectionstatechange', () => {
                logger.info(`[WebRTC-${id}] Connection State:`, pc.connectionState);
            });

            const origAddIceCandidate = pc.addIceCandidate.bind(pc);
            pc.addIceCandidate = async (candidate: any) => {
                logger.info(`[WebRTC-${id}] Adding REMOTE ICE Candidate:`, candidate?.candidate || candidate);
                return origAddIceCandidate(candidate);
            };

            const origSetRemoteDescription = pc.setRemoteDescription.bind(pc);
            pc.setRemoteDescription = async (desc: any) => {
                logger.info(`[WebRTC-${id}] Set Remote Description (${desc?.type})`);
                return origSetRemoteDescription(desc);
            };

            return pc;
        } as any;
        // ----------------------------------

        await this.loadSettings();

        // Initialize Logger
        updateLoggerSettings(this.settings);
        logger.info('Plugin loading...');

        // Initialize Security
        this.security = new SecurityService(this.settings.secretKey);
        await this.security.deriveKey(this.settings.secretKey);
        logger.info('Security service initialized');

        // Initialize Yjs Service (manages Y.Doc + both P2P providers + awareness)
        this.yjsService = new YjsService(this.app, this.settings);
        this.yjsService.onPeersUpdated = (peers) => {
            // START TRACING
            const trace = new Error('Peer Update Tracer');
            logger.trace('[P2P Sync] onPeersUpdated stack:', trace.stack);
            // END TRACING
            logger.info(`Awareness peers: [${peers.map(p => `${p.name}(${p.source})`).join(', ')}]`);

            // Notify when new peers join
            const oldNames = new Set(this.connectedClients.map(p => p.name));
            for (const peer of peers) {
                if (!oldNames.has(peer.name)) {
                    new Notice(`🟢 ${peer.name} joined the room`);
                }
            }

            // Notify when peers leave
            const newNames = new Set(peers.map(p => p.name));
            for (const oldPeer of this.connectedClients) {
                if (!newNames.has(oldPeer.name)) {
                    new Notice(`🔴 ${oldPeer.name} left the room`);
                }
            }

            this.connectedClients = peers;
            if (this.settingsTab) this.settingsTab.updatePeerList();
        };

        // Register Strategies
        const mqttStrategy = new MqttStrategy();
        mqttStrategy.initialize(this.yjsService.ydoc, this.yjsService.awareness);
        this.yjsService.providerManager.registerStrategy(mqttStrategy);

        const localStrategy = new LocalStrategy();
        localStrategy.initialize(this.yjsService.ydoc, this.yjsService.awareness);
        this.yjsService.providerManager.registerStrategy(localStrategy);

        // Set our local IPs in awareness
        this.localServerService = new LocalServerService(this.settings);
        this.localServerService.getLocalIPs().then(ips => {
            this.yjsService.setLocalIPs(ips);
        });
        logger.info('Yjs service initialized');

        this.localServerService.setCallbacks(
            (clients) => {
                logger.info(`Signaling server connections: [${clients.join(', ')}]`);
            },
        );
        logger.info('Local signaling server service initialized');

        // Initialize File Transfer Service
        this.fileTransferService = new FileTransferService(this.app, this.yjsService, this.settings);
        logger.info('File Transfer service initialized');

        // UI & Commands
        this.settingsTab = new P2PSyncSettingTab(this.app, this);
        this.addSettingTab(this.settingsTab);

        this.registerEditorExtension(buildCursorExtension(this));

        this.statusBarItem = this.addStatusBarItem();
        this.statusBarItem.setText('🔴 P2P: Offline');

        // Bind ProviderManager's aggregated status to the UI
        this.yjsService.providerManager.onAggregatedStatusChanged = (status) => {
            let label = '🔴 P2P: Offline';
            if (status === 'connected') label = '🟢 P2P: Online';
            else if (status === 'connecting') label = '🟡 P2P: Connecting...';
            else if (status === 'error') label = '🔴 P2P: Error';

            this.statusBarItem.setText(label);
        };

        this.addCommand({ id: 'p2p-connect', name: 'Connect', callback: () => this.connect() });
        this.addCommand({ id: 'p2p-force-sync', name: 'Force Sync', callback: () => this.syncLocalToYjs() });
        this.addCommand({
            id: 'p2p-debug',
            name: 'Debug State',
            callback: () => {
                this.fileTransferService.debugState();
                logger.info('--- Yjs State ---');
                // @ts-ignore
                logger.info('Yjs ClientID:', this.yjsService.ydoc.clientID);
                // @ts-ignore
                logger.info('Provider Strategies:', this.yjsService.providerManager.strategies);
                logger.info('Aggregated Peers:', this.yjsService.providerManager.getPeers());
                logger.info('Connected Clients:', this.connectedClients);
            }
        });

        // File Watcher
        this.registerEvent(this.app.vault.on('modify', (file) => this.handleLocalModify(file)));
        this.registerEvent(this.app.vault.on('create', (file) => this.handleLocalModify(file)));
        this.registerEvent(this.app.vault.on('rename', (file, oldPath) => this.handleLocalRename(file, oldPath)));
        this.registerEvent(this.app.vault.on('delete', (file) => this.handleLocalDelete(file)));

        // Startup
        this.app.workspace.onLayoutReady(() => {
            logger.info('Layout ready, starting sync and connection');
            this.fileTransferService.initialize();
            this.syncLocalToYjs();
            // this.connect();
        });

        logger.info('Plugin loaded successfully');
    }

    async onunload() {
        logger.info('Plugin unloading...');
        this.disconnect();
        this.yjsService.destroy();
        logger.info('Plugin unloaded');
    }

    async handleLocalModify(file: TAbstractFile) {
        if (!(file instanceof TFile)) return;
        logger.info(`Local file modified: ${file.path}`);

        if (file.extension === 'md') {
            this.yjsService.handleLocalModify(file);
        } else {
            // It's a binary file (image, pdf, etc.)
            this.fileTransferService.handleLocalFile(file);
        }
    }

    async syncLocalToYjs() {
        logger.info('Syncing local vault to Yjs');
        this.yjsService.syncLocalToYjs();
    }

    // --- Networking ---

    async connect() {
        // TODO: Explore why MQTT is not here considering this is common connect

        logger.info('--- connect() called ---');
        this.disconnect();

        const roomName = await this.getRoomName();

        // ─── Start Local Server if needed ───
        if (!Platform.isMobile && this.settings.enableLocalServer) {
            logger.info(`Starting local signaling server on port ${this.settings.localServerPort}...`);
            try {
                await this.localServerService.startServer();
                logger.info(`Signaling server started`);
            } catch (e) {
                logger.error('Failed to start signaling server', e);
            }
        } else if (this.settings.enableLocalClient && this.settings.localServerAddress) { // ─── Client Reconnect Logic ───
            this.checkConnection(this.settings.localServerAddress).then((canConnect) => {
                if (!canConnect) {
                    logger.info(`Connection check to ${this.settings.localServerAddress} failed. Scheduling reconnect...`);
                    this.scheduleReconnect(roomName);
                } else {
                    this.clientReconnectAttempts = 0;
                }
            });
        }

        await this.yjsService.providerManager.connectAll(roomName, this.settings);
        this.fileTransferService.setupProviderActions();
        this.yjsService.refreshPeerList();
        logger.info('--- connect() complete ---');
    }

    scheduleReconnect(roomName: string) {
        if (this.clientReconnectTimeout) clearTimeout(this.clientReconnectTimeout);

        const delay = Math.min(1000 * Math.pow(2, this.clientReconnectAttempts), this.maxReconnectDelay);
        logger.info(`Attempting reconnect in ${delay}ms (Attempt ${this.clientReconnectAttempts + 1})`);

        // Let ProviderManager handle the "Disconnected" UI state while we wait, 
        // or we could show a distinct UI for retrying. For now, just logging is fine.

        this.clientReconnectTimeout = setTimeout(() => {
            this.clientReconnectAttempts++;
            this.connect(); // Re-trigger connect which checks connection again
        }, delay);
    }

    async checkConnection(url: string): Promise<boolean> {
        return new Promise((resolve) => {
            try {
                const socket = new WebSocket(url);
                socket.onopen = () => { socket.close(); resolve(true); };
                socket.onerror = () => { resolve(false); };
            } catch (e) {
                resolve(false);
            }
        });
    }

    disconnect() {
        if (this.clientReconnectTimeout) {
            clearTimeout(this.clientReconnectTimeout);
            this.clientReconnectTimeout = null;
        }
        logger.info('--- disconnect() called ---');
        this.yjsService.providerManager.disconnectAll();
        this.localServerService.stopServer();
        logger.info('All services disconnected');
    }

    async loadSettings() {
        this.settings = Object.assign({}, DEFAULT_SETTINGS, await this.loadData());
    }

    async saveSettings() {
        await this.saveData(this.settings);
        if (this.security) {
            await this.security.deriveKey(this.settings.secretKey);
        }
    }

    async handleLocalRename(file: TAbstractFile, oldPath: string) {
        if (!(file instanceof TFile)) return;
        // logger.info(`Local file renamed: ${oldPath} -> ${file.path}`);
        if (file.extension !== 'md') {
            this.fileTransferService.handleLocalRename(file, oldPath);
        }
    }

    async handleLocalDelete(file: TAbstractFile) {
        if (!(file instanceof TFile)) return;
        // Always set tombstone for all file types (propagates deletion to peers)
        this.yjsService.handleLocalDelete(file);
        // Additionally handle binary file cleanup
        if (file.extension !== 'md') {
            this.fileTransferService.handleLocalDelete(file);
        }
    }

    async getRoomName(): Promise<string> {
        const roomHash = await this.security.hashString(this.settings.secretKey);
        return `obsidian-p2p-${roomHash.substring(0, 16)}`;
    }

    async reloadMqttStrategy() {
        logger.info('--- reloadMqttStrategy() called ---');
        const roomName = await this.getRoomName();
        await this.yjsService.providerManager.connectStrategy('mqtt', roomName, this.settings);
        this.fileTransferService.setupProviderActions();
        this.yjsService.refreshPeerList();
    }

    async reloadLocalStrategy() {
        logger.info('--- reloadLocalStrategy() called ---');

        // Stop server if it's running
        this.localServerService.stopServer();
        this.yjsService.providerManager.disconnectStrategy('local');

        const roomName = await this.getRoomName();

        // Restart Server if enabled
        if (!Platform.isMobile && this.settings.enableLocalServer) {
            logger.info(`Starting local signaling server on port ${this.settings.localServerPort}...`);
            try {
                await this.localServerService.startServer();
                logger.info(`Signaling server started`);
            } catch (e) {
                logger.error('Failed to start signaling server', e);
            }
        } else if (this.settings.enableLocalClient && this.settings.localServerAddress) { // Client Reconnect Checks (UI feedback)
            this.checkConnection(this.settings.localServerAddress).then((canConnect) => {
                if (!canConnect) {
                    logger.info(`Connection check to ${this.settings.localServerAddress} failed. Scheduling reconnect...`);
                    this.scheduleReconnect(roomName);
                } else {
                    this.clientReconnectAttempts = 0;
                }
            });
        }

        // Restart Strategy (Client/Host logic is internal to strategy)
        await this.yjsService.providerManager.connectStrategy('local', roomName, this.settings);

        this.fileTransferService.setupProviderActions();
        this.yjsService.refreshPeerList();
    }

    async getLocalIPs() {
        return this.localServerService.getLocalIPs();
    }
}