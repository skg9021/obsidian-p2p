import { App, Modal, Notice, Setting } from 'obsidian';
import * as QRCode from 'qrcode';
import { Html5Qrcode } from 'html5-qrcode';
import P2PSyncPlugin from '../main';
import { logger } from '../services/logger.service';

export class QRCodeModal extends Modal {
    plugin: P2PSyncPlugin;

    constructor(app: App, plugin: P2PSyncPlugin) {
        super(app);
        this.plugin = plugin;
    }

    async onOpen() {
        const { contentEl } = this;
        contentEl.empty();

        contentEl.createEl('h2', { text: 'Local Network Connection' });

        // Ensure host is running or promote to host
        if (!this.plugin.localNetworkHostElection.isLocalHost) {
            const roomName = await this.plugin.getRoomName();
            await this.plugin.localNetworkHostElection.promoteToHost(roomName);
            if (!this.plugin.localNetworkHostElection.isLocalHost) {
                contentEl.createEl('p', { text: 'Failed to start local signaling server. Cannot show QR code.', cls: 'error' });
                return;
            }
        }

        const payload = JSON.stringify({
            url: this.plugin.settings.discoveredLocalAddress,
            key: this.plugin.settings.secretKey
        });

        contentEl.createEl('p', { text: 'Scan this QR code with your mobile device to connect instantly.' });
        contentEl.createEl('p', { text: `Address: ${this.plugin.settings.discoveredLocalAddress}`, cls: 'mod-muted' });

        const img = contentEl.createEl('img');
        img.style.display = 'block';
        img.style.margin = '0 auto';
        img.style.maxWidth = '300px';

        try {
            const dataUrl = await QRCode.toDataURL(payload, { width: 300, margin: 2 });
            img.src = dataUrl;
        } catch (err) {
            logger.error('Failed to generate QR code', err);
            contentEl.createEl('p', { text: 'Error generating QR code.', cls: 'error' });
        }
    }

    onClose() {
        const { contentEl } = this;
        contentEl.empty();
    }
}

export class QRScannerModal extends Modal {
    plugin: P2PSyncPlugin;
    private html5Qrcode: Html5Qrcode | null = null;
    private scannerId = 'qr-reader';

    constructor(app: App, plugin: P2PSyncPlugin) {
        super(app);
        this.plugin = plugin;
    }

    onOpen() {
        const { contentEl } = this;
        contentEl.empty();

        contentEl.createEl('h2', { text: 'Scan Connection QR Code' });
        contentEl.createEl('p', { text: 'Point your camera at the Desktop QR code.' });

        const readerDiv = contentEl.createEl('div', { attr: { id: this.scannerId } });
        readerDiv.style.width = '100%';
        readerDiv.style.minHeight = '300px';

        const fallbackContainer = contentEl.createDiv({ cls: 'qr-fallback-container' });
        fallbackContainer.style.marginTop = '20px';
        fallbackContainer.style.textAlign = 'center';

        fallbackContainer.createEl('p', { text: 'Camera permission denied? Take a picture instead:', cls: 'mod-muted' });

        const fileInput = fallbackContainer.createEl('input', {
            type: 'file',
            attr: {
                accept: 'image/*',
                capture: 'environment'
            }
        });
        fileInput.style.maxWidth = '100%';

        fileInput.addEventListener('change', async (e: Event) => {
            const target = e.target as HTMLInputElement;
            if (target.files && target.files.length > 0) {
                const file = target.files[0];
                try {
                    if (!this.html5Qrcode) {
                        this.html5Qrcode = new Html5Qrcode(this.scannerId);
                    }
                    const decodedText = await this.html5Qrcode.scanFile(file, true);
                    this.handleScanSuccess(decodedText);
                } catch (err) {
                    logger.error('Failed to parse QR from image file', err);
                    new Notice('Could not find a valid QR code in the image.');
                }
            }
        });

        this.startScanner();
    }

