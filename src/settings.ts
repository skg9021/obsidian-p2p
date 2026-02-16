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
    private peerListContainer: HTMLElement | null = null;

    constructor(app: App, plugin: P2PSyncPlugin) {
        super(app, plugin);
        this.plugin = plugin;
    }

    /** Update only the Connected Peers section without rebuilding the entire settings page */
    updatePeerList() {
        if (this.peerListContainer) {
            this.renderPeerList(this.peerListContainer);
        }
    }

    private renderPeerList(container: HTMLElement) {
        container.empty();
        const peers = this.plugin.connectedClients;
        console.log('[[Connected Client Rendering] Peers:', JSON.stringify(peers));
        if (peers.length === 0) {
            container.createEl('p', { text: 'No peers connected.' });
        } else {
            const localPeers = peers.filter(p => p.source === 'local' || p.source === 'both');
            const internetPeers = peers.filter(p => p.source === 'internet' || p.source === 'both');

            if (localPeers.length > 0) {
                container.createEl('h4', { text: '🏠 Local Network' });
                const ul = container.createEl('ul');
                localPeers.forEach(p => {
                    ul.createEl('li', { text: p.ip ? `${p.name} — ${p.ip}` : p.name });
                });
            }

            if (internetPeers.length > 0) {
                container.createEl('h4', { text: '🌐 Internet (MQTT)' });
                const ul = container.createEl('ul');
                internetPeers.forEach(p => {
                    ul.createEl('li', { text: p.ip ? `${p.name} — ${p.ip}` : p.name });
                });
            }
        }
    }

    display(): void {
        const { containerEl } = this;
        containerEl.empty();

        // ─── General ─────────────────────────────────────────────
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
            .setDesc('Shared secret for encryption and discovery (must be same on all devices)')
            .addText(text => text
                .setPlaceholder('Enter secret key')
                .setValue(this.plugin.settings.secretKey)
                .onChange(async (value) => {
                    this.plugin.settings.secretKey = value;
                    await this.plugin.saveSettingsDebounced();
                }));

        // ─── Local Network ───────────────────────────────────────
        containerEl.createEl('h3', { text: 'Local Network' });

        // Host Mode
        new Setting(containerEl)
            .setName('Enable Host Mode')
            .setDesc('Start a local WebSocket server for other devices on your LAN')
            .addToggle(toggle => toggle
                .setValue(this.plugin.settings.enableLocalServer)
                .onChange(async (value) => {
                    this.plugin.settings.enableLocalServer = value;
                    await this.plugin.saveSettingsDebounced();
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

            this.plugin.getLocalIPs().then(ips => {
                const ipText = ips.length > 0 ? ips.join(', ') : 'Unknown (Check Console)';
                ipSetting.setDesc(`Use this IP to connect other devices: ${ipText}`);
            });

            new Setting(containerEl)
                .setName('Restart Server')
                .setDesc('Stop and restart the local WebSocket server')
                .addButton(button => button
                    .setButtonText('Restart')
                    .onClick(() => {
                        this.plugin.restartLocalServer();
                        new Notice('Local Server Restarted');
                    }));
        }

        // Client Mode
        new Setting(containerEl)
            .setName('Enable Local Client')
            .setDesc('Connect to a host on the local network for P2P sync')
            .addToggle(toggle => toggle
                .setValue(this.plugin.settings.enableLocalClient)
                .onChange(async (value) => {
                    this.plugin.settings.enableLocalClient = value;
                    await this.plugin.saveSettings(); // Save immediately
                    await this.plugin.connect(); // Connect immediately
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

        // ─── Internet (MQTT) ─────────────────────────────────────
        containerEl.createEl('h3', { text: 'Internet (MQTT)' });

        new Setting(containerEl)
            .setName('Enable MQTT Discovery')
            .setDesc('Connect to an MQTT broker for peer discovery over the internet')
            .addToggle(toggle => toggle
                .setValue(this.plugin.settings.enableMqttDiscovery)
                .onChange(async (value) => {
                    this.plugin.settings.enableMqttDiscovery = value;
                    await this.plugin.saveSettings();
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
                        await this.plugin.saveSettingsDebounced();
                    }));

            new Setting(containerEl)
                .setName('MQTT Username')
                .setDesc('Optional — leave empty for public brokers')
                .addText(text => text
                    .setPlaceholder('username')
                    .setValue(this.plugin.settings.mqttUsername)
                    .onChange(async (value) => {
                        this.plugin.settings.mqttUsername = value;
                        await this.plugin.saveSettingsDebounced();
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
                            await this.plugin.saveSettingsDebounced();
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
                        await this.plugin.connect();
                        button.setButtonText('Connect');
                        button.setDisabled(false);
                    }));
        }

        new Setting(containerEl)
            .setName('ICE Servers (JSON)')
            .setDesc('STUN/TURN servers for WebRTC NAT traversal')
            .addTextArea(text => text
                .setPlaceholder('[{"urls":"stun:stun.l.google.com:19302"}]')
                .setValue(this.plugin.settings.iceServersJSON)
                .onChange(async (value) => {
                    this.plugin.settings.iceServersJSON = value;
                    await this.plugin.saveSettingsDebounced();
                }));

        // ─── Connected Peers ─────────────────────────────────────
        containerEl.createEl('h3', { text: 'Connected Peers' });
        this.peerListContainer = containerEl.createEl('div', { cls: 'connected-clients-list' });
        this.renderPeerList(this.peerListContainer);

        // ─── Debug & Advanced ────────────────────────────────────
        containerEl.createEl('h3', { text: 'Debug & Advanced' });

        // Client ID (Yjs awareness ID) — read-only
        const clientId = this.plugin.yjsService?.ydoc?.clientID;
        new Setting(containerEl)
            .setName('Client ID')
            .setDesc('Yjs awareness client ID (unique per session)')
            .addText(text => {
                text.setValue(clientId != null ? String(clientId) : 'N/A')
                    .setDisabled(true);
                text.inputEl.style.opacity = '0.7';
            });

        // Peer ID (WebRTC signaling ID) — read-only
        let peerId = 'N/A';
        try {
            // selfId is only available when the mqtt-patched module is loaded
            const { selfId } = require('trystero/mqtt');
            if (selfId) peerId = selfId;
        } catch { /* N/A */ }
        new Setting(containerEl)
            .setName('Peer ID')
            .setDesc('WebRTC signaling peer ID (used for P2P discovery)')
            .addText(text => {
                text.setValue(peerId)
                    .setDisabled(true);
                text.inputEl.style.opacity = '0.7';
            });

        new Setting(containerEl)
            .setName('Enable Debug Logs')
            .setDesc('Log verbose status messages to the developer console')
            .addToggle(toggle => toggle
                .setValue(this.plugin.settings.enableDebugLogs)
                .onChange(async (value) => {
                    this.plugin.settings.enableDebugLogs = value;
                    await this.plugin.saveSettingsDebounced();
                }));

        new Setting(containerEl)
            .setName('Reconnect All')
            .setDesc('Disconnect and reconnect all P2P connections')
            .addButton(button => button
                .setButtonText('Reconnect')
                .onClick(() => {
                    this.plugin.connect();
                    new Notice('Reconnecting...');
                }));
    }
}