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

    async connect() {
        if (this.client) {
            this.client.end();
            this.client = null;
        }

        const topicHash = await this.getTopicHash();
        const announceTopic = `obsidian-p2p/v1/${topicHash}/announce`;
        const signalTopic = `obsidian-p2p/v1/${topicHash}/signal/${this.settings.deviceName}`;

        console.log('Connecting to MQTT:', this.settings.discoveryServer);
        this.client = mqtt.connect(this.settings.discoveryServer, {
            reconnectPeriod: 5000,
            connectTimeout: 30 * 1000,
        });

        this.client.on('connect', () => {
            console.log('MQTT Connected');
            this.client?.subscribe(announceTopic);
            this.client?.subscribe(signalTopic);
            this.onConnectCallback();
        });

        this.client.on('message', (topic, message) => {
            this.onSignalCallback(message.toString());
        });

        this.client.on('error', (err) => {
            console.error('MQTT Error:', err);
        });
    }

    disconnect() {
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
            this.client.publish(topic, message);
        }
    }
}
