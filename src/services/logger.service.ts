import pino from 'pino';
import { P2PSettings } from '../settings';

export interface ILogger {
    info(msg: any, ...args: any[]): void;
    warn(msg: any, ...args: any[]): void;
    error(msg: any, ...args: any[]): void;
    debug(msg: any, ...args: any[]): void;
    trace(msg: any, ...args: any[]): void;
    fatal(msg: any, ...args: any[]): void;
    level: string;
}

// Flag to toggle between Local Time and UTC for log timestamps
const useLocalTimestamp = true;

// Helper to convert Pino numeric levels to human-readable strings
const getLevelString = (level: number): string => {
    if (level >= 60) return 'FATAL';
    if (level >= 50) return 'ERROR';
    if (level >= 40) return 'WARN';
    if (level >= 30) return 'INFO';
    if (level >= 20) return 'DEBUG';
    if (level >= 10) return 'TRACE';
    return 'USER';
};

// Create a singleton pino logger instance
export const logger = pino({
    level: 'info',
    browser: {
        asObject: true,
        write: (o: any) => {
            const date = new Date(o.time);
            const timeStr = useLocalTimestamp
                ? date.toLocaleString()
                : date.toISOString();

            const levelStr = getLevelString(o.level);
            const consoleMethod = o.level >= 50 ? 'error' : o.level >= 40 ? 'warn' : 'log';
            const { msg = '', ...rest } = o;

            // Delete standard pino keys so they don't clog up the console printout
            delete rest.level;
            delete rest.time;
            delete rest.v;
            delete rest.pid;
            delete rest.hostname;

            // Pino sometimes places trailing array arguments into numeric keys '0', '1', etc.
            // Or within a nested array. Let's dynamically extract any other keys.
            const extraArgs = [];
            for (const key of Object.keys(rest)) {
                if (!isNaN(Number(key))) {
                    extraArgs.push(rest[key]);
                    delete rest[key]; // safely move it out
                }
            }

            const hasRest = Object.keys(rest).length > 0;

            if (extraArgs.length > 0 && hasRest) {
                console[consoleMethod](`[${timeStr}] [${levelStr}] ${msg}`, rest, ...extraArgs);
            } else if (extraArgs.length > 0) {
                console[consoleMethod](`[${timeStr}] [${levelStr}] ${msg}`, ...extraArgs);
            } else if (hasRest) {
                console[consoleMethod](`[${timeStr}] [${levelStr}] ${msg}`, rest);
            } else {
                console[consoleMethod](`[${timeStr}] [${levelStr}] ${msg}`);
            }
        }
    }
}) as unknown as ILogger;

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
