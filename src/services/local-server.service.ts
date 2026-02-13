import { Notice, Platform } from 'obsidian';
import { P2PSettings } from '../settings';

// Dynamic import for 'ws'
let WebSocketServer: any;
if (!Platform.isMobile) {
    import('ws').then(m => { WebSocketServer = m.WebSocketServer; }).catch(() => { });
}

export class LocalServerService {
    localWss: any | null = null;
    localWsClient: WebSocket | null = null;
    connectedClients: Map<any, string> = new Map(); // ws -> deviceName

    // Callbacks
    private onSignalCallback: (msg: string) => void = () => { };
    private onClientsUpdated: (clients: string[]) => void = () => { };
    private onClientConnectCallback: () => void = () => { };
    private decryptCallback: (msg: string) => Promise<any> = async () => null;

    constructor(private settings: P2PSettings) { }

    private log(msg: string, ...args: any[]) {
        if (this.settings.enableDebugLogs) console.log(`[P2P LocalServer] ${msg}`, ...args);
    }

    setCallbacks(
        onSignal: (msg: string) => void,
        onClientsUpdated: (clients: string[]) => void,
        onClientConnect: () => void,
        decrypt: (msg: string) => Promise<any>
    ) {
        this.onSignalCallback = onSignal;
        this.onClientsUpdated = onClientsUpdated;
        this.onClientConnectCallback = onClientConnect;
        this.decryptCallback = decrypt;
    }

    async getLocalIPs() {
        if (Platform.isMobile) return [];
        try {
            // eslint-disable-next-line @typescript-eslint/no-var-requires
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
            console.error("[P2P LocalServer] Failed to get local IPs", e);
            new Notice("Failed to get local IP: " + e.message);
            return [];
        }
    }

    async startServer() {
        if (!WebSocketServer) {
            this.log('WebSocketServer not available (mobile or failed import)');
            return;
        }

        try {
            const ips = await this.getLocalIPs();
            const ipDisplay = ips.length > 0 ? ips.join(', ') : 'localhost';

            this.log(`Starting WebSocket server on port ${this.settings.localServerPort}...`);
            this.localWss = new WebSocketServer({ port: this.settings.localServerPort });
            new Notice(`Host Mode: ws://${ipDisplay}:${this.settings.localServerPort}`);
            this.log(`Server started: ws://${ipDisplay}:${this.settings.localServerPort}`);

            this.localWss.on('connection', (ws: any, req: any) => {
                const remoteAddr = req?.socket?.remoteAddress || 'unknown';
                this.log(`New WebSocket connection from ${remoteAddr}`);
                this.connectedClients.set(ws, 'Connecting...');
                this.notifyClientsUpdated();

                ws.on('message', async (data: any) => {
                    const msgStr = data.toString();
                    this.log(`Server received message, size=${msgStr.length}b, from=${this.connectedClients.get(ws)}`);

                    // Broadcast to other clients
                    let broadcastCount = 0;
                    this.localWss.clients.forEach((c: any) => {
                        if (c !== ws && c.readyState === 1) {
                            c.send(msgStr);
                            broadcastCount++;
                        }
                    });
                    this.log(`Broadcast to ${broadcastCount} other client(s)`);

                    // Try to decrypt to identify sender
                    try {
                        const payload = await this.decryptCallback(msgStr);
                        if (payload && payload.sender) {
                            const currentName = this.connectedClients.get(ws);
                            if (currentName !== payload.sender) {
                                this.log(`Client identified: ${currentName} -> ${payload.sender}`);
                                this.connectedClients.set(ws, payload.sender);
                                this.notifyClientsUpdated();
                                new Notice(`Client Connected: ${payload.sender}`);
                            }
                        }
                    } catch (e) {
                        this.log('Could not decrypt message for client identification');
                    }

                    this.onSignalCallback(msgStr);
                });

                ws.on('close', () => {
                    const name = this.connectedClients.get(ws);
                    this.log(`Client disconnected: ${name} (${remoteAddr})`);
                    if (name && name !== 'Connecting...') new Notice(`Client Disconnected: ${name}`);
                    this.connectedClients.delete(ws);
                    this.notifyClientsUpdated();
                });

                ws.on('error', (err: any) => {
                    this.log(`Client socket error (${remoteAddr}):`, err.message);
                });
            });

            this.localWss.on('error', (err: any) => {
                this.log('Server error:', err.message);
                console.error('[P2P LocalServer] Server error:', err);
            });

        } catch (e) {
            this.log('Local Server Start Failed:', e);
            console.error("[P2P LocalServer] Local Server Start Failed", e);
        }
    }

    stopServer() {
        if (this.localWss) {
            this.log('Stopping local server');
            this.localWss.close();
            this.localWss = null;
            this.connectedClients.clear();
            this.notifyClientsUpdated();
            this.log('Local server stopped');
        } else {
            this.log('stopServer called but no server running');
        }
    }

    connectToHost() {
        this.log(`Connecting to host at ${this.settings.localServerAddress}...`);
        try {
            this.localWsClient = new WebSocket(this.settings.localServerAddress);
            this.localWsClient.onopen = () => {
                this.log('Connected to host relay successfully');
                new Notice("Connected to Local Relay");
                this.onClientConnectCallback();
            };
            this.localWsClient.onmessage = (ev) => {
                this.log(`Client received message from relay, size=${ev.data.toString().length}b`);
                this.onSignalCallback(ev.data.toString());
            };
            this.localWsClient.onerror = (e) => {
                this.log('Client connection error');
                console.error("[P2P LocalServer] Local Client Error", e);
                new Notice("Failed to connect to Local Relay");
            };
            this.localWsClient.onclose = () => {
                this.log('Client connection to host closed');
            };
        } catch (e) {
            this.log('connectToHost exception:', e);
            console.error("[P2P LocalServer] Local Client Failed", e);
        }
    }

    disconnectFromHost() {
        if (this.localWsClient) {
            this.log('Disconnecting from host');
            this.localWsClient.close();
            this.localWsClient = null;
        }
    }

    broadcast(message: string) {
        if (this.localWsClient?.readyState === WebSocket.OPEN) {
            this.log(`Broadcasting via client relay, size=${message.length}b`);
            this.localWsClient.send(message);
        }
        if (this.localWss) {
            let count = 0;
            this.localWss.clients.forEach((c: any) => {
                if (c.readyState === 1) { c.send(message); count++; }
            });
            this.log(`Broadcast to ${count} server client(s), size=${message.length}b`);
        }
    }

    private notifyClientsUpdated() {
        const clients = Array.from(this.connectedClients.values());
        this.log(`Clients list updated: [${clients.join(', ')}]`);
        this.onClientsUpdated(clients);
    }
}
