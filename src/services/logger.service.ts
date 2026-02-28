import { P2PSettings } from '../settings';

// Flag to toggle between Local Time and UTC for log timestamps
const useLocalTimestamp = true;

// Pino-compatible log level numeric values
const LEVELS: Record<string, number> = {
    fatal: 60,
    error: 50,
    warn: 40,
    info: 30,
    debug: 20,
    trace: 10,
};

// Human-readable level labels
const LEVEL_LABELS: Record<string, string> = {
    fatal: 'FATAL',
    error: 'ERROR',
    warn: 'WARN',
    info: 'INFO',
    debug: 'DEBUG',
    trace: 'TRACE',
};

function formatTimestamp(): string {
    const date = new Date();
    return useLocalTimestamp ? date.toLocaleString() : date.toISOString();
}

function createLogMethod(levelName: string, consoleMethod: 'log' | 'warn' | 'error') {
    const levelValue = LEVELS[levelName];
    const levelLabel = LEVEL_LABELS[levelName];

    return function (msg: any, ...args: any[]) {
        if (levelValue < LEVELS[logger.level]) return;
        const prefix = `[${formatTimestamp()}] [${levelLabel}]`;
        console[consoleMethod](`${prefix} ${msg}`, ...args);
    };
}

export interface ILogger {
    info(msg: any, ...args: any[]): void;
    warn(msg: any, ...args: any[]): void;
    error(msg: any, ...args: any[]): void;
    debug(msg: any, ...args: any[]): void;
    trace(msg: any, ...args: any[]): void;
    fatal(msg: any, ...args: any[]): void;
    level: string;
}

// Create a singleton logger instance with console.log-style API
export const logger: ILogger = {
    level: 'info',
    info: createLogMethod('info', 'log'),
    warn: createLogMethod('warn', 'warn'),
    error: createLogMethod('error', 'error'),
    debug: createLogMethod('debug', 'log'),
    trace: createLogMethod('trace', 'log'),
    fatal: createLogMethod('fatal', 'error'),
};

/**
 * Configure the global logger instance based on user settings
 */
export function updateLoggerSettings(settings: P2PSettings) {
    if (!settings.enableDebugLogs) {
        logger.level = 'warn';
    } else {
        logger.level = settings.debugLevel || 'info';
    }
}
