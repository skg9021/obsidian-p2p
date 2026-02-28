/**
 * Patched version of trystero/src/mqtt.js
 *
 * Changes from original:
 * - Passes config.mqttUsername/mqttPassword directly to mqtt.connect() options
 *   instead of relying on URL credential parsing (which can fail in Electron)
 * - Exports closeAllClients() for explicit cleanup (needed because
 *   WebrtcProvider.destroy() defers room cleanup via a Promise, so the
 *   subscribe cleanup runs too late when reconnecting)
 * - Adaptive announce interval (fast discovery, then slow maintenance)
 */
import mqtt, { MqttClient, IClientOptions } from 'mqtt';
import { logger } from './services/logger.service';
// @ts-ignore — no types for trystero internals
import strategy from 'trystero/src/strategy.js';
// @ts-ignore — no types for trystero internals
import { getRelays, selfId, toJson } from 'trystero/src/utils.js';

// ─── Types ───────────────────────────────────────────────────

interface MqttConfig {
    appId?: string;
    password?: string;
    relayUrls?: string[];
    mqttUsername?: string;
    mqttPassword?: string;
    [key: string]: unknown;
}

type MessageHandler = (topic: string, data: string) => void;

const instanceId = Math.random().toString(36).substring(7);
logger.info(`[P2P mqtt-patched] Module loaded, instanceId: ${instanceId}`);

// ─── Module State ────────────────────────────────────────────

const sockets: Record<string, unknown> = {};
const defaultRedundancy = 4;
const msgHandlers: Record<string, Record<string, MessageHandler>> = {};
const getClientId = (client: MqttClient): string =>
    (client as any).options.host + (client as any).options.path;

/** Track all active MQTT clients for explicit cleanup */
const activeClients = new Set<MqttClient>();

// ─── Public API ──────────────────────────────────────────────

/**
 * Force-close all active MQTT clients.
 * Must be called BEFORE creating new providers, because
 * WebrtcProvider.destroy() defers cleanup via this.key.then(),
 * meaning the normal subscribe cleanup runs too late.
 */
export const closeAllClients = (): void => {
    if (activeClients.size > 0) {
        logger.info(`[P2P mqtt-patched] Force-closing ${activeClients.size} active MQTT client(s)`);
        activeClients.forEach(c => {
            const clientId = getClientId(c);
            logger.info(`[P2P mqtt-patched] Force-closing client ${clientId}`);
            try {
                c.end(true, {}, (err) => {
                    if (err) logger.error(`[P2P mqtt-patched] Error closing client ${clientId}:`, err);
                    else logger.info(`[P2P mqtt-patched] Client ${clientId} closed successfully.`);
                });
            } catch (e) {
                logger.error(`[P2P mqtt-patched] Exception closing client ${clientId}:`, e);
            }
        });
        activeClients.clear();
        // Also clean up module-level maps
        Object.keys(sockets).forEach(k => delete sockets[k]);
        Object.keys(msgHandlers).forEach(k => delete msgHandlers[k]);
    }

    // IMPORTANT: Reset the strategy instance so the next joinRoom call
    // creates a new closure with fresh 'didInit' state.
    // This MUST run even if activeClients was empty (e.g. failed initial connection).
    resetStrategy();
};

