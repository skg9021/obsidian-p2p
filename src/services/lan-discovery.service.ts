import { Platform, Events, Notice } from 'obsidian';
import { logger } from './logger.service';

const DISCOVERY_PORT = 41238; // Using a unique port
const DISCOVERY_MULTICAST_ADDRESS = '224.0.0.114';

export interface DiscoveryPeerInfo {
    deviceId: string;
    name: string;
    ip: string | null;
    port: number;
}

export interface DiscoveryBeacon {
    type: 'obsidian-p2p-beacon';
    peerInfo: DiscoveryPeerInfo;
}

export class LANDiscoveryService extends Events {
    private socket: any | null = null;
    private broadcastInterval: number | null = null;
    private discoveredPeers: Map<string, DiscoveryPeerInfo> = new Map();
    private peerTimeouts: Map<string, number> = new Map();
    private discoveryTimeoutMs: number = 5000;
    private myDeviceId: string | null = null;

    constructor() {
        super();
    }

    private createSocket() {
        if (this.socket || Platform.isMobile) return;

        try {
            const dgram = require('dgram');
            this.socket = dgram.createSocket({ type: 'udp4', reuseAddr: true });

            this.socket.on('error', (err: Error) => {
                logger.error('LAN Discovery Socket Error:', err);
                this.stop();
            });

            this.socket.on('listening', () => {
                try {
                    this.socket?.setMulticastTTL(128);

                    const os = require('os');
                    const interfaces = os.networkInterfaces();
                    let membershipAdded = false;

                    for (const name in interfaces) {
                        const ifaceList = interfaces[name];
                        if (!ifaceList) continue;
                        for (const net of ifaceList) {
                            if (net.family === 'IPv4' && !net.internal) {
                                try {
                                    this.socket?.addMembership(DISCOVERY_MULTICAST_ADDRESS, net.address);
                                    membershipAdded = true;
                                } catch (e) {
                                    // Ignore specific interface errors
                                }
                            }
                        }
                    }

                    if (!membershipAdded) {
                        this.socket?.addMembership(DISCOVERY_MULTICAST_ADDRESS);
                    }

                    logger.info(`LAN Discovery listening on ${DISCOVERY_MULTICAST_ADDRESS}:${DISCOVERY_PORT}`);
                } catch (e) {
                    logger.error("Error setting up multicast:", e);
                }
            });

            this.socket.on('message', (msg: Buffer, rinfo: any) => {
                try {
                    const data: DiscoveryBeacon = JSON.parse(msg.toString());
                    if (data.type === 'obsidian-p2p-beacon' && data.peerInfo?.deviceId) {
                        const peerId = data.peerInfo.deviceId;
                        if (this.myDeviceId && peerId === this.myDeviceId) return;

                        if (this.peerTimeouts.has(peerId)) {
                            clearTimeout(this.peerTimeouts.get(peerId)!);
                        }

                        const isNew = !this.discoveredPeers.has(peerId);
                        data.peerInfo.ip = rinfo.address;
                        this.discoveredPeers.set(peerId, data.peerInfo);

                        if (isNew) {
                            this.trigger('discover', data.peerInfo);
                        }

                        const timeout = window.setTimeout(() => {
                            this.discoveredPeers.delete(peerId);
                            this.peerTimeouts.delete(peerId);
                            this.trigger('lose', data.peerInfo);
                        }, this.discoveryTimeoutMs);
                        this.peerTimeouts.set(peerId, timeout);
                    }
                } catch (e) {
                    // Ignore parsing errors for non-beacon traffic on this port
                }
            });

            this.socket.bind(DISCOVERY_PORT, '0.0.0.0');
        } catch (e) {
            logger.error("Failed to initialize dgram/socket for LAN Discovery", e);
        }
    }

    public startBroadcasting(peerInfo: DiscoveryPeerInfo) {
        if (Platform.isMobile) return;

        this.myDeviceId = peerInfo.deviceId;
        this.stopBroadcasting();
        this.createSocket();

        const beaconMessage = JSON.stringify({
            type: 'obsidian-p2p-beacon',
            peerInfo
        });

        const sendBeacon = () => {
            if (this.socket) {
                this.socket.send(beaconMessage, 0, beaconMessage.length, DISCOVERY_PORT, DISCOVERY_MULTICAST_ADDRESS, (err: Error | null) => {
                    if (err) logger.error("Beacon send error:", err);
                });
            }
        };

        // Broadcast every 2 seconds
        this.broadcastInterval = window.setInterval(sendBeacon, 2000);
        // Immediate first broadcast
        sendBeacon();
    }

    public stopBroadcasting() {
        if (this.broadcastInterval !== null) {
            clearInterval(this.broadcastInterval);
            this.broadcastInterval = null;
        }
    }

    public startListening() {
        if (Platform.isMobile) return;
        this.createSocket();
    }

    public stop() {
        this.stopBroadcasting();
        if (this.socket) {
            try {
                this.socket.close();
            } catch (e) {
                logger.error("Error closing LAN Discovery socket", e);
            }
            this.socket = null;
        }
        this.discoveredPeers.clear();
        this.peerTimeouts.forEach(timeout => clearTimeout(timeout));
        this.peerTimeouts.clear();
        logger.info('LAN Discovery stopped.');
    }

    public getDiscoveredPeers(): DiscoveryPeerInfo[] {
        return Array.from(this.discoveredPeers.values());
    }
}
