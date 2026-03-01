import { Platform } from 'obsidian';
import { LANDiscoveryService, DiscoveryPeerInfo } from './lan-discovery.service';
import { logger } from './logger.service';
import P2PSyncPlugin from '../main';

/**
 * Handles the leader election for the local network strategy to determine
 * which device should act as the signaling server (Local Host).
 */
export class LocalNetworkHostElectionService {
    public lanDiscoveryService: LANDiscoveryService;
    public isLocalHost: boolean = false;
    private leaderElectionTimeout: number | null = null;

    constructor(private plugin: P2PSyncPlugin) {
        this.lanDiscoveryService = new LANDiscoveryService();
        this.lanDiscoveryService.on('discover', (peerInfo: DiscoveryPeerInfo) => {
            this.handleDiscoveredHost(peerInfo);
        });
        this.lanDiscoveryService.on('lose', (peerInfo: DiscoveryPeerInfo) => {
            this.handleLostHost(peerInfo);
        });
    }

    public stop() {
        this.cancelLeaderElection();
        this.lanDiscoveryService.stop();
        this.isLocalHost = false;
    }

    private cancelLeaderElection() {
        if (this.leaderElectionTimeout) {
            window.clearTimeout(this.leaderElectionTimeout);
            this.leaderElectionTimeout = null;
        }
    }

    public async startElection() {
        const roomName = await this.plugin.getRoomName();
        this.cancelLeaderElection();
        this.isLocalHost = false;

        // Stop current discovery
        this.lanDiscoveryService.stop();

        if (Platform.isMobile) {
            // Mobile: Always client, just listen for beacons
            logger.info('Mobile device: Listening for Local Network Host beacons...');
            this.lanDiscoveryService.startListening();

            // Connect to fallback if available (e.g. static IP or last known)
            if (this.plugin.settings.discoveredLocalAddress) {
                this.connectLocalClient(this.plugin.settings.discoveredLocalAddress, roomName);
            }
        } else {
            // Desktop: Smart Auto-Host (Leader Election)
            logger.info('Desktop device: Initiating LAN Discovery Leader Election...');
            this.lanDiscoveryService.startListening();

            // Wait 3 seconds to see if a host already exists
            this.leaderElectionTimeout = window.setTimeout(() => {
                this.leaderElectionTimeout = null;
                const peers = this.lanDiscoveryService.getDiscoveredPeers();

                if (peers.length > 0) {
                    // Host found, behave as Client
                    const host = peers[0]; // Take the first one for simplicity, or we could pick lowest deviceId
                    logger.info(`Found existing host ${host.name} (${host.deviceId}). Acting as Client.`);
                    this.connectToDiscoveredHost(host, roomName);
                } else {
                    // No host found, promote to Host
                    this.promoteToHost(roomName);
                }
            }, 3000);
        }
    }

    public async promoteToHost(roomName: string) {
        logger.info('Promoting self to Local Network Host...');
        this.isLocalHost = true;

        try {
            this.plugin.settings.localSyncPort = this.plugin.settings.localSyncPort || 8080;
            const targetPort = this.plugin.settings.localSyncPort;

            const ips = await this.plugin.localServerService.getLocalIPs();
            const ipDisplay = ips.length > 0 ? ips[0] : 'localhost';
            this.plugin.settings.discoveredLocalAddress = `ws://${ipDisplay}:${targetPort}`;

            await this.plugin.localServerService.startServer();
            logger.info(`Local signaling server started on port ${targetPort}`);

            // Start broadcasting our presence
            this.lanDiscoveryService.startBroadcasting({
                deviceId: this.plugin.yjsService.ydoc.clientID.toString(), // or an actual UUID if maintained
                name: this.plugin.settings.deviceName,
                ip: null, // Let the service fill this or receiver determine it
                port: targetPort
            });

            // Connect our own strategy to the local server
            await this.plugin.yjsService.providerManager.connectStrategy('local', roomName, this.plugin.settings);

        } catch (e) {
            logger.error('Failed to promote to Host', e);
            this.isLocalHost = false;
        }
    }

    private async connectToDiscoveredHost(host: DiscoveryPeerInfo, roomName: string) {
        if (!host.ip) return;

        const url = `ws://${host.ip}:${host.port}`;
        logger.info(`Connecting to discovered host at ${url}`);
        this.plugin.settings.discoveredLocalAddress = url;
        this.connectLocalClient(url, roomName);
    }

    private async checkConnection(url: string): Promise<boolean> {
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

    public async connectLocalClient(url: string, roomName: string) {
        this.checkConnection(url).then(async (canConnect: boolean) => {
            if (!canConnect) {
                logger.info(`Connection check to ${url} failed. Scheduling reconnect...`);
                this.plugin.scheduleReconnect(roomName);
            } else {
                this.plugin.clientReconnectAttempts = 0;
                await this.plugin.yjsService.providerManager.connectStrategy('local', roomName, this.plugin.settings);
            }
        });
    }

    private async handleDiscoveredHost(host: DiscoveryPeerInfo) {
        if (!this.plugin.settings.enableLocalSync) return;

        if (this.isLocalHost) {
            // Split-brain detection
            const myId = this.plugin.yjsService.ydoc.clientID.toString();
            // Tie breaker: string comparison of device IDs to be deterministic
            if (host.deviceId < myId) {
                logger.info(`[Split-Brain] Another host with lower deviceID (${host.deviceId} < ${myId}) detected. Stepping down.`);
                this.plugin.localServerService.stopServer();
                this.lanDiscoveryService.stopBroadcasting();
                this.lanDiscoveryService.startListening();
                this.isLocalHost = false;

                const roomName = await this.plugin.getRoomName();
                this.plugin.yjsService.providerManager.disconnectStrategy('local');
                this.connectToDiscoveredHost(host, roomName);
            } else {
                logger.info(`[Split-Brain] Another host with higher deviceID detected. Remaining Host.`);
            }
        } else if (!this.leaderElectionTimeout) {
            // We are a client and discovered a host. Connect to it (if not already connected to it).
            const url = `ws://${host.ip}:${host.port}`;
            if (this.plugin.settings.discoveredLocalAddress !== url) {
                const roomName = await this.plugin.getRoomName();
                this.plugin.yjsService.providerManager.disconnectStrategy('local');
                this.connectToDiscoveredHost(host, roomName);
            }
        }
    }

    private async handleLostHost(host: DiscoveryPeerInfo) {
        if (!this.plugin.settings.enableLocalSync) return;

        const hostUrl = `ws://${host.ip}:${host.port}`;
        // If we were connected to this host as a client, trigger re-election
        if (!this.isLocalHost && this.plugin.settings.discoveredLocalAddress === hostUrl) {
            logger.info(`Host ${host.name} (${hostUrl}) lost UDP heartbeat. Triggering re-election...`);
            this.plugin.yjsService.providerManager.disconnectStrategy('local');
            this.startElection();
        }
    }
}
