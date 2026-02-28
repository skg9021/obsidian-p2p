
import { ConnectionStrategy, StrategyId } from './strategies/connection-strategy.interface';
import { logger } from './logger.service';
import { PeerInfo, ConnectionStatus } from './p2p-types';

export class ProviderManager {
    private strategies: Map<StrategyId, ConnectionStrategy> = new Map();

    /**
     * Aggregated list of all connected peers from all strategies.
     */
    private aggregatedPeers: PeerInfo[] = [];

    /**
     * Callback for when the aggregated peer list changes.
     */
    public onPeersUpdated: (peers: PeerInfo[]) => void = () => { };

    /**
     * Map of strategy statuses.
     */
    private strategyStatuses: Map<StrategyId, ConnectionStatus> = new Map();

    /**
     * Callback for when the aggregated connection status changes.
     */
    public onAggregatedStatusChanged: (status: ConnectionStatus) => void = () => { };
    private currentAggregatedStatus: ConnectionStatus = 'disconnected';

    constructor() { }

    registerStrategy(strategy: ConnectionStrategy) {
        if (this.strategies.has(strategy.id)) {
            logger.warn(`[ProviderManager] Strategy ${strategy.id} already registered. Overwriting.`);
            this.strategies.get(strategy.id)?.destroy();
        }
        this.strategies.set(strategy.id, strategy);
        this.strategyStatuses.set(strategy.id, 'disconnected');

        // Listen to peer updates from this strategy
        strategy.onPeerUpdate(() => {
            this.recalculateAggregatedPeers();
        });

        // Listen to status updates from this strategy
        strategy.onStatusChanged((status) => {
            this.strategyStatuses.set(strategy.id, status);
            this.recalculateAggregatedStatus();
        });
    }

    getStrategy(id: StrategyId): ConnectionStrategy | undefined {
        return this.strategies.get(id);
    }

    getStrategies(): ConnectionStrategy[] {
        return Array.from(this.strategies.values());
    }

    async connectStrategy(id: StrategyId, roomName: string, settings?: any) {
        const strategy = this.strategies.get(id);
        if (!strategy) {
            logger.warn(`[ProviderManager] Cannot connect: Strategy ${id} not found.`);
            return;
        }
        logger.info(`[ProviderManager] Connecting strategy ${id} to room ${roomName}`);
        await strategy.connect(roomName, settings);
    }

    async connectAll(roomName: string, settings: any) {
        for (const strategy of this.strategies.values()) {
            try {
                await strategy.connect(roomName, settings);
            } catch (e) {
                logger.error(`[ProviderManager] Failed to connect strategy ${strategy.id}`, e);
            }
        }
    }

    disconnectStrategy(id: StrategyId) {
        const strategy = this.strategies.get(id);
        if (strategy) {
            strategy.disconnect();
        }
    }

    disconnectAll() {
        this.strategies.forEach(strategy => strategy.disconnect());
    }

    destroy() {
        this.strategies.forEach(strategy => strategy.destroy());
        this.strategies.clear();
        this.strategyStatuses.clear();
        this.aggregatedPeers = [];
        this.emitAggregatedStatus('disconnected');
    }

    getPeers(): PeerInfo[] {
        return this.aggregatedPeers;
    }

    /**
     * Aggregates peers from all strategies and merges duplicate clients.
     * Determines 'source' (local, internet, both) based on which strategies see the client.
     */
    private recalculateAggregatedPeers() {
        // Map of ClientID -> Set of StrategyIds that see this client
        const clientNoticedBy = new Map<number, Set<StrategyId>>();
        // Map of ClientID -> Basic Peer Info (name, ip) - keep latest
        const clientData = new Map<number, Omit<PeerInfo, 'source'>>();

        this.strategies.forEach((strategy, strategyId) => {
            const strategyPeers = strategy.getPeers();
            strategyPeers.forEach(peer => {
                if (!clientNoticedBy.has(peer.clientId)) {
                    clientNoticedBy.set(peer.clientId, new Set());
                }
                clientNoticedBy.get(peer.clientId)?.add(strategyId);

                // Update basic data (might overwrite, which is usually fine for same client)
                clientData.set(peer.clientId, {
                    clientId: peer.clientId,
                    name: peer.name,
                    ip: peer.ip
                });
            });
        });

        const newAggregatedList: PeerInfo[] = [];

        clientData.forEach((info, clientId) => {
            const seenBy = clientNoticedBy.get(clientId);
            if (!seenBy) return;

            let source: PeerInfo['source'] = 'unknown';
            const seenByLocal = seenBy.has('local');
            const seenByMqtt = seenBy.has('mqtt');
            // Check for standard strategy IDs or generic ones
            // Assuming 'local' and 'mqtt' are the standard IDs used.

            if (seenByLocal && seenByMqtt) {
                source = 'both';
            } else if (seenByLocal) {
                source = 'local';
            } else if (seenByMqtt) {
                source = 'internet';
            } else {
                // If it's some other strategy (e.g. nostr), we might need a generic fallback
                // or just default to 'internet' if not explicitly local?
                // For now, let's just say 'internet' if it's not local, or keep 'unknown'
                // But the UI expects specific strings.
                source = 'internet';
            }

            newAggregatedList.push({
                ...info,
                source
            });
        });

        this.aggregatedPeers = newAggregatedList;
        this.onPeersUpdated(this.aggregatedPeers);
    }

    /**
     * Recalculates the overall connection status across all strategies.
     */
    private recalculateAggregatedStatus() {
        let hasConnected = false;
        let hasConnecting = false;
        let hasError = false;

        this.strategyStatuses.forEach(status => {
            if (status === 'connected') hasConnected = true;
            else if (status === 'connecting') hasConnecting = true;
            else if (status === 'error') hasError = true;
        });

        let newStatus: ConnectionStatus = 'disconnected';
        if (hasConnected) {
            newStatus = 'connected';
        } else if (hasConnecting) {
            newStatus = 'connecting';
        } else if (hasError) {
            newStatus = 'error';
        }

        this.emitAggregatedStatus(newStatus);
    }

    private emitAggregatedStatus(status: ConnectionStatus) {
        if (this.currentAggregatedStatus !== status) {
            this.currentAggregatedStatus = status;
            this.onAggregatedStatusChanged(status);
        }
    }
}
