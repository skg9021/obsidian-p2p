import { App, PluginSettingTab, Setting, Notice } from 'obsidian';
import P2PSyncPlugin from './main';

export interface P2PSettings {
    deviceName: string;
    secretKey: string;
    discoveryServer: string;
    mqttUsername: string;
    mqttPassword: string;
    iceServersJSON: string;
    enableLocalServer: boolean;
    localServerPort: number;
    enableLocalClient: boolean;
    localServerAddress: string;
    enableDebugLogs: boolean;
    enableMqttDiscovery: boolean;
}

export const DEFAULT_SETTINGS: P2PSettings = {
    deviceName: 'Obsidian-Device-' + Math.floor(Math.random() * 1000),
    secretKey: 'my-secret-key',
    discoveryServer: 'wss://test.mosquitto.org:8081/mqtt',
    mqttUsername: '',
    mqttPassword: '',
    iceServersJSON: '[{"urls":"stun:stun.l.google.com:19302"}]',
    enableLocalServer: false,
    localServerPort: 8080,
    enableLocalClient: false,
    localServerAddress: 'ws://localhost:8080',
    enableDebugLogs: false,
    enableMqttDiscovery: false
}

export class P2PSyncSettingTab extends PluginSettingTab {
    plugin: P2PSyncPlugin;

    constructor(app: App, plugin: P2PSyncPlugin) {
        super(app, plugin);
        this.plugin = plugin;
    }

