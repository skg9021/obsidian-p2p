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
                    console.log('[Trystero Local] Manual close initiated via proxy.');
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
                            console.log(`[Trystero Local] Restoring ${activeSubscriptions.size} subscriptions:`, Array.from(activeSubscriptions));
                            const topics = Array.from(activeSubscriptions);
                            internalWs?.send(JSON.stringify({ type: 'subscribe', topics }));
                        } else {
                            console.log('[Trystero Local] No active subscriptions to restore on open');
                        }

                        // 2. Flush queue
                        console.log(`[Trystero Local] Flushing ${messageQueue.length} queued messages`);
                        while (messageQueue.length > 0) {
                            const data = messageQueue.shift();
                            internalWs?.send(typeof data === 'string' ? data : JSON.stringify(data));
                        }

                        // Notify listeners
                        (listeners['open'] || []).forEach(l => l({}));
                    });

                    internalWs.addEventListener('message', (event) => {
                        try {
                            const parsed = JSON.parse(event.data);
                            console.log(`[Trystero Local] WS message received: type=${parsed.type}, topic=${parsed.topic || 'N/A'}, sender=${parsed.sender || 'N/A'}`);
                        } catch { /* non-JSON */ }
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

        console.log(`[Trystero Local] subscribe() called — rootTopic=${rootTopic}, selfTopic=${selfTopic}`);
        send({ type: 'subscribe', topics: [rootTopic, selfTopic] });

        const handler = (event: MessageEvent) => {
            try {
                const msg = JSON.parse(event.data);

                if (msg.type === 'publish' && msg.topic) {
                    // Check if this message is relevant to our subscribed topics
                    const isRelevant = msg.topic === rootTopic || msg.topic === selfTopic;
                    console.log(`[Trystero Local] Publish msg: topic=${msg.topic}, isRelevant=${isRelevant}, hasData=${!!msg.data}, sender=${msg.sender || 'N/A'}`);

                    if (isRelevant) {
                        if (msg.data) {
                            const signalPeer = (targetTopic: string, payload: any) => {
                                console.log(`[Trystero Local] signalPeer() → topic=${targetTopic}`);
                                if (ws.readyState === 1) {
                                    ws.send(JSON.stringify({
                                        type: 'publish',
                                        topic: targetTopic,
                                        sender: selfId,
                                        data: payload
                                    }));
                                }
                            };

                            console.log(`[Trystero Local] Calling onMessage (Trystero handleMessage) with data:`, JSON.stringify(msg.data));
                            const hangTimer = setTimeout(() => {
                                console.warn(`[Trystero Local] ⚠️ onMessage (handleMessage) has been running >10s — likely stuck on WebRTC offer generation (ICE gathering). Check RTCPeerConnection / STUN server access.`);
                            }, 10000);

                            // onMessage is async in Trystero (handleMessage returns a promise)
                            Promise.resolve(onMessage(msg.topic, msg.data, signalPeer)).then(() => {
                                clearTimeout(hangTimer);
                                console.log(`[Trystero Local] onMessage completed`);
                            }).catch((err) => {
                                clearTimeout(hangTimer);
                                console.error(`[Trystero Local] onMessage error:`, err);
                            });
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
            console.log(`[Trystero Local] Unsubscribing from topics: ${rootTopic}, ${selfTopic}`);
            send({ type: 'unsubscribe', topics: [rootTopic, selfTopic] });
            ws.removeEventListener('message', handler);
            if (typeof ws.close === 'function') {
                console.log(`[Trystero Local] Forcing WebSocket close on unsubscribe.`);
                ws.close();
            }
        };
    },

    // 3. Announce presence
    announce: (ws: WebSocket, rootTopic: string) => {
        console.log(`[Trystero Local] announce() → rootTopic=${rootTopic}, selfId=${selfId}`);
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
