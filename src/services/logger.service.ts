import { P2PSettings } from '../settings';

export class Logger {
    constructor(private settings: P2PSettings) { }

    private shouldLog(level: 'info' | 'debug' | 'trace'): boolean {
        if (!this.settings.enableDebugLogs) return false;

        const levels = { 'info': 1, 'debug': 2, 'trace': 3 };
        const currentLevel = levels[this.settings.debugLevel || 'info'];
        const messageLevel = levels[level];

        return currentLevel >= messageLevel;
    }

    log(message: string, ...args: any[]) {
        this.info(message, ...args);
    }

    info(message: string, ...args: any[]) {
        if (this.shouldLog('info')) {
            console.log(`[P2P Sync] ${message}`, ...args);
        }
    }

    debug(message: string, ...args: any[]) {
        if (this.shouldLog('debug')) {
            console.log(`[P2P Sync] [DEBUG] ${message}`, ...args);
        }
    }

    trace(message: string, ...args: any[]) {
        if (this.shouldLog('trace')) {
            console.log(`[P2P Sync] [TRACE] ${message}`, ...args);
        }
    }

    warn(message: string, ...args: any[]) {
        if (this.settings.enableDebugLogs) {
            console.warn(`[P2P Sync] ${message}`, ...args);
        }
    }

    error(message: string, ...args: any[]) {
        console.error(`[P2P Sync] ${message}`, ...args);
    }
}