    display(): void {
        const { containerEl } = this;
        containerEl.empty();

        containerEl.createEl('h2', { text: 'P2P Sync Settings' });

        new Setting(containerEl)
            .setName('Device Name')
            .setDesc('Unique name for this device in the P2P network')
            .addText(text => text
                .setPlaceholder('Enter device name')
                .setValue(this.plugin.settings.deviceName)
                .onChange(async (value) => {
                    this.plugin.settings.deviceName = value;
                    await this.plugin.saveSettingsDebounced();
                }));

        new Setting(containerEl)
            .setName('Secret Key')
            .setDesc('Shared secret for encryption and discovery (Must be same on all devices)')
            .addText(text => text
                .setPlaceholder('Enter secret key')
                .setValue(this.plugin.settings.secretKey)
                .onChange(async (value) => {
                    this.plugin.settings.secretKey = value;
                    await this.plugin.saveSettingsDebounced();
                }));

        containerEl.createEl('h3', { text: 'Discovery & Signaling' });

        new Setting(containerEl)
            .setName('Enable MQTT Discovery')
            .setDesc('Connect to an MQTT broker for peer discovery over the internet')
            .addToggle(toggle => toggle
                .setValue(this.plugin.settings.enableMqttDiscovery)
                .onChange(async (value) => {
                    this.plugin.settings.enableMqttDiscovery = value;
                    await this.plugin.saveSettings();
                    // Reconnect immediately when toggling the master switch
                    this.plugin.disconnect();
                    if (value) {
                        await this.plugin.connect();
                    }
                    this.display();
                }));

        if (this.plugin.settings.enableMqttDiscovery) {
            new Setting(containerEl)
                .setName('MQTT Broker URL')
                .setDesc('WebSocket URL for MQTT broker (must end with /mqtt)')
                .addText(text => text
                    .setPlaceholder('wss://test.mosquitto.org:8081/mqtt')
                    .setValue(this.plugin.settings.discoveryServer)
                    .onChange(async (value) => {
                        this.plugin.settings.discoveryServer = value;
                        await this.plugin.saveSettings();
                    }));

            new Setting(containerEl)
                .setName('MQTT Username')
                .setDesc('Optional — leave empty for public brokers')
                .addText(text => text
                    .setPlaceholder('username')
                    .setValue(this.plugin.settings.mqttUsername)
                    .onChange(async (value) => {
                        this.plugin.settings.mqttUsername = value;
                        await this.plugin.saveSettings();
                    }));

            new Setting(containerEl)
                .setName('MQTT Password')
                .setDesc('Optional — leave empty for public brokers')
                .addText(text => {
                    text.inputEl.type = 'password';
                    text.setPlaceholder('password')
                        .setValue(this.plugin.settings.mqttPassword)
                        .onChange(async (value) => {
                            this.plugin.settings.mqttPassword = value;
                            await this.plugin.saveSettings();
                        });
                });

            new Setting(containerEl)
                .setName('Connect to Broker')
                .setDesc('Apply the above settings and connect to the MQTT broker')
                .addButton(button => button
                    .setButtonText('Connect')
                    .setCta()
                    .onClick(async () => {
                        button.setButtonText('Connecting...');
                        button.setDisabled(true);
                        this.plugin.disconnect();
                        await this.plugin.connect();
                        button.setButtonText('Connect');
                        button.setDisabled(false);
                    }));
        }

        new Setting(containerEl)
            .setName('ICE Servers (JSON)')
            .setDesc('STUN/TURN servers for WebRTC')
            .addTextArea(text => text
                .setPlaceholder('[{"urls":"stun:stun.l.google.com:19302"}]')
                .setValue(this.plugin.settings.iceServersJSON)
                .onChange(async (value) => {
                    this.plugin.settings.iceServersJSON = value;
                    await this.plugin.saveSettingsDebounced();
                }));

        containerEl.createEl('h3', { text: 'Local Network (Host Mode)' });

        new Setting(containerEl)
            .setName('Enable Host Mode (Server)')
            .setDesc('Start a local WebSocket server for other devices on the LAN')
            .addToggle(toggle => toggle
                .setValue(this.plugin.settings.enableLocalServer)
                .onChange(async (value) => {
                    this.plugin.settings.enableLocalServer = value;
                    await this.plugin.saveSettingsDebounced();
                    // Force refresh to show/hide IP
                    this.display();
                }));

        if (this.plugin.settings.enableLocalServer) {
            new Setting(containerEl)
                .setName('Server Name')
                .setDesc('This is the name clients will see when they connect')
                .addText(text => text
                    .setValue(this.plugin.settings.deviceName)
                    .setDisabled(true));

            new Setting(containerEl)
                .setName('Host Port')
                .setDesc('Port for the local server')
                .addText(text => text
                    .setPlaceholder('8080')
                    .setValue(String(this.plugin.settings.localServerPort))
                    .onChange(async (value) => {
                        this.plugin.settings.localServerPort = Number(value);
                        await this.plugin.saveSettingsDebounced();
                    }));

            const ipSetting = new Setting(containerEl)
                .setName('Server IP Addresses')
                .setDesc('Fetching...');

            // Assuming getLocalIPs is available on plugin via service or helper
            // We kept the helper in main.ts
            this.plugin.getLocalIPs().then(ips => {
                const ipText = ips.length > 0 ? ips.join(', ') : 'Unknown (Check Console)';
                ipSetting.setDesc(`Use this IP to connect other devices: ${ipText}`);
            });
        }

        // Connected Peers List (visible to both host and client via awareness)
        containerEl.createEl('h3', { text: 'Connected Peers' });
        const clientsDiv = containerEl.createEl('div', { cls: 'connected-clients-list' });
        if (this.plugin.connectedClients.length === 0) {
            clientsDiv.createEl('p', { text: 'No peers connected.' });
        } else {
            const ul = clientsDiv.createEl('ul');
            this.plugin.connectedClients.forEach(client => {
                ul.createEl('li', { text: client });
            });
        }

        containerEl.createEl('h3', { text: 'Local Client (Connect to Host)' });

        new Setting(containerEl)
            .setName('Enable Local Client')
            .setDesc('Connect to a host on the local network for P2P sync')
            .addToggle(toggle => toggle
                .setValue(this.plugin.settings.enableLocalClient)
                .onChange(async (value) => {
                    this.plugin.settings.enableLocalClient = value;
                    await this.plugin.saveSettingsDebounced();
                    this.display();
                }));

        if (this.plugin.settings.enableLocalClient) {
            new Setting(containerEl)
                .setName('Host Address')
                .setDesc('WebSocket address of the host (e.g., ws://192.168.1.5:8080)')
                .addText(text => text
                    .setPlaceholder('ws://localhost:8080')
                    .setValue(this.plugin.settings.localServerAddress)
                    .onChange(async (value) => {
                        this.plugin.settings.localServerAddress = value;
                        await this.plugin.saveSettingsDebounced();
                    }));
        }

        containerEl.createEl('h3', { text: 'Debug & Advanced' });

        new Setting(containerEl)
            .setName('Enable Debug Logs')
            .setDesc('Log verbose status messages to the developer console')
            .addToggle(toggle => toggle
                .setValue(this.plugin.settings.enableDebugLogs)
                .onChange(async (value) => {
                    this.plugin.settings.enableDebugLogs = value;
                    await this.plugin.saveSettingsDebounced();
                }));

        if (this.plugin.settings.enableLocalServer) {
            new Setting(containerEl)
                .setName('Manage Local Server')
                .setDesc('Control the local WebSocket server')
                .addButton(button => button
                    .setButtonText('Restart Server')
                    .setCta()
                    .onClick(() => {
                        this.plugin.restartLocalServer();
                        new Notice('Local Server Restarted');
                    }));
        }

        new Setting(containerEl)
            .setName('Troubleshooting')
            .setDesc('Manually attempt to find and connect to servers/peers')
            .addButton(button => button
                .setButtonText('Find Server / Reconnect')
                .onClick(() => {
                    this.plugin.connect();
                    new Notice('Reconnecting...');
                }));
    }
}