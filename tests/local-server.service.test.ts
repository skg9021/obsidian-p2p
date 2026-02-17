
import { LocalServerService } from '../src/services/local-server.service';
import { P2PSettings, DEFAULT_SETTINGS } from '../src/settings';

// Mock Implementation
const mockWsOn = jest.fn();
const mockWsSend = jest.fn();
const mockWsClose = jest.fn();

// We need to capture the 'connection' listener registered by the service
let serverConnectionListener: any;
const mockWssOn = jest.fn((event, cb) => {
    if (event === 'connection') serverConnectionListener = cb;
});
const mockWssClose = jest.fn();

class MockWebSocketClient {
    on = mockWsOn;
    send = mockWsSend;
    close = mockWsClose;
    readyState = 1;
    socket = { remoteAddress: '192.168.1.5' };
}

class MockWebSocketServer {
    constructor() { }
    on = mockWssOn;
    close = mockWssClose;
}

jest.mock('ws', () => {
    return {
        WebSocketServer: MockWebSocketServer,
    };
});

jest.mock('obsidian');

describe('LocalServerService', () => {
    let service: LocalServerService;
    let settings: P2PSettings;

    beforeEach(() => {
        settings = { ...DEFAULT_SETTINGS };
        service = new LocalServerService(settings);
        mockWssOn.mockClear();
        mockWsOn.mockClear();
        mockWsSend.mockClear();
        serverConnectionListener = undefined;
    });

    afterEach(() => {
        service.stopServer();
        jest.clearAllMocks();
    });

    it('should start server and listen for connections', async () => {
        await service.startServer();
        // Wait for dynamic import logic if any (service uses require 'ws')
        expect(mockWssOn).toHaveBeenCalledWith('connection', expect.any(Function));
    });

    it('should track connected clients', async () => {
        const onClientsUpdated = jest.fn();
        service.setCallbacks(onClientsUpdated);

        await service.startServer();

        const mockSocket = new MockWebSocketClient();

        // Trigger connection
        expect(serverConnectionListener).toBeDefined();
        serverConnectionListener(mockSocket, { socket: { remoteAddress: '192.168.1.5' } });

        expect(onClientsUpdated).toHaveBeenCalled();
        expect(onClientsUpdated).toHaveBeenCalledWith(expect.arrayContaining(['192.168.1.5']));
    });
});
