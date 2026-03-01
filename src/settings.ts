import { App, PluginSettingTab, Setting, Notice, Platform } from 'obsidian';
import P2PSyncPlugin from './main';
import { logger } from './services/logger.service';
import { QRCodeModal, QRScannerModal, ManualConnectModal } from './ui/qr-modals';

export interface P2PSettings {
    deviceName: string;
    secretKey: string;
    discoveryServer: string;
    mqttUsername: string;
    mqttPassword: string;
    iceServersJSON: string;
    enableLocalSync: boolean;
    localSyncPort: number;
    discoveredLocalAddress: string | null;
    enableDebugLogs: boolean;
    debugLevel: 'info' | 'debug' | 'trace'; // Added logging level
    enableMqttDiscovery: boolean;
    userColor: string;
}

export const DEFAULT_SETTINGS: P2PSettings = {
    deviceName: 'Obsidian-Device-' + Math.floor(Math.random() * 1000),
    secretKey: 'my-secret-key',
    discoveryServer: 'wss://test.mosquitto.org:8081/mqtt',
    mqttUsername: '',
    mqttPassword: '',
    iceServersJSON: '[{"urls":"stun:stun.l.google.com:19302"}]',
    enableLocalSync: false,
    localSyncPort: 8080,
    discoveredLocalAddress: null,
    enableDebugLogs: false,
    debugLevel: 'info', // Default level
    enableMqttDiscovery: false,
    userColor: '#' + Math.floor(Math.random() * 16777215).toString(16).padStart(6, '0')
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
        logger.debug('[[Connected Client Rendering] Peers:', JSON.stringify(peers));
        if (peers.length === 0) {
            container.createEl('p', { text: 'No peers connected.' });
        } else {
            const localPeers = peers.filter(p => p.source === 'local' || p.source === 'both');
            const internetPeers = peers.filter(p => p.source === 'internet' || p.source === 'both');
            const unknownPeers = peers.filter(p => p.source === 'unknown');

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

            if (unknownPeers.length > 0) {
                container.createEl('h4', { text: '❓ Unknown' });
                const ul = container.createEl('ul');
                unknownPeers.forEach(p => {
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
                    if (this.plugin.yjsService) {
                        this.plugin.yjsService.awareness.setLocalStateField('name', value);
                    }
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

        new Setting(containerEl)
            .setName('User Color')
            .setDesc('Color used for your live cursor')
            .addColorPicker(color => color
                .setValue(this.plugin.settings.userColor)
                .onChange(async (value) => {
                    this.plugin.settings.userColor = value;
                    await this.plugin.saveSettingsDebounced();
                    if (this.plugin.yjsService) {
                        this.plugin.yjsService.awareness.setLocalStateField('color', value);
                    }
                }));

        // ─── Local Network ───────────────────────────────────────
        containerEl.createEl('h3', { text: 'Local Network' });
        // ─── Local Network ───────────────────────────────────────
        containerEl.createEl('h3', { text: 'Local Network' });

        new Setting(containerEl)
            .setName('Enable Local Network Sync')
            .setDesc('Automatically discover and sync with devices on the same Wi-Fi network')
            .addToggle(toggle => toggle
                .setValue(this.plugin.settings.enableLocalSync)
                .onChange(async (value) => {
                    this.plugin.settings.enableLocalSync = value;
                    await this.plugin.saveSettingsDebounced();
                    this.plugin.reloadLocalStrategy();
                    this.display();
                }));

        if (this.plugin.settings.enableLocalSync) {
            new Setting(containerEl)
                .setName('Sync Port')
                .setDesc('Port to use for local network connections')
                .addText(text => text
                    .setPlaceholder('8080')
                    .setValue(String(this.plugin.settings.localSyncPort))
                    .onChange(async (value) => {
                        this.plugin.settings.localSyncPort = Number(value) || 8080;
                        await this.plugin.saveSettingsDebounced();
                        this.plugin.reloadLocalStrategy();
                    }));

            if (!Platform.isMobile) {
                new Setting(containerEl)
                    .setName('Show Connection QR Code')
                    .setDesc('Display a QR code for mobile devices to quickly connect to this desktop')
                    .addButton(button => button
                        .setButtonText('Show QR')
                        .onClick(() => {
                            new QRCodeModal(this.app, this.plugin).open();
                        }));
            } else {
                new Setting(containerEl)
                    .setName('Scan Connection QR Code')
                    .setDesc('Scan a desktop QR code to instantly connect')
                    .addButton(button => button
                        .setButtonText('Scan QR')
                        .setCta()
                        .onClick(() => {
                            new QRScannerModal(this.app, this.plugin).open();
                        }));
            }

            new Setting(containerEl)
                .setName('Connect Manually')
                .setDesc('Manually connect to a host using an IP and Port')
                .addButton(button => button
                    .setButtonText('Enter IP')
                    .onClick(() => {
                        new ManualConnectModal(this.app, this.plugin).open();
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
                    // this.plugin.disconnect(); // Don't disconnect everyone!
                    if (value) {
                        await this.plugin.reloadMqttStrategy();
                    } else {
                        this.plugin.yjsService.providerManager.disconnectStrategy('mqtt');
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
                        this.plugin.reloadMqttStrategy();
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
                        this.plugin.reloadMqttStrategy();
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
                            this.plugin.reloadMqttStrategy();
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
                        await this.plugin.reloadMqttStrategy();
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
                    this.display(); // Re-render to show/hide level
                }));

        if (this.plugin.settings.enableDebugLogs) {
            new Setting(containerEl)
                .setName('Debug Level')
                .setDesc('Control the verbosity of debug logs')
                .addDropdown(dropdown => dropdown
                    .addOption('info', 'Info (Basic)')
                    .addOption('debug', 'Debug (Detailed)')
                    .addOption('trace', 'Trace (Verbose)')
                    .setValue(this.plugin.settings.debugLevel)
                    .onChange(async (value: 'info' | 'debug' | 'trace') => {
                        this.plugin.settings.debugLevel = value;
                        await this.plugin.saveSettingsDebounced();
                    }));
        }

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