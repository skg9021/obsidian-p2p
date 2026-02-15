/**
 * Patched version of trystero/src/mqtt.js
 *
 * Changes from original:
 * - Passes config.mqttUsername/mqttPassword directly to mqtt.connect() options
 *   instead of relying on URL credential parsing (which can fail in Electron)
 * - Properly closes MQTT clients on room leave (subscribe cleanup)
 * - Adaptive announce interval (fast discovery, then slow maintenance)
 */
import mqtt from 'mqtt'
import strategy from 'trystero/src/strategy.js'
import { getRelays, selfId, toJson } from 'trystero/src/utils.js'

const sockets = {}
const defaultRedundancy = 4
const msgHandlers = {}
const getClientId = ({ options }) => options.host + options.path

export const joinRoom = strategy({
    init: config => {
        console.log('[P2P mqtt-patched] init called, config keys:', Object.keys(config))
        console.log('[P2P mqtt-patched] mqttUsername:', config.mqttUsername ? `"${config.mqttUsername}"` : '(not set)')
        console.log('[P2P mqtt-patched] mqttPassword:', config.mqttPassword ? '(set, length=' + config.mqttPassword.length + ')' : '(not set)')
        console.log('[P2P mqtt-patched] relayUrls:', config.relayUrls)

        return getRelays(config, defaultRelayUrls, defaultRedundancy).map(url => {
            // Pass MQTT credentials directly via options instead of URL embedding
            const connectOpts = {}
            if (config.mqttUsername) {
                connectOpts.username = config.mqttUsername
                connectOpts.password = config.mqttPassword || ''
            }
            console.log('[P2P mqtt-patched] mqtt.connect URL:', url, 'opts:', JSON.stringify(connectOpts))
            const client = mqtt.connect(url, connectOpts)
            const clientId = getClientId(client)

            sockets[clientId] = client.stream.socket
            msgHandlers[clientId] = {}

            client
                .on('message', (topic, buffer) => {
                    console.log('[P2P mqtt-patched] MQTT message:', topic, buffer.toString())
                    msgHandlers[clientId][topic]?.(topic, buffer.toString())
                })
                .on('error', err => {
                    console.error('[P2P mqtt-patched] Some error in MQTT connection')
                    console.error('[P2P mqtt-patched] MQTT error:', err)
                })

            return new Promise(res => client.on('connect', () => {
                console.log('[P2P mqtt-patched] MQTT connected')
                res(client)
            }))
        })
    },

    subscribe: (client, rootTopic, selfTopic, onMessage) => {
        const clientId = getClientId(client)

        msgHandlers[clientId][rootTopic] = msgHandlers[clientId][selfTopic] = (
            topic,
            data
        ) => onMessage(topic, data, client.publish.bind(client))

        client.subscribe(rootTopic)
        client.subscribe(selfTopic)

        // Cleanup: called by strategy.js when leaving room
        // Must close the MQTT client to prevent connection leaks
        return () => {
            console.log('[P2P mqtt-patched] Cleaning up MQTT client:', clientId)
            client.unsubscribe(rootTopic)
            client.unsubscribe(selfTopic)
            delete msgHandlers[clientId]
            delete sockets[clientId]
            client.end(true) // force-close the MQTT connection
            console.log('[P2P mqtt-patched] MQTT client closed:', clientId)
        }
    },

    announce: (() => {
        let announceCount = 0
        // Adaptive interval: fast discovery at first, then slow down to save quota
        // strategy.js uses the return value as the next interval in ms
        const fastIntervalMs = 5_000    // First few announces: 5s (quick peer discovery)
        const slowIntervalMs = 60_000   // After that: 60s (maintenance, saves quota)
        const fastAnnounceCount = 3     // Number of fast announces before slowing down

        return (client, rootTopic) => {
            announceCount++
            client.publish(rootTopic, toJson({ peerId: selfId }))
            const nextInterval = announceCount <= fastAnnounceCount ? fastIntervalMs : slowIntervalMs
            console.log(`[P2P mqtt-patched] announce #${announceCount}, next in ${nextInterval / 1000}s`)
            return nextInterval
        }
    })()
})

export const getRelaySockets = () => ({ ...sockets })

export { selfId } from 'trystero/src/utils.js'

export const defaultRelayUrls = [
    'test.mosquitto.org:8081/mqtt',
    'broker.emqx.io:8084/mqtt',
    'broker.hivemq.com:8884/mqtt'
].map(url => 'wss://' + url)
