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

            const messageQueue: any[] = [];
            const activeSubscriptions = new Set<string>(); // Track active subscriptions

            const socketProxy = {
                url: url,
                readyState: 0 as number, // 0=CONNECTING, 1=OPEN, 2=CLOSING, 3=CLOSED
                send: (data: any) => {
                    const parsed = typeof data === 'string' ? JSON.parse(data) : data;

                    // Track subscriptions from outgoing messages
                    if (parsed && parsed.type === 'subscribe' && Array.isArray(parsed.topics)) {
                        parsed.topics.forEach((t: string) => activeSubscriptions.add(t));
                        // Don't queue subscribe messages, we handle them on 'open' via activeSubscriptions
                        if (internalWs && internalWs.readyState === 1) { // 1=OPEN
                            internalWs.send(typeof data === 'string' ? data : JSON.stringify(data));
                        }
                        return;
                    }
                    if (parsed && parsed.type === 'unsubscribe' && Array.isArray(parsed.topics)) {
                        parsed.topics.forEach((t: string) => activeSubscriptions.delete(t));
                        // Don't queue unsubscribe messages. If we aren't connected, we are already unsubscribed.
                        if (internalWs && internalWs.readyState === 1) { // 1=OPEN
                            internalWs.send(typeof data === 'string' ? data : JSON.stringify(data));
                        }
                        return;
                    }

                    if (internalWs && internalWs.readyState === 1) { // 1=OPEN
                        internalWs.send(typeof data === 'string' ? data : JSON.stringify(data));
                    } else {
                        // Queue only data/signaling messages
                        messageQueue.push(data);
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

                        // 1. Resend active subscriptions (Critical for re-connect)
                        if (activeSubscriptions.size > 0) {
                            console.log(`[Trystero Local] Restoring ${activeSubscriptions.size} subscriptions`);
                            const topics = Array.from(activeSubscriptions);
                            internalWs?.send(JSON.stringify({ type: 'subscribe', topics }));
                        }

                        // 2. Flush queue
                        while (messageQueue.length > 0) {
                            const data = messageQueue.shift();
                            internalWs?.send(typeof data === 'string' ? data : JSON.stringify(data));
                        }

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
                console.log('[Trystero Local] Rx:', msg.type, msg.topic);

                if (msg.type === 'publish' && msg.topic) {
                    // Check if this message is relevant to our subscribed topics
                    if (msg.topic === rootTopic || msg.topic === selfTopic) {
                        console.log('[Trystero Local] Matched topic:', msg.topic);

                        // Trystero expects onMessage(topic, data, sender)
                        // where 'data' is the application payload (wrapped in msg.data)
                        // and 'sender' is a function to reply to the sender (or the senderId in some contexts, but mostly reply func)
                        // We use the 'data' property to avoid collision with our 'type'='publish'.

                        if (msg.data) {
                            try {
                                const decoded = typeof msg.data === 'string' ? JSON.parse(msg.data) : msg.data;
                                const type = decoded.offer ? 'offer' : (decoded.answer ? 'answer' : 'announce');
                                console.log(`[Trystero Local] Dispatching ${type} from ${decoded.peerId} (Self: ${selfId})`);
                            } catch (e) {
                                console.log(`[Trystero Local] Dispatching raw data (length ${msg.data.length})`);
                            }

                            // Trystero expects onMessage(topic, data, signalPeer)
                            // signalPeer is a function (topic, data) => void used to reply/signal back

                            const signalPeer = (targetTopic: string, payload: any) => {
                                if (ws.readyState === 1) {
                                    ws.send(JSON.stringify({
                                        type: 'publish',
                                        topic: targetTopic,
                                        sender: selfId,
                                        data: payload
                                    }));
                                }
                            };

                            onMessage(msg.topic, msg.data, signalPeer);
                        }
                    } else {
                        console.log('[Trystero Local] Ignored topic:', msg.topic, 'listening for:', rootTopic, selfTopic);
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
        // Trystero sends its own announce packet, usually? 
        // No, 'announce' is called by Trystero to say "I am here".
        // We should just broadcast a presence message?
        // Actually, Trystero usually handles the payload logic if we just provide the channel.
        // But here 'announce' is part of the strategy interface. 
        // The default strategy sends a 'multicast' packet?
        // Let's just do a simple publish to rootTopic.

        ws.send(JSON.stringify({
            type: 'publish',
            topic: rootTopic,
            sender: selfId,
            data: { type: 'announce', peerId: selfId }
        }));
    },

    // 4. Publish message (Signaling) - WAS MISSING
    // 4. Publish message (Signaling)
    publish: (ws: WebSocket, topic: string, data: any) => {
        if (ws.readyState === 1) { // 1=OPEN
            ws.send(JSON.stringify({
                type: 'publish',
                topic: topic,
                sender: selfId, // Include our selfId so receiver knows who sent it
                data: data
            }));
        }
    },

    // 5. Leave room
    leave: (ws: WebSocket) => {
        if (ws.readyState === WebSocket.OPEN) {
            ws.close();
        }
    }
});
