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

// Create a singleton pino logger instance
export const logger = pino({
    level: 'info',
    browser: {
        asObject: true,
        write: (o: any) => {
            const time = new Date(o.time).toISOString();
            const consoleMethod = o.level >= 50 ? 'error' : o.level >= 40 ? 'warn' : 'log';
            const { msg = '', ...rest } = o;

            // Delete standard pino keys so they don't clog up the console printout
            delete rest.level;
            delete rest.time;
            delete rest.v;
            delete rest.pid;
            delete rest.hostname;

            if (Object.keys(rest).length > 0) {
                console[consoleMethod](`[${time}] ${msg}`, rest);
            } else {
                console[consoleMethod](`[${time}] ${msg}`);
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
