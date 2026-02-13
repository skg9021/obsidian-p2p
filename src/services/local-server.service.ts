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

    async startServer() {
        if (!WebSocketServer) return;

        try {
            const ips = await this.getLocalIPs();
            const ipDisplay = ips.length > 0 ? ips.join(', ') : 'localhost';

            this.localWss = new WebSocketServer({ port: this.settings.localServerPort });
            new Notice(`Host Mode: ws://${ipDisplay}:${this.settings.localServerPort}`);
            console.log(`P2P Host Mode Active on: ${ips.map(ip => `ws://${ip}:${this.settings.localServerPort}`).join(', ')}`);

            this.localWss.on('connection', (ws: any) => {
                this.connectedClients.set(ws, 'Connecting...');
                this.notifyClientsUpdated();

                ws.on('message', async (data: any) => {
                    const msgStr = data.toString();

                    this.localWss.clients.forEach((c: any) => {
                        if (c !== ws && c.readyState === 1) c.send(msgStr);
                    });

                    // Try to decrypt to identify sender
                    try {
                        const payload = await this.decryptCallback(msgStr);
                        if (payload && payload.sender) {
                            const currentName = this.connectedClients.get(ws);
                            if (currentName !== payload.sender) {
                                this.connectedClients.set(ws, payload.sender);
                                this.notifyClientsUpdated();
                                new Notice(`Client Connected: ${payload.sender}`);
                            }
                        }
                    } catch (e) { }

                    this.onSignalCallback(msgStr);
                });

                ws.on('close', () => {
                    const name = this.connectedClients.get(ws);
                    if (name && name !== 'Connecting...') new Notice(`Client Disconnected: ${name}`);
                    this.connectedClients.delete(ws);
                    this.notifyClientsUpdated();
                });
            });
        } catch (e) { console.error("Local Server Start Failed", e); }
    }

    stopServer() {
        if (this.localWss) {
            this.localWss.close();
            this.localWss = null;
            this.connectedClients.clear();
            this.notifyClientsUpdated();
        }
    }

    connectToHost() {
        try {
            this.localWsClient = new WebSocket(this.settings.localServerAddress);
            this.localWsClient.onopen = () => {
                new Notice("Connected to Local Relay");
                this.onClientConnectCallback();
            };
            this.localWsClient.onmessage = (ev) => {
                this.onSignalCallback(ev.data.toString());
            };
            this.localWsClient.onerror = (e) => {
                console.error("Local Client Error", e);
                new Notice("Failed to connect to Local Relay");
            };
        } catch (e) { console.error("Local Client Failed", e); }
    }

    disconnectFromHost() {
        if (this.localWsClient) {
            this.localWsClient.close();
            this.localWsClient = null;
        }
    }

    broadcast(message: string) {
        if (this.localWsClient?.readyState === WebSocket.OPEN) {
            this.localWsClient.send(message);
        }
        if (this.localWss) {
            this.localWss.clients.forEach((c: any) => { if (c.readyState === 1) c.send(message); });
        }
    }

    private notifyClientsUpdated() {
        this.onClientsUpdated(Array.from(this.connectedClients.values()));
    }
}
