import { P2PSettings } from '../settings';

export class Logger {
    constructor(private settings: P2PSettings) { }

    log(message: string, ...args: any[]) {
        if (this.settings.enableDebugLogs) {
            console.log(`[P2P Sync] ${message}`, ...args);
        }
    }

    warn(message: string, ...args: any[]) {
        if (this.settings.enableDebugLogs) {
            console.warn(`[P2P Sync] ${message}`, ...args);
        }
    }

    error(message: string, ...args: any[]) {
        // Errors should arguably always be logged, but adhering to the user request for "verbose logging when enabled", 
        // we might want to log errors regardless? 
        // Typically errors are critical. I will log errors always, but maybe prefix them.
        // Actually, user said "Verbose logging should be done when enabled".
        // Let's log errors always as they are critical for debugging even without verbose mode, 
        // but normal 'log' only when enabled.
        console.error(`[P2P Sync] ${message}`, ...args);
    }
}
