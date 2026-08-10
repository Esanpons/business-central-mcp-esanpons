import { describe, it, expect, vi, afterEach } from 'vitest';
import { mkdtempSync, readFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createLogger } from '../../src/core/logger.js';

function tempDir(): string {
  return mkdtempSync(join(tmpdir(), 'bcmcp-log-'));
}

describe('createLogger', () => {
  const written: string[] = [];
  const spy = vi.spyOn(process.stderr, 'write').mockImplementation(((chunk: string) => {
    written.push(String(chunk));
    return true;
  }) as never);

  afterEach(() => { written.length = 0; });
  afterEach(() => { spy.mockClear(); });

  it('LOG_LEVEL=debug puts debug lines on stderr (it used to produce none at all)', async () => {
    const dir = tempDir();
    const logger = createLogger({ level: 'debug', channels: '', dir, redactValues: false });
    logger.debug('protocol', 'Sent RPC: Invoke');
    expect(written.join('')).toContain('[DEBUG] [protocol] Sent RPC: Invoke');
    await logger.flush?.();
  });

  it('keeps debug off stderr at the default level', async () => {
    const dir = tempDir();
    const logger = createLogger({ level: 'info', channels: 'protocol', dir, redactValues: false });
    logger.debug('protocol', 'quiet please');
    expect(written.join('')).not.toContain('quiet please');
    await logger.flush?.();
  });

  it('LOG_CHANNELS still decides what reaches the channel files', async () => {
    const dir = tempDir();
    const logger = createLogger({ level: 'debug', channels: 'protocol', dir, redactValues: false });
    logger.debug('protocol', 'persisted line');
    logger.debug('other', 'not persisted');
    await logger.flush?.();

    const protocolLog = readFileSync(join(dir, 'protocol.log'), 'utf8');
    expect(protocolLog).toContain('persisted line');
    const serverLog = existsSync(join(dir, 'server.log')) ? readFileSync(join(dir, 'server.log'), 'utf8') : '';
    expect(serverLog).not.toContain('not persisted');
  });

  it('flush() drains buffered lines so an exiting process does not lose the tail', async () => {
    const dir = tempDir();
    const logger = createLogger({ level: 'info', channels: '', dir, redactValues: false });
    logger.error('shutting down: BC unreachable');
    await logger.flush?.();
    expect(readFileSync(join(dir, 'server.log'), 'utf8')).toContain('shutting down: BC unreachable');
  });
});