const createStrategy = () => strategy({
    init: (config: MqttConfig): Promise<MqttClient>[] => {
        logger.info('[P2P mqtt-patched] init called, config keys:', Object.keys(config));
        logger.info('[P2P mqtt-patched] mqttUsername:', config.mqttUsername ? `"${config.mqttUsername}"` : '(not set)');
        logger.info('[P2P mqtt-patched] mqttPassword:', config.mqttPassword ? '(set, length=' + config.mqttPassword.length + ')' : '(not set)');
        logger.info('[P2P mqtt-patched] relayUrls:', config.relayUrls);

        return getRelays(config, defaultRelayUrls, defaultRedundancy).map((url: string) => {
            // Pass MQTT credentials directly via options instead of URL embedding
            const connectOpts: IClientOptions = {};
            if (config.mqttUsername) {
                connectOpts.username = config.mqttUsername;
                connectOpts.password = config.mqttPassword || '';
                connectOpts.reconnectPeriod = 5000;
                connectOpts.reconnectOnConnackError = false;

            }
            logger.info('[P2P mqtt-patched] mqtt.connect URL:', url, 'opts:', JSON.stringify(connectOpts));
            const client = mqtt.connect(url, connectOpts);
            const clientId = getClientId(client);

            activeClients.add(client);
            sockets[clientId] = (client as any).stream?.socket;
            msgHandlers[clientId] = {};

            client
                .on('message', (topic: string, buffer: Buffer) => {
                    logger.info('[P2P mqtt-patched] MQTT message:', topic, buffer.toString());
                    msgHandlers[clientId]?.[topic]?.(topic, buffer.toString());
                })
                .on('error', (err: Error) => {
                    // Ignore expected errors during cleanup
                    if (err.message?.includes('disconnecting')) return;
                    logger.error('[P2P mqtt-patched] MQTT error check:', { msg: err.message, type: typeof err.message });
                    logger.error('[P2P mqtt-patched] MQTT error:', err);
                });
            // We REMOVED the .on('close') handler here.
            // We want clients to stay in activeClients even if they momentarily disconnect,
            // so that closeAllClients() can find them and kill them properly if they are in a reconnect loop.

            return new Promise<MqttClient>(res => client.on('connect', () => {
                logger.info('[P2P mqtt-patched] MQTT connected to', url);
                res(client);
            }));
        });
    },

    subscribe: (
        client: MqttClient,
        rootTopic: string,
        selfTopic: string,
        onMessage: (topic: string, data: string, publish: MqttClient['publish']) => void
    ): (() => void) => {
        const clientId = getClientId(client);

        msgHandlers[clientId][rootTopic] = msgHandlers[clientId][selfTopic] = (
            topic: string,
            data: string
        ) => onMessage(topic, data, client.publish.bind(client));

        client.subscribe(rootTopic);
        client.subscribe(selfTopic);

        // Cleanup: called by strategy.js when leaving room (deferred, may run late)
        return () => {
            logger.info('[P2P mqtt-patched] Subscribe cleanup for', clientId);
            if (!client.connected || (client as any).disconnecting) {
                // Already disconnected/disconnecting, no need to unsubscribe
                delete msgHandlers[clientId];
                delete sockets[clientId];
                activeClients.delete(client);
                return;
            }
            client.unsubscribe(rootTopic);
            client.unsubscribe(selfTopic);
            delete msgHandlers[clientId];
            delete sockets[clientId];
            activeClients.delete(client);
            try { client.end(true); } catch { /* may already be closed by closeAllClients */ }
        };
    },

    announce: (() => {
        let announceCount = 0;
        // Adaptive interval: fast discovery at first, then slow down to save quota
        // strategy.js uses the return value as the next interval in ms
        const fastIntervalMs = 5_000;    // First few announces: 5s (quick peer discovery)
        const slowIntervalMs = 60_000;   // After that: 60s (maintenance, saves quota)
        const fastAnnounceCount = 3;     // Number of fast announces before slowing down

        return (client: MqttClient, rootTopic: string): number => {
            announceCount++;
            // SAFETY: Do not announce if we are already disconnecting
            const isDisconnecting = (client as any).disconnecting;
            if (!client.connected || isDisconnecting) {
                logger.info('[P2P mqtt-patched] Announce skipped (disconnecting or disconnected)');
                return slowIntervalMs;
            }
            try {
                // logger.info('[P2P mqtt-patched] Announce proceeding (connected:', client.connected, ')');
                client.publish(rootTopic, toJson({ peerId: selfId }));
            } catch {
                // Client may have been force-closed by closeAllClients()
                return slowIntervalMs;
            }
            const nextInterval = announceCount <= fastAnnounceCount ? fastIntervalMs : slowIntervalMs;
            logger.info(`[P2P mqtt-patched] announce #${announceCount}, next in ${nextInterval / 1000}s`);
            return nextInterval;
        };
    })()
});

let currentStrategy = createStrategy();

/**
 * Wrapper around the current strategy instance.
 * Allows us to reset the strategy (clearing internal 'didInit' and 'initPromises' state)
 * when we force-close clients.
 */
export const joinRoom = (...args: any[]) => {
    // @ts-ignore
    return currentStrategy(...args);
};

const resetStrategy = () => {
    logger.info('[P2P mqtt-patched] Resetting strategy instance');
    currentStrategy = createStrategy();
};

export const getRelaySockets = (): Record<string, unknown> => ({ ...sockets });

// @ts-ignore — no types for trystero internals
export { selfId } from 'trystero/src/utils.js';

export const defaultRelayUrls: string[] = [
    'test.mosquitto.org:8081/mqtt',
    'broker.emqx.io:8084/mqtt',
    'broker.hivemq.com:8884/mqtt'
].map(url => 'wss://' + url);
