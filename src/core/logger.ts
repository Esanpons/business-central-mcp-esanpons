import { mkdirSync, createWriteStream, type WriteStream } from 'node:fs';
import { join } from 'node:path';
import type { LoggingConfig } from './config.js';

export interface Logger {
  info(msg: string, context?: Record<string, unknown>): void;
  warn(msg: string, context?: Record<string, unknown>): void;
  error(msg: string, context?: Record<string, unknown>): void;
  debug(channel: string, msg: string, context?: Record<string, unknown>): void;
  /**
   * Drain and close the log-file streams. Optional so every existing Logger
   * implementation (and every test double) stays valid. Entry points should
   * `await logger.flush?.()` before `process.exit`, otherwise buffered lines --
   * typically the shutdown reason -- are dropped.
   */
  flush?(): Promise<void>;
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

  const streams = [serverLog, protocolLog].filter((s): s is WriteStream => s !== null);
  registerFlushOnExit(streams);

  return {
    info(msg, context) { writeStderr('info', msg); writeLog(serverLog, 'info', msg, context); },
    warn(msg, context) { writeStderr('warn', msg); writeLog(serverLog, 'warn', msg, context); },
    error(msg, context) { writeStderr('error', msg); writeLog(serverLog, 'error', msg, context); },
    debug(channel, msg, context) {
      // LOG_LEVEL=debug used to produce NO stderr output at all: debug() only ever
      // wrote to the channel files, and only for channels named in LOG_CHANNELS.
      // Setting the level to debug now does what it says -- the line also reaches
      // stderr (where a stdio client shows it), while LOG_CHANNELS keeps deciding
      // which channels are persisted to the log files.
      writeStderr('debug', `[${channel}] ${msg}`);
      if (enabledChannels.has(channel) || enabledChannels.has('all')) {
        const target = channel === 'protocol' ? protocolLog : serverLog;
        writeLog(target, 'debug', `[${channel}] ${msg}`, context);
      }
    },
    async flush(): Promise<void> { await flushStreams(streams); },
  };
}

/**
 * Wait for every buffered log line to reach the OS, then close the streams.
 * `WriteStream.write()` is asynchronous: on `process.exit(0)` (and on a fast
 * SIGINT path) anything still sitting in the stream buffer is silently dropped,
 * which loses exactly the tail that explains why the process is going away.
 */
function flushStreams(streams: WriteStream[]): Promise<void> {
  return Promise.all(
    streams.map(
      (s) => new Promise<void>((resolve) => {
        if (s.closed || s.destroyed) { resolve(); return; }
        s.end(() => resolve());
      }),
    ),
  ).then(() => undefined);
}

/**
 * Best-effort tail flush on process exit. `process.on('exit')` cannot await, so
 * this only asks every open log stream to end (which pushes whatever is already
 * queued at the stream layer down to the fd). It is a safety net for exit paths
 * that forget to `await logger.flush()` -- entry points should still call
 * `flush()` explicitly before `process.exit`.
 *
 * One shared handler and one shared registry: createLogger may run several times
 * in a process (tests, scripts) and N listeners would trip Node's
 * MaxListenersExceededWarning.
 */
const openLogStreams = new Set<WriteStream>();
let exitHookInstalled = false;

function registerFlushOnExit(streams: WriteStream[]): void {
  if (streams.length === 0) return;
  for (const s of streams) {
    openLogStreams.add(s);
    s.on('close', () => openLogStreams.delete(s));
  }
  if (exitHookInstalled) return;
  exitHookInstalled = true;
  process.on('exit', () => {
    for (const s of openLogStreams) {
      try { s.end(); } catch { /* exiting anyway */ }
    }
  });
}

export function createNullLogger(): Logger {
  const noop = () => {};
  return { info: noop, warn: noop, error: noop, debug: noop };
}
