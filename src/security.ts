/**
 * SERVICE: SECURITY (AES-GCM Encryption)
 * Handles derivation of cryptographic keys from a shared secret and 
 * encrypting/decrypting payloads for safe transport over public MQTT.
 */
export class SecurityService {
    private key: CryptoKey | null = null;
    private salt: Uint8Array;

    constructor(secret: string) {
        // Deterministic salt generation from secret itself 
        // (Allows peers to derive same key without exchanging salt, assuming strong secret)
        const encoder = new TextEncoder();
        const data = encoder.encode(secret);
        this.salt = data.slice(0, 16);
        this.deriveKey(secret);
    }

    async deriveKey(password: string) {
        const enc = new TextEncoder();
        const keyMaterial = await window.crypto.subtle.importKey(
            "raw", enc.encode(password), { name: "PBKDF2" }, false, ["deriveKey"]
        );
        this.key = await window.crypto.subtle.deriveKey(
            { name: "PBKDF2", salt: this.salt, iterations: 100000, hash: "SHA-256" },
            keyMaterial, { name: "AES-GCM", length: 256 }, false, ["encrypt", "decrypt"]
        );
    }

    async encrypt(data: any): Promise<string> {
        if (!this.key) throw new Error("Security Key not ready");
        const iv = window.crypto.getRandomValues(new Uint8Array(12));
        const encoded = new TextEncoder().encode(JSON.stringify(data));
        const encrypted = await window.crypto.subtle.encrypt({ name: "AES-GCM", iv }, this.key, encoded);

        // Return JSON string of { iv, data } both base64
        return JSON.stringify({
            iv: this.arrayBufferToBase64(iv),
            content: this.arrayBufferToBase64(encrypted)
        });
    }

    async decrypt(cipherText: string): Promise<any> {
        if (!this.key) throw new Error("Security Key not ready");
        try {
            const raw = JSON.parse(cipherText);
            const iv = this.base64ToArrayBuffer(raw.iv);
            const content = this.base64ToArrayBuffer(raw.content);
            const decrypted = await window.crypto.subtle.decrypt({ name: "AES-GCM", iv }, this.key, content);
            return JSON.parse(new TextDecoder().decode(decrypted));
        } catch (e) {
            console.warn("Decryption failed. Wrong password or corrupt packet.", e);
            return null;
        }
    }

    async hashString(str: string): Promise<string> {
        const msgUint8 = new TextEncoder().encode(str);
        const hashBuffer = await crypto.subtle.digest('SHA-256', msgUint8);
        const hashArray = Array.from(new Uint8Array(hashBuffer));
        return hashArray.map(b => b.toString(16).padStart(2, '0')).join('');
    }

    // --- Helpers ---
    private arrayBufferToBase64(buffer: ArrayBuffer): string {
        let binary = '';
        const bytes = new Uint8Array(buffer);
        const len = bytes.byteLength;
        for (let i = 0; i < len; i++) binary += String.fromCharCode(bytes[i]);
        return window.btoa(binary);
    }

    private base64ToArrayBuffer(base64: string): ArrayBuffer {
        const binary_string = window.atob(base64);
        const len = binary_string.length;
        const bytes = new Uint8Array(len);
        for (let i = 0; i < len; i++) bytes[i] = binary_string.charCodeAt(i);
        return bytes.buffer;
    }
}