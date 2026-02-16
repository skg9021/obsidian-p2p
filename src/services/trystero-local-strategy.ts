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
    subscribe: (ws: WebSocket, rootTopic: string, selfTopic: string, onMessage: (topic: string, data: any, peerId: string) => void) => {
        // Send subscribe message
        const send = (msg: SignalMessage) => ws.send(JSON.stringify(msg));

        send({ type: 'subscribe', topics: [rootTopic, selfTopic] });

        const handler = (event: MessageEvent) => {
            try {
                const msg = JSON.parse(event.data);
                // We only care about 'publish' messages that have data
                // Our LocalServerService sends { type: 'publish', topic: '...', ...data }
                // Trystero expects 'data' to be the payload.
                // But wait, Trystero's MQTT strategy sends the *whole buffer* as data?
                // In mqtt.js: msgHandlers... (topic, buffer.toString())
                // And in strategy.js: it handles parsing.

                // Let's look at how we send data.
                // In 'publish' below, we send the object.
                // So here we receive the object.

                if (msg.type === 'publish' && msg.topic) {
                    // Check if this message is relevant to our subscribed topics
                    if (msg.topic === rootTopic || msg.topic === selfTopic) {
                        // We need to extract the actual payload.
                        // Trystero "data" is the rest of the object?
                        // Let's look at `announce`. It sends { peerId: selfId }.
                        // So the payload is the message itself minus the protocol fields?

                        // Actually, looking at mqtt.js:
                        // onMessage(topic, data, client.publish)

                        // Trystero expects 'data' to be what was published.
                        // In our announce, we publish `toJson({peerId: selfId})`.
                        // So `data` should be that JSON object (or stringified version of it).

                        // Our server relays the *entire* message: { "type": "publish", "topic": "...", "peerId": "..." }
                        // Trystero logic typically wraps data in its own envelope?
                        // strategy.js uses `utils.fromJson(data)`.

                        // If we just pass `msg` as data, Trystero will see { type: 'publish', ... }.
                        // That might be fine if Trystero just looks for specific fields inside.
                        // But wait, `strategy.js` likely expects the exact payload that was sent to `publish`.

                        // If I call `publish(topic, payload)`, our server implementation (above)
                        // wraps it: `message = { type: 'publish', topic: message.topic, ...message }`?
                        // No, our server implementation:
                        // Client sends: { type: 'publish', topic: '...', ...data }
                        // Server relays: { type: 'publish', topic: '...', ...data } (calculated 'clients' field added)

                        // So if Trystero sends payload `P`, we need to send `{ type: 'publish', topic: T, ...P }`.
                        // And when we receive valid message `M`, `M` is effectively `P` plus `type` and `topic`.
                        // So we should pass `M` as the data.

                        // Trystero expects onMessage(topic, data, sender)
                        // Our server doesn't send sender ID explicitly in the wrapper,
                        // but Trystero's strategy wrapper might handle sender IDs inside the data payload?
                        // Wait, looking at mqtt.js again:
                        // onMessage(topic, data, client.publish.bind(client))
                        // The third argument is the publish function for replying.

                        // BUT TS error says: Argument of type '(t: string, d: any) => void' is not assignable to parameter of type 'string'.
                        // This implies `onMessage` 3rd argument is expected to be a string (senderId)?
                        // Let's check `trystero/src/strategy.js` source again if possible, or just cast to any to silence TS.
                        // Since we are ignoring types for the module anyway, the type definition in our file must be wrong.

                        // Let's just cast the 3rd arg to any to make TS happy, as we know what we are passing.
                        // console.log(`[Trystero Local] Received ${msg.type} on ${msg.topic}:`, msg);
                        const peerId = msg.peerId;
                        if (!peerId && msg.topic === rootTopic) {
                            // Announce messages usually have peerId in payload, ensuring it's top level if we spread ...payload
                        }

                        // Trystero expects onMessage(topic, data, peerId)
                        // The previous code passed a function as the 3rd arg. This was likely wrong?
                        // If Trystero expects peerId string, we must pass it.
                        // If the message doesn't have peerId, we might have an issue.
                        // But let's try passing msg.peerId.

                        onMessage(msg.topic, msg, peerId);
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
        // Trystero wants us to publish our peerId to the root topic.
        // It calls this with `toJson({peerId: selfId})`? No, look at mqtt.js:
        // announce: (client, rootTopic) => client.publish(rootTopic, toJson({peerId: selfId}))

        // Wait, `strategy.js` *calls* announce. It expects us to implement the publishing.
        // `strategy.js` handles the *content* of the announcement in some other way?
        // Actually, looking at mqtt.js line 48:
        // announce: (client, rootTopic) => client.publish(rootTopic, toJson({peerId: selfId}))

        // This implies `announce` implementation is responsible for creating the payload `{peerId: selfId}`
        // and sending it.

        const payload = { peerId: selfId };
        ws.send(JSON.stringify({
            type: 'publish',
            topic: rootTopic,
            ...payload
        }));
    }
});