    async startScanner() {
        try {
            this.html5Qrcode = new Html5Qrcode(this.scannerId);
            await this.html5Qrcode.start(
                { facingMode: 'environment' },
                { fps: 10, qrbox: { width: 250, height: 250 } },
                (decodedText: string) => this.handleScanSuccess(decodedText),
                (errorMessage: string) => {
                    // Ignore regular scan failures
                }
            );
        } catch (err) {
            logger.error('QR Scanner failed to start', err);
            this.contentEl.createEl('p', { text: 'Failed to access camera. Please check permissions.', cls: 'error' });
        }
    }

    async handleScanSuccess(decodedText: string) {
        if (this.html5Qrcode) {
            try {
                await this.html5Qrcode.stop();
            } catch (e) {
                logger.error('Failed to stop scanner', e);
            }
        }

        try {
            const payload = JSON.parse(decodedText);
            if (payload.url && payload.key) {
                this.plugin.settings.secretKey = payload.key;
                await this.plugin.security.deriveKey(payload.key);
                this.plugin.settings.discoveredLocalAddress = payload.url;
                await this.plugin.saveSettingsDebounced();

                new Notice('Connection details received! Connecting...');
                const roomName = await this.plugin.getRoomName();
                this.plugin.localNetworkHostElection.connectLocalClient(payload.url, roomName);
                this.close();
            } else {
                new Notice('Invalid QR code format.');
                this.startScanner(); // Restart
            }
        } catch (e) {
            logger.error('Failed to parse QR payload', e);
            new Notice('Invalid QR code.');
            this.startScanner(); // Restart
        }
    }

    async onClose() {
        if (this.html5Qrcode && this.html5Qrcode.isScanning) {
            try {
                await this.html5Qrcode.stop();
            } catch (e) {
                logger.error('Error stopping scanner on close', e);
            }
        }
        this.html5Qrcode?.clear();
        this.contentEl.empty();
    }
}

export class ManualConnectModal extends Modal {
    plugin: P2PSyncPlugin;
    hostAddress: string = '';

    constructor(app: App, plugin: P2PSyncPlugin) {
        super(app);
        this.plugin = plugin;
    }

    onOpen() {
        const { contentEl } = this;
        contentEl.empty();

        contentEl.createEl('h2', { text: 'Connect Manually (Overrides Auto-Discovery)' });

        const noteEl = contentEl.createEl('p', { cls: 'mod-warning' });
        noteEl.innerHTML = '<strong>Note:</strong> Using this option will bypass the default LAN auto-discovery. Only this manual connection to the specified Host will be active.';

        contentEl.createEl('p', { text: 'Please enter the Host IP address and Server Port below.' });
        contentEl.createEl('p', { text: 'Example: 192.168.1.100:8080', cls: 'mod-muted' });

        new Setting(contentEl)
            .setName('Host Address')
            .setDesc('IP Address and Port')
            .addText(text => text
                .setPlaceholder('192.168.1.100:8080')
                .setValue(this.hostAddress)
                .onChange(value => {
                    this.hostAddress = value;
                }));

        new Setting(contentEl)
            .addButton(btn => btn
                .setButtonText('Cancel')
                .onClick(() => {
                    this.close();
                }))
            .addButton(btn => btn
                .setButtonText('Connect')
                .setCta()
                .onClick(async () => {
                    if (!this.hostAddress) {
                        new Notice('Please enter a Host Address');
                        return;
                    }

                    try {
                        let url = this.hostAddress.trim();
                        // Auto format if they forgot ws://
                        if (!url.startsWith('ws://') && !url.startsWith('wss://')) {
                            url = `ws://${url}`;
                        }

                        this.plugin.settings.discoveredLocalAddress = url;
                        await this.plugin.saveSettingsDebounced();

                        new Notice('Connecting to Host...');
                        const roomName = await this.plugin.getRoomName();
                        this.plugin.localNetworkHostElection.connectLocalClient(url, roomName);
                        this.close();
                    } catch (e) {
                        logger.error('Failed to connect manually', e);
                        new Notice('Connection setup failed.');
                    }
                }));
    }

    onClose() {
        this.contentEl.empty();
    }
}
