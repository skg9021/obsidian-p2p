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
        console.log(`[P2P mqtt-patched] Force-closing ${activeClients.size} active MQTT client(s)`);
        activeClients.forEach(c => {
            try {
                c.end(true, () => {
                    console.log('[P2P mqtt-patched] MQTT closed: ', c);
                });
            } catch { /* ignore */ }
        });
        activeClients.clear();
        // Also clean up module-level maps
        Object.keys(sockets).forEach(k => delete sockets[k]);
        Object.keys(msgHandlers).forEach(k => delete msgHandlers[k]);
    }
};

export const joinRoom = strategy({
    init: (config: MqttConfig): Promise<MqttClient>[] => {
        console.log('[P2P mqtt-patched] init called, config keys:', Object.keys(config));
        console.log('[P2P mqtt-patched] mqttUsername:', config.mqttUsername ? `"${config.mqttUsername}"` : '(not set)');
        console.log('[P2P mqtt-patched] mqttPassword:', config.mqttPassword ? '(set, length=' + config.mqttPassword.length + ')' : '(not set)');
        console.log('[P2P mqtt-patched] relayUrls:', config.relayUrls);

        return getRelays(config, defaultRelayUrls, defaultRedundancy).map((url: string) => {
            // Pass MQTT credentials directly via options instead of URL embedding
            const connectOpts: IClientOptions = {};
            if (config.mqttUsername) {
                connectOpts.username = config.mqttUsername;
                connectOpts.password = config.mqttPassword || '';
                connectOpts.reconnectPeriod = 5000;
                connectOpts.reconnectOnConnackError = false;

            }
            console.log('[P2P mqtt-patched] mqtt.connect URL:', url, 'opts:', JSON.stringify(connectOpts));
            const client = mqtt.connect(url, connectOpts);
            const clientId = getClientId(client);

            activeClients.add(client);
            sockets[clientId] = (client as any).stream?.socket;
            msgHandlers[clientId] = {};

            client
                .on('message', (topic: string, buffer: Buffer) => {
                    console.log('[P2P mqtt-patched] MQTT message:', topic, buffer.toString());
                    msgHandlers[clientId]?.[topic]?.(topic, buffer.toString());
                })
                .on('error', (err: Error) => {
                    // Ignore expected errors during cleanup
                    // if (err.message?.includes('disconnecting')) return;
                    console.error('[P2P mqtt-patched] MQTT error:', err);
                })
                .on('close', () => {
                    console.log('[P2P mqtt-patched] MQTT closed');
                    activeClients.delete(client);
                });

            return new Promise<MqttClient>(res => client.on('connect', () => {
                console.log('[P2P mqtt-patched] MQTT connected to', url);
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
            console.log('[P2P mqtt-patched] Subscribe cleanup for', clientId);
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
            try {
                client.publish(rootTopic, toJson({ peerId: selfId }));
            } catch {
                // Client may have been force-closed by closeAllClients()
                return slowIntervalMs;
            }
            const nextInterval = announceCount <= fastAnnounceCount ? fastIntervalMs : slowIntervalMs;
            console.log(`[P2P mqtt-patched] announce #${announceCount}, next in ${nextInterval / 1000}s`);
            return nextInterval;
        };
    })()
});

export const getRelaySockets = (): Record<string, unknown> => ({ ...sockets });

// @ts-ignore — no types for trystero internals
export { selfId } from 'trystero/src/utils.js';

export const defaultRelayUrls: string[] = [
    'test.mosquitto.org:8081/mqtt',
    'broker.emqx.io:8084/mqtt',
    'broker.hivemq.com:8884/mqtt'
].map(url => 'wss://' + url);
