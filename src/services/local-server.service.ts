import { Notice, Platform } from 'obsidian';
import { P2PSettings } from '../settings';

/**
 * y-webrtc compatible signaling server.
 * 
 * This is a simple JSON pubsub relay. It does NOT handle any document data.
 * Peers connect, subscribe to a room topic, and then exchange WebRTC
 * signaling messages (offers, answers, ICE candidates) through it.
 * Once WebRTC connections are established, all sync is direct P2P.
 * 
 * Protocol (JSON messages):
 *   Client → Server: {"type":"subscribe","topics":["room-name"]}
 *   Client → Server: {"type":"publish","topic":"room-name",...data}
 *   Client → Server: {"type":"ping"}
 *   Server → Client: {"type":"pong"}
 */
export class LocalServerService {
    private localWss: any | null = null;
    private connectedClients: Map<any, string> = new Map();

    /** Map from topic name to set of subscribed WebSocket connections */
    private topics: Map<string, Set<any>> = new Map();

    private onClientsUpdated: (clients: string[]) => void = () => { };

    constructor(private settings: P2PSettings) { }

    private log(msg: string, ...args: any[]) {
        if (this.settings.enableDebugLogs) console.log(`[P2P SignalingServer] ${msg}`, ...args);
    }

    setCallbacks(onClientsUpdated: (clients: string[]) => void) {
        this.onClientsUpdated = onClientsUpdated;
    }

    async getLocalIPs(): Promise<string[]> {
        if (Platform.isMobile) return [];
        try {
            const os = require('os');
            const nets = os.networkInterfaces();
            const results: string[] = [];
            for (const name of Object.keys(nets)) {
                for (const net of nets[name] || []) {
                    if ((net.family === 'IPv4' || net.family === 4) && !net.internal) {
                        results.push(net.address);
                    }
                }
            }
            this.log(`Detected local IPs: [${results.join(', ')}]`);
            return results;
        } catch (e) {
            console.error("[P2P SignalingServer] Failed to get local IPs", e);
            return [];
        }
    }

    async startServer() {
        if (Platform.isMobile) return;

        let WebSocketServer: any;
        try {
            const wsModule = require('ws');
            WebSocketServer = wsModule.WebSocketServer;
        } catch (e) {
            this.log('Failed to load ws module', e);
            new Notice("Failed to load WebSocket module: " + (e as any).message);
            return;
        }

        if (!WebSocketServer) {
            this.log('WebSocketServer not available');
            return;
        }

        try {
            const ips = await this.getLocalIPs();
            const ipDisplay = ips.length > 0 ? ips.join(', ') : 'localhost';

            this.log(`Starting signaling server on port ${this.settings.localServerPort}...`);
            try {
                this.localWss = new WebSocketServer({ port: this.settings.localServerPort });

                this.localWss.on('error', (e: any) => {
                    if (e.code === 'EADDRINUSE') {
                        new Notice(`Port ${this.settings.localServerPort} is already in use!`);
                        this.log('Server Error: Address in use', e);
                        this.stopServer();
                    } else {
                        console.error('Server Error', e);
                    }
                });

                new Notice(`Signaling Server: ws://${ipDisplay}:${this.settings.localServerPort}`);
                this.log(`Signaling server started: ws://${ipDisplay}:${this.settings.localServerPort}`);
            } catch (e) {
                this.log('Failed to create WebSocketServer', e);
                new Notice('Failed to start signaling server. Check logs.');
                return;
            }

            this.localWss.on('connection', (ws: any, req: any) => {
                const remoteAddr = req?.socket?.remoteAddress || 'unknown';
                this.log(`Peer connected from ${remoteAddr}`);
                this.connectedClients.set(ws, remoteAddr);
                this.notifyClientsUpdated();

                const subscribedTopics = new Set<string>();

                // Keepalive ping
                let pongReceived = true;
                const pingInterval = setInterval(() => {
                    if (!pongReceived) {
                        ws.close();
                        clearInterval(pingInterval);
                    } else {
                        pongReceived = false;
                        try { ws.ping(); } catch { ws.close(); }
                    }
                }, 30000);

                ws.on('pong', () => { pongReceived = true; });

                ws.on('close', () => {
                    clearInterval(pingInterval);
                    this.log(`Peer disconnected: ${remoteAddr}`);

                    // Remove from all subscribed topics
                    subscribedTopics.forEach(topicName => {
                        const subs = this.topics.get(topicName);
                        if (subs) {
                            subs.delete(ws);
                            if (subs.size === 0) this.topics.delete(topicName);
                        }
                    });
                    subscribedTopics.clear();

                    this.connectedClients.delete(ws);
                    this.notifyClientsUpdated();
                });

                ws.on('message', (rawMessage: any) => {
                    let message: any;
                    try {
                        message = JSON.parse(typeof rawMessage === 'string' ? rawMessage : rawMessage.toString());
                    } catch {
                        this.log('Received non-JSON message, ignoring');
                        return;
                    }

                    if (!message || !message.type) return;

                    switch (message.type) {
                        case 'subscribe':
                            (message.topics || []).forEach((topicName: string) => {
                                if (typeof topicName !== 'string') return;
                                if (!this.topics.has(topicName)) {
                                    this.topics.set(topicName, new Set());
                                }
                                this.topics.get(topicName)!.add(ws);
                                subscribedTopics.add(topicName);
                                this.log(`Peer subscribed to topic: ${topicName}`);
                            });
                            break;

                        case 'unsubscribe':
                            (message.topics || []).forEach((topicName: string) => {
                                const subs = this.topics.get(topicName);
                                if (subs) {
                                    subs.delete(ws);
                                    if (subs.size === 0) this.topics.delete(topicName);
                                }
                                subscribedTopics.delete(topicName);
                            });
                            break;

                        case 'publish':
                            if (message.topic) {
                                const receivers = this.topics.get(message.topic);
                                if (receivers) {
                                    message.clients = receivers.size;
                                    const data = JSON.stringify(message);
                                    receivers.forEach((receiver: any) => {
                                        if (receiver.readyState === 1) { // OPEN
                                            try { receiver.send(data); } catch { /* ignore */ }
                                        }
                                    });
                                    this.log(`Relayed message to ${receivers.size} peer(s) on topic: ${message.topic}`);
                                }
                            }
                            break;

                        case 'ping':
                            this.send(ws, { type: 'pong' });
                            break;

                        default:
                            this.log(`Unknown message type: ${message.type}`);
                    }
                });

                ws.on('error', (err: any) => {
                    this.log(`Peer socket error (${remoteAddr}):`, err.message);
                });
            });

            this.localWss.on('error', (err: any) => {
                this.log('Server error:', err.message);
                console.error('[P2P SignalingServer] Server error:', err);
            });

        } catch (e) {
            this.log('Signaling Server Start Failed:', e);
            console.error("[P2P SignalingServer] Start Failed", e);
        }
    }

    private send(ws: any, message: any) {
        if (ws.readyState === 1) { // OPEN
            try { ws.send(JSON.stringify(message)); } catch { /* ignore */ }
        }
    }

    stopServer() {
        if (this.localWss) {
            this.log('Stopping signaling server');
            this.localWss.close();
            this.localWss = null;
            this.connectedClients.clear();
            this.topics.clear();
            this.notifyClientsUpdated();
            this.log('Signaling server stopped');
        }
    }

    private notifyClientsUpdated() {
        const clients = Array.from(this.connectedClients.values());
        this.log(`Peers Signalled and connected on signalling socket: ${clients.length} [${clients.join(', ')}]`);
        this.onClientsUpdated(clients);
    }
}
