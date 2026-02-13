import { LocalServerService } from '../src/services/local-server.service';
import { P2PSettings, DEFAULT_SETTINGS } from '../src/settings';

// Mock Implementation
const mockWsOn = jest.fn();
const mockWsSend = jest.fn();
const mockWsClose = jest.fn();
const mockWssOn = jest.fn();
const mockWssClose = jest.fn();
const mockWssClients = new Set();
// Store callback for manual triggering
let connectionCallback: any;

class MockWebSocketClient {
    on = mockWsOn;
    send = mockWsSend;
    close = mockWsClose;
    readyState = 1;
}

class MockWebSocketServer {
    clients = mockWssClients;
    constructor() { }
    on(event: string, cb: any) {
        if (event === 'connection') connectionCallback = cb;
        mockWssOn(event, cb);
    }
    close() { mockWssClose(); }
}

jest.mock('ws', () => {
    return {
        WebSocketServer: MockWebSocketServer,
        default: MockWebSocketClient // if imported as default
    };
});

jest.mock('obsidian');

describe('LocalServerService', () => {
    let service: LocalServerService;
    let settings: P2PSettings;

    beforeEach(() => {
        settings = { ...DEFAULT_SETTINGS };
        service = new LocalServerService(settings);
        mockWssClients.clear();
        mockWssOn.mockClear();
        mockWsOn.mockClear();
        connectionCallback = undefined;
    });

    afterEach(() => {
        service.stopServer();
        jest.clearAllMocks();
    });

    it('should start server and listen for connections', async () => {
        await service.startServer();
        // Wait for dynamic import to resolve
        await new Promise(resolve => setTimeout(resolve, 10));
        expect(mockWssOn).toHaveBeenCalledWith('connection', expect.any(Function));
    });

    it('should track connected clients and update names', async () => {
        const onClientsUpdated = jest.fn();
        // Mock decrypt just to return the JSON payload
        service.setCallbacks(
            jest.fn(),
            onClientsUpdated,
            jest.fn(),
            async (msg) => { try { return JSON.parse(msg); } catch (e) { return null; } }
        );

        await service.startServer();
        await new Promise(resolve => setTimeout(resolve, 10));

        const mockSocket = new MockWebSocketClient();

        // Trigger connection
        expect(connectionCallback).toBeDefined();
        connectionCallback(mockSocket);

        // Initially "Connecting..."
        expect(service.connectedClients.get(mockSocket)).toBe('Connecting...');
        expect(onClientsUpdated).toHaveBeenCalled();

        // Simulate message with sender info
        // Need to capture the message callback on the socket
        const socketMessageCallback = mockWsOn.mock.calls.find(call => call[0] === 'message')[1];
        expect(socketMessageCallback).toBeDefined();

        const helloMsg = JSON.stringify({ sender: 'TestClient' });
        await socketMessageCallback(helloMsg);

        expect(service.connectedClients.get(mockSocket)).toBe('TestClient');
        expect(onClientsUpdated).toHaveBeenCalledTimes(2);
    });
});
