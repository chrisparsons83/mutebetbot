import { pino, type Logger } from 'pino';

export type { Logger };

export function createLogger(level: string, pretty: boolean): Logger {
  return pino({
    level,
    base: { app: 'mutebetbot' },
    // Never log the bot token, even if a library error includes request headers.
    redact: ['token', '*.token', 'headers.authorization', '*.headers.authorization'],
    ...(pretty ? { transport: { target: 'pino-pretty', options: { colorize: true, translateTime: 'HH:MM:ss' } } } : {}),
  });
}
