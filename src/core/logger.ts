import { mkdirSync, createWriteStream, type WriteStream } from 'node:fs';
import { join } from 'node:path';
import type { LoggingConfig } from './config.js';

export interface Logger {
  info(msg: string, context?: Record<string, unknown>): void;
  warn(msg: string, context?: Record<string, unknown>): void;
  error(msg: string, context?: Record<string, unknown>): void;
  debug(channel: string, msg: string, context?: Record<string, unknown>): void;
}

type LogLevel = 'debug' | 'info' | 'warn' | 'error';
const LEVELS: Record<LogLevel, number> = { debug: 0, info: 1, warn: 2, error: 3 };

export function createLogger(config: LoggingConfig): Logger {
  const stderrLevel = LEVELS[config.level as LogLevel] ?? LEVELS.info;
  const enabledChannels = new Set(config.channels ? config.channels.split(',').map(c => c.trim()) : []);

  // File logging is best-effort. If the log dir can't be created or opened (an
  // unwritable cwd — common when a stdio client launches the server from a system
  // directory), degrade to stderr-only instead of crashing the whole server at
  // startup.
  let serverLog: WriteStream | null = null;
  let protocolLog: WriteStream | null = null;
  try {
    mkdirSync(config.dir, { recursive: true });
    serverLog = createWriteStream(join(config.dir, 'server.log'), { flags: 'a' });
    protocolLog = createWriteStream(join(config.dir, 'protocol.log'), { flags: 'a' });
    // Without an 'error' handler, a runtime write failure (disk full, EACCES, the
    // log dir deleted under us) emits an unhandled 'error' event that crashes the
    // whole process. Downgrade it to a one-line stderr notice instead.
    for (const stream of [serverLog, protocolLog]) {
      stream.on('error', (e: Error) => {
        process.stderr.write(`[ERROR] log stream write failed: ${e.message}\n`);
      });
    }
  } catch (e) {
    process.stderr.write(`[WARN] file logging disabled (cannot write to ${config.dir}): ${e instanceof Error ? e.message : String(e)}\n`);
  }

  function writeStderr(level: LogLevel, msg: string): void {
    if (LEVELS[level] >= stderrLevel) {
      process.stderr.write(`[${level.toUpperCase()}] ${msg}\n`);
    }
  }

  function writeLog(stream: WriteStream | null, level: LogLevel, msg: string, context?: Record<string, unknown>): void {
    if (!stream) return;
    const entry = JSON.stringify({ timestamp: new Date().toISOString(), level, msg, ...context });
    stream.write(entry + '\n');
  }

  return {
    info(msg, context) { writeStderr('info', msg); writeLog(serverLog, 'info', msg, context); },
    warn(msg, context) { writeStderr('warn', msg); writeLog(serverLog, 'warn', msg, context); },
    error(msg, context) { writeStderr('error', msg); writeLog(serverLog, 'error', msg, context); },
    debug(channel, msg, context) {
      if (enabledChannels.has(channel) || enabledChannels.has('all')) {
        const target = channel === 'protocol' ? protocolLog : serverLog;
        writeLog(target, 'debug', `[${channel}] ${msg}`, context);
      }
    },
  };
}

export function createNullLogger(): Logger {
  const noop = () => {};
  return { info: noop, warn: noop, error: noop, debug: noop };
}
