import { App, PluginSettingTab, Setting, Platform, debounce } from 'obsidian';
import P2PSyncPlugin from './main';

export interface P2PSettings {
    deviceName: string;
    secretKey: string;
    discoveryServer: string; // MQTT Broker URL
    iceServersJSON: string;  // STUN/TURN Config as JSON string

    // Local Network
    enableLocalServer: boolean;
    localServerPort: number;
    localServerAddress: string;
}

const DEFAULT_ICE_SERVERS = [
    { urls: 'stun:stun.l.google.com:19302' },
    { urls: 'stun:global.stun.twilio.com:3478' }
];

export const DEFAULT_SETTINGS: P2PSettings = {
    deviceName: `Vault-${Math.floor(Math.random() * 1000)}`,
    secretKey: 'generate-a-strong-password-here',
    discoveryServer: 'wss://test.mosquitto.org:8081',
    iceServersJSON: JSON.stringify(DEFAULT_ICE_SERVERS, null, 2),
    enableLocalServer: false,
    localServerPort: 8080,
    localServerAddress: ''
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
        containerEl.createEl('h2', { text: 'P2P Sync Configuration' });

        // --- Identity ---
        new Setting(containerEl)
            .setName('Device Name')
            .setDesc('How this device appears to peers.')
            .addText(t => t.setValue(this.plugin.settings.deviceName)
                .onChange(v => { this.plugin.settings.deviceName = v; this.plugin.saveSettingsDebounced(); }));

        new Setting(containerEl)
            .setName('Secret Key')
            .setDesc('Encryption password. Must be IDENTICAL on all devices.')
            .addText(t => t.setValue(this.plugin.settings.secretKey)
                .onChange(v => { this.plugin.settings.secretKey = v; this.plugin.saveSettingsDebounced(); }));

        // --- Signaling (MQTT) ---
        containerEl.createEl('h3', { text: 'Signaling Server (Discovery)' });
        new Setting(containerEl)
            .setName('MQTT Broker URL')
            .setDesc('WebSocket URL for the MQTT broker (e.g., wss://test.mosquitto.org:8081).')
            .addText(t => t.setValue(this.plugin.settings.discoveryServer)
                .onChange(v => { this.plugin.settings.discoveryServer = v; this.plugin.saveSettingsDebounced(); }));

        // --- NAT Traversal (STUN/TURN) ---
        containerEl.createEl('h3', { text: 'Connection Helpers (STUN/TURN)' });
        new Setting(containerEl)
            .setName('ICE Servers (JSON)')
            .setDesc('Advanced: Edit this to add paid TURN servers for restrictive networks. Must be valid JSON array.')
            .addTextArea(t => {
                t.setValue(this.plugin.settings.iceServersJSON)
                t.inputEl.rows = 6;
                t.inputEl.style.width = '100%';
                t.inputEl.style.fontFamily = 'monospace';
                t.onChange(v => {
                    this.plugin.settings.iceServersJSON = v;
                    this.plugin.saveSettingsDebounced();
                });
            });

        // --- Local Network ---
        containerEl.createEl('h3', { text: 'Local Network (Offline Mode)' });

        if (!Platform.isMobile) {
            new Setting(containerEl)
                .setName('Enable Host Mode (Desktop Only)')
                .setDesc('Allow this device to act as a local relay server for devices on the same WiFi.')
                .addToggle(t => t.setValue(this.plugin.settings.enableLocalServer)
                    .onChange(v => { this.plugin.settings.enableLocalServer = v; this.plugin.saveSettingsDebounced(); }));

            new Setting(containerEl)
                .setName('Host Port')
                .addText(t => t.setValue(String(this.plugin.settings.localServerPort))
                    .onChange(v => { this.plugin.settings.localServerPort = Number(v); this.plugin.saveSettingsDebounced(); }));
        }

        new Setting(containerEl)
            .setName('Connect to Host')
            .setDesc('Enter ws://<Desktop-IP>:<Port> (e.g., ws://192.168.1.5:8080)')
            .addText(t => t.setValue(this.plugin.settings.localServerAddress)
                .onChange(v => { this.plugin.settings.localServerAddress = v; this.plugin.saveSettingsDebounced(); }));
    }
}