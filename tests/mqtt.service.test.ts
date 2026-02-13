import { MqttService } from '../src/services/mqtt.service';
import { P2PSettings, DEFAULT_SETTINGS } from '../src/settings';
import * as mqtt from 'mqtt';

jest.mock('mqtt', () => ({
    connect: jest.fn(),
}));

describe('MqttService', () => {
    let service: MqttService;
    let mockClient: any;
    let settings: P2PSettings;

    beforeEach(() => {
        settings = { ...DEFAULT_SETTINGS, deviceName: 'TestDevice', secretKey: 'secret' };
        mockClient = {
            on: jest.fn(),
            subscribe: jest.fn(),
            publish: jest.fn(),
            end: jest.fn(),
            connected: true,
        };
        (mqtt.connect as jest.Mock).mockReturnValue(mockClient);

        service = new MqttService(settings, async () => 'mock-hash');
    });

    afterEach(() => {
        jest.clearAllMocks();
    });

    it('should connect to MQTT broker', async () => {
        await service.connect();

        expect(mqtt.connect).toHaveBeenCalledWith(settings.discoveryServer, expect.any(Object));
        expect(mockClient.on).toHaveBeenCalledWith('connect', expect.any(Function));

        // Simulate connect event
        const connectCallback = mockClient.on.mock.calls.find((call: any) => call[0] === 'connect')[1];
        connectCallback();

        expect(mockClient.subscribe).toHaveBeenCalledWith(expect.stringContaining('announce'), expect.any(Function));
        expect(mockClient.subscribe).toHaveBeenCalledWith(expect.stringContaining('signal/TestDevice'), expect.any(Function));
    });

    it('should handle incoming messages', async () => {
        const onSignal = jest.fn();
        service.setCallbacks(onSignal, jest.fn());
        await service.connect();

        // Simulate message event
        const messageCallback = mockClient.on.mock.calls.find((call: any) => call[0] === 'message')[1];
        messageCallback('topic', Buffer.from('test-message'));

        expect(onSignal).toHaveBeenCalledWith('test-message');
    });

    it('should publish messages', async () => {
        await service.connect();
        service.publish('topic', 'message');
        expect(mockClient.publish).toHaveBeenCalledWith('topic', 'message');
    });

    it('should disconnect', async () => {
        await service.connect();
        service.disconnect();
        expect(mockClient.end).toHaveBeenCalled();
    });
});
