
import { ProviderManager } from '../src/services/provider-manager.service';
import { ConnectionStrategy, StrategyId } from '../src/services/strategies/connection-strategy.interface';
import { PeerInfo } from '../src/services/p2p-types';
import * as Y from 'yjs';
// @ts-ignore
import * as awarenessProtocol from 'y-protocols/awareness';

class MockStrategy implements ConnectionStrategy {
    id: StrategyId;
    name: string;
    peers: PeerInfo[] = [];
    peerCallback: ((peers: PeerInfo[]) => void) | null = null;
    connected: boolean = false;
    underlyingProvider: any = {};

    constructor(id: string, name: string) {
        this.id = id;
        this.name = name;
    }

    initialize(doc: Y.Doc, awareness: any): void { }

    async connect(roomName: string, settings: any): Promise<void> {
        this.connected = true;
    }

    disconnect(): void {
        this.connected = false;
    }

    destroy(): void { }

    isConnected(): boolean {
        return this.connected;
    }

    getPeers(): PeerInfo[] {
        return this.peers;
    }

    onPeerUpdate(callback: (peers: PeerInfo[]) => void): void {
        this.peerCallback = callback;
    }

    getUnderlyingProvider(): any {
        return this.underlyingProvider;
    }

    // Helper for tests
    emitPeers(peers: PeerInfo[]) {
        this.peers = peers;
        if (this.peerCallback) {
            this.peerCallback(this.peers);
        }
    }
}

describe('ProviderManager', () => {
    let manager: ProviderManager;
    let mqttStrategy: MockStrategy;
    let localStrategy: MockStrategy;

    beforeEach(() => {
        manager = new ProviderManager();
        mqttStrategy = new MockStrategy('mqtt', 'MQTT Strategy');
        localStrategy = new MockStrategy('local', 'Local Strategy');

        manager.registerStrategy(mqttStrategy);
        manager.registerStrategy(localStrategy);
    });

    afterEach(() => {
        manager.destroy();
    });

    test('should register strategies', () => {
        expect(manager.getStrategy('mqtt')).toBeDefined();
        expect(manager.getStrategy('local')).toBeDefined();
        expect(manager.getStrategies().length).toBe(2);
    });

    test('should connect all strategies', async () => {
        await manager.connectAll('test-room', { enableMqttDiscovery: true, enableLocalServer: true });
        expect(mqttStrategy.isConnected()).toBe(true);
        expect(localStrategy.isConnected()).toBe(true);
    });

    test('should disconnect all strategies', () => {
        mqttStrategy.connected = true;
        localStrategy.connected = true;
        manager.disconnectAll();
        expect(mqttStrategy.isConnected()).toBe(false);
        expect(localStrategy.isConnected()).toBe(false);
    });

    test('should aggregate peers correctly - single source', () => {
        const p1: PeerInfo = { clientId: 1, name: 'User1', source: 'internet' };

        mqttStrategy.emitPeers([p1]);

        const peers = manager.getPeers();
        expect(peers.length).toBe(1);
        expect(peers[0].clientId).toBe(1);
        expect(peers[0].source).toBe('internet');
    });

    test('should aggregate peers correctly - both sources', () => {
        const p1_mqtt: PeerInfo = { clientId: 1, name: 'User1', source: 'internet' }; // source here is ignored by manager aggregation logic
        const p1_local: PeerInfo = { clientId: 1, name: 'User1', source: 'local' };

        mqttStrategy.emitPeers([p1_mqtt]);
        localStrategy.emitPeers([p1_local]);

        const peers = manager.getPeers();
        expect(peers.length).toBe(1);
        expect(peers[0].clientId).toBe(1);
        expect(peers[0].source).toBe('both');
    });

    test('should handle distinct peers', () => {
        const p1: PeerInfo = { clientId: 1, name: 'User1', source: 'internet' };
        const p2: PeerInfo = { clientId: 2, name: 'User2', source: 'local' };

        mqttStrategy.emitPeers([p1]);
        localStrategy.emitPeers([p2]);

        const peers = manager.getPeers();
        expect(peers.length).toBe(2);

        const u1 = peers.find(p => p.clientId === 1);
        const u2 = peers.find(p => p.clientId === 2);

        expect(u1).toBeDefined();
        expect(u1?.source).toBe('internet');

        expect(u2).toBeDefined();
        expect(u2?.source).toBe('local');
    });

    test('should emit update event', () => {
        const callback = jest.fn();
        manager.onPeersUpdated = callback;

        const p1: PeerInfo = { clientId: 1, name: 'User1', source: 'internet' };
        mqttStrategy.emitPeers([p1]);

        expect(callback).toHaveBeenCalled();
        expect(callback).toHaveBeenCalledWith(expect.arrayContaining([
            expect.objectContaining({ clientId: 1 })
        ]));
    });
});
