/**
 * Patched version of trystero/src/mqtt.js
 *
 * Changes from original:
 * - Passes config.mqttUsername/mqttPassword directly to mqtt.connect() options
 *   instead of relying on URL credential parsing (which can fail in Electron)
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
                .on('message', (topic, buffer) =>
                    msgHandlers[clientId][topic]?.(topic, buffer.toString())
                )
                .on('error', err => console.error('[P2P mqtt-patched] MQTT error:', err))

            return new Promise(res => client.on('connect', () => res(client)))
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

        return () => {
            client.unsubscribe(rootTopic)
            client.unsubscribe(selfTopic)
            delete msgHandlers[clientId][rootTopic]
            delete msgHandlers[clientId][selfTopic]
        }
    },

    announce: (client, rootTopic) =>
        client.publish(rootTopic, toJson({ peerId: selfId }))
})

export const getRelaySockets = () => ({ ...sockets })

export { selfId } from 'trystero/src/utils.js'

export const defaultRelayUrls = [
    'test.mosquitto.org:8081/mqtt',
    'broker.emqx.io:8084/mqtt',
    'broker.hivemq.com:8884/mqtt'
].map(url => 'wss://' + url)
