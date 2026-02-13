import * as mqtt from 'mqtt';
import { P2PSettings } from '../settings';

export class MqttService {
    private client: mqtt.MqttClient | null = null;
    private onSignalCallback: (msg: string) => void = () => { };
    private onConnectCallback: () => void = () => { };

    constructor(
        private settings: P2PSettings,
        private getTopicHash: () => Promise<string>,
    ) { }

    setCallbacks(onSignal: (msg: string) => void, onConnect: () => void) {
        this.onSignalCallback = onSignal;
        this.onConnectCallback = onConnect;
    }

    private log(msg: string, ...args: any[]) {
        if (this.settings.enableDebugLogs) console.log(`[P2P MQTT] ${msg}`, ...args);
    }

    async connect() {
        if (this.client) {
            this.log('Closing existing MQTT client');
            this.client.end();
            this.client = null;
        }

        const topicHash = await this.getTopicHash();
        const announceTopic = `obsidian-p2p/v1/${topicHash}/announce`;
        const signalTopic = `obsidian-p2p/v1/${topicHash}/signal/${this.settings.deviceName}`;

        this.log(`Connecting to MQTT broker: ${this.settings.discoveryServer}`);
        this.log(`Announce topic: ${announceTopic}`);
        this.log(`Signal topic: ${signalTopic}`);

        this.client = mqtt.connect(this.settings.discoveryServer, {
            reconnectPeriod: 5000,
            connectTimeout: 30 * 1000,
        });

        this.client.on('connect', () => {
            this.log('MQTT Connected successfully');
            this.client?.subscribe(announceTopic, (err) => {
                if (err) this.log('Failed to subscribe to announce topic', err);
                else this.log('Subscribed to announce topic');
            });
            this.client?.subscribe(signalTopic, (err) => {
                if (err) this.log('Failed to subscribe to signal topic', err);
                else this.log('Subscribed to signal topic');
            });
            this.onConnectCallback();
        });

        this.client.on('message', (topic, message) => {
            this.log(`Message received on topic: ${topic}, size=${message.length}b`);
            this.onSignalCallback(message.toString());
        });

        this.client.on('error', (err) => {
            this.log('MQTT Error:', err.message);
            console.error('[P2P MQTT] Error:', err);
        });

        this.client.on('reconnect', () => {
            this.log('MQTT Reconnecting...');
        });

        this.client.on('close', () => {
            this.log('MQTT Connection closed');
        });

        this.client.on('disconnect', () => {
            this.log('MQTT Disconnected by broker');
        });

        this.client.on('offline', () => {
            this.log('MQTT Client offline');
        });
    }

    disconnect() {
        this.log('Disconnecting MQTT');
        if (this.client) {
            this.client.end();
            this.client = null;
        }
    }

    get connected(): boolean {
        return this.client?.connected || false;
    }

    publish(topic: string, message: string) {
        if (this.client?.connected) {
            this.log(`Publishing to ${topic}, size=${message.length}b`);
            this.client.publish(topic, message);
        } else {
            this.log('Cannot publish - MQTT not connected');
        }
    }
}
