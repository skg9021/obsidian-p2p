import { P2PSettings } from '../settings';
// @ts-ignore
import strategy from 'trystero/src/strategy.js';
// @ts-ignore
import { selfId } from 'trystero/src/utils.js';

export { selfId };

// Define the shape of our signaling messages
interface SignalMessage {
    type: 'subscribe' | 'unsubscribe' | 'publish' | 'ping' | 'pong';
    topics?: string[];
    topic?: string;
    [key: string]: any;
}

export const joinRoom = strategy({
    // 1. Initialize connection to the signaling server
    init: (config: { appId: string, settings: P2PSettings }) => {
        return new Promise((resolve, reject) => {
            const { settings } = config;
            // Determine signaling URL. If we are the host, we connect to localhost.
            // If we are a client, we connect to the configured server IP.
            // Actually, the settings should provide the full URL or IP/Port.
            // For now, let's assume we pass the full websocket URL in config or derive it.

            // In the context of the plugin, we probably want to determine the URL dynamically.
            // But 'init' is called when we creaate the Trystero room.
            // We can pass the URL in the 'appId' or a custom config field.
            // Let's expect 'clientUrl' in config.

            const url = (config as any).clientUrl || `ws://localhost:${settings.localServerPort}`;
            console.log(`[Trystero Local] Connecting to ${url}`);

            const ws = new WebSocket(url);

            // Handle connection
            ws.addEventListener('open', () => {
                console.log('[Trystero Local] WebSocket connected');
                resolve(ws);
            });

            ws.addEventListener('error', (err) => {
                console.error('[Trystero Local] WebSocket error', err);
                // If we haven't resolved yet, reject? 
                // Trystero strategies usually retry or handle this internally?
                // For now, simple log.
            });
        });
    },

    // 2. Subscribe to topics (root room topic and our own topic)
    subscribe: (ws: WebSocket, rootTopic: string, selfTopic: string, onMessage: (topic: string, data: any, peerId: string | ((t: string, d: any) => void)) => void) => {
        // Send subscribe message
        const send = (msg: SignalMessage) => ws.send(JSON.stringify(msg));

        send({ type: 'subscribe', topics: [rootTopic, selfTopic] });

        const handler = (event: MessageEvent) => {
            try {
                const msg = JSON.parse(event.data);

                if (msg.type === 'publish' && msg.topic) {
                    // Check if this message is relevant to our subscribed topics
                    if (msg.topic === rootTopic || msg.topic === selfTopic) {
                        // Trystero expects onMessage(topic, data, sender)
                        // where 'data' is the application payload (wrapped in msg.data)
                        // and 'sender' is a function to reply to the sender (or the senderId in some contexts, but mostly reply func)
                        // We use the 'data' property to avoid collision with our 'type'='publish'.

                        if (msg.data) {
                            onMessage(msg.topic, msg.data, ((t: string, d: any) => {
                                send({ type: 'publish', topic: t, data: d });
                            }) as any);
                        }
                    }
                }
            } catch (e) {
                console.error('[Trystero Local] Failed to parse message', e);
            }
        };

        ws.addEventListener('message', handler);

        // Return unsubscribe function
        return () => {
            send({ type: 'unsubscribe', topics: [rootTopic, selfTopic] });
            ws.removeEventListener('message', handler);
        };
    },

    // 3. Announce presence
    announce: (ws: WebSocket, rootTopic: string) => {
        const payload = { peerId: selfId };
        ws.send(JSON.stringify({
            type: 'publish',
            topic: rootTopic,
            data: payload
        }));
    },

    // 4. Publish message (Signaling) - WAS MISSING
    publish: (ws: WebSocket, topic: string, data: any) => {
        ws.send(JSON.stringify({
            type: 'publish',
            topic: topic,
            data: data
        }));
    },

    // 5. Leave room
    leave: (ws: WebSocket) => {
        if (ws.readyState === WebSocket.OPEN) {
            ws.close();
        }
    }
});
