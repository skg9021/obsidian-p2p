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
            const url = (config as any).clientUrl || `ws://localhost:${settings.localServerPort}`;
            console.log(`[Trystero Local] Connecting to ${url}`);

            // Proxy object to mimic WebSocket but handle reconnection
            const socketProxy = {
                url: url,
                readyState: 0 as number, // 0=CONNECTING, 1=OPEN, 2=CLOSING, 3=CLOSED
                send: (data: any) => {
                    if (internalWs && internalWs.readyState === 1) { // 1=OPEN
                        internalWs.send(data);
                    } else {
                        // Queue or drop? For signaling, dropping might be okay as retries happen at higher level?
                        // actually Trystero might expect reliable transport?
                        // Let's just drop and hope for reconnection + re-announce.
                        // console.warn('[Trystero Local] Send failed: Socket not open');
                    }
                },
                close: () => {
                    manualClose = true;
                    if (internalWs) internalWs.close();
                },
                addEventListener: (type: string, listener: any) => {
                    if (!listeners[type]) listeners[type] = [];
                    listeners[type].push(listener);
                },
                removeEventListener: (type: string, listener: any) => {
                    if (!listeners[type]) return;
                    listeners[type] = listeners[type].filter((l: any) => l !== listener);
                }
            };

            const listeners: { [key: string]: any[] } = {};
            let internalWs: WebSocket | null = null;
            let manualClose = false;
            let reconnectParams = { attempts: 0, delay: 1000, maxDelay: 10000 };

            const connect = () => {
                if (manualClose) return;

                try {
                    internalWs = new WebSocket(url);
                    socketProxy.readyState = 0; // CONNECTING

                    internalWs.addEventListener('open', () => {
                        console.log('[Trystero Local] WebSocket connected');
                        socketProxy.readyState = 1; // OPEN
                        reconnectParams.attempts = 0;
                        reconnectParams.delay = 1000;

                        // Notify listeners
                        (listeners['open'] || []).forEach(l => l({}));
                    });

                    internalWs.addEventListener('message', (event) => {
                        (listeners['message'] || []).forEach(l => l(event));
                    });

                    internalWs.addEventListener('close', () => {
                        if (manualClose) return;
                        socketProxy.readyState = 3; // CLOSED
                        console.log('[Trystero Local] WebSocket closed. Reconnecting...');
                        scheduleReconnect();
                    });

                    internalWs.addEventListener('error', (e) => {
                        console.error('[Trystero Local] WebSocket error', e);
                        // Error usually leads to close
                    });

                } catch (e) {
                    console.error('[Trystero Local] Connection failed', e);
                    scheduleReconnect();
                }
            };

            const scheduleReconnect = () => {
                if (manualClose) return;
                const timeout = Math.min(reconnectParams.delay * Math.pow(1.5, reconnectParams.attempts), reconnectParams.maxDelay);
                console.log(`[Trystero Local] Reconnecting in ${timeout}ms...`);
                setTimeout(() => {
                    reconnectParams.attempts++;
                    connect();
                }, timeout);
            }

            // Initial connect
            connect();

            // Resolve immediately with our proxy? 
            // Trystero waits for resolution before using the socket.
            // We should ideally wait for the first 'open' but to support transparent auto-reconnect,
            // we return the proxy. Trystero attaches listeners to it.
            // When real socket opens, we trigger 'open'.

            // Wait, does Trystero wait for 'open' event? 
            // Looking at source: `socket.addEventListener('open', ...)`
            // So yes, returning proxy immediately is fine.
            resolve(socketProxy);
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
