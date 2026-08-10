import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { BCSession } from '../../src/session/bc-session.js';
import { EventDecoder } from '../../src/protocol/event-decoder.js';
import { InteractionEncoder } from '../../src/protocol/interaction-encoder.js';
import { ok, err } from '../../src/core/result.js';
import { ProtocolError } from '../../src/core/errors.js';
import { RPC_TIMEOUT_CODE } from '../../src/connection/bc-websocket.js';
import type { BCEvent, BCInteraction, EventPredicate } from '../../src/protocol/types.js';

function createMockWs(hangOnSend = false) {
  return {
    isConnected: true,
    spaInstanceId: 'spa-test',
    nextSequenceNo: 1,
    lastClientAckSequenceNumber: 0,
    sendRpc: vi.fn((): Promise<any> => {
      if (hangOnSend) {
        // Never resolves -- simulates BC hanging
        return new Promise(() => {});
      }
      return Promise.resolve(ok([]));
    }),
    onMessage: vi.fn(() => () => {}),
    close: vi.fn(),
    forceClose: vi.fn(),
  };
}

function createMockLogger() {
  return {
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
  };
}

function createMockEncoder() {
  return {
    encode: vi.fn(() => ({ method: 'Invoke', params: [{}] })),
    encodeOpenSession: vi.fn(() => ({ method: 'OpenSession', params: [{}] })),
  } as unknown as InteractionEncoder;
}

function createMockDecoder() {
  return {
    decode: vi.fn(() => [] as BCEvent[]),
  } as unknown as EventDecoder;
}

const dummyInteraction: BCInteraction = { type: 'InvokeAction', formId: '1', controlPath: 'server:', systemAction: 30 };
const dummyExpect: EventPredicate = () => true;

describe('BCSession invoke timeout', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('returns ProtocolError when invoke exceeds timeout', async () => {
    const ws = createMockWs(true);
    const session = new BCSession(
      ws as any, createMockDecoder(), createMockEncoder(),
      createMockLogger() as any, 'default', 1000,
    );

    const resultPromise = session.invoke(dummyInteraction, dummyExpect);

    // Advance past the session-level timeout (1000 + 5000 = 6000ms)
    await vi.advanceTimersByTimeAsync(6001);

    const result = await resultPromise;
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.message).toContain('Session has been killed');
    }
  });

  it('marks session dead after timeout', async () => {
    const ws = createMockWs(true);
    const session = new BCSession(
      ws as any, createMockDecoder(), createMockEncoder(),
      createMockLogger() as any, 'default', 1000,
    );

    expect(session.isAlive).toBe(true);

    const resultPromise = session.invoke(dummyInteraction, dummyExpect);
    await vi.advanceTimersByTimeAsync(6001);
    await resultPromise;

    expect(session.isAlive).toBe(false);
  });

  it('force-closes the socket on timeout (not a polite close that can hang)', async () => {
    const ws = createMockWs(true);
    const session = new BCSession(
      ws as any, createMockDecoder(), createMockEncoder(),
      createMockLogger() as any, 'default', 1000,
    );

    const resultPromise = session.invoke(dummyInteraction, dummyExpect);
    await vi.advanceTimersByTimeAsync(6001);
    await resultPromise;

    expect(ws.forceClose).toHaveBeenCalled();
  });

  it('falls back to close() when the socket has no forceClose', async () => {
    const ws = createMockWs(true) as any;
    delete ws.forceClose;
    const session = new BCSession(
      ws, createMockDecoder(), createMockEncoder(),
      createMockLogger() as any, 'default', 1000,
    );

    const resultPromise = session.invoke(dummyInteraction, dummyExpect);
    await vi.advanceTimersByTimeAsync(6001);
    await resultPromise;

    expect(ws.close).toHaveBeenCalled();
  });

  it('succeeds normally when response arrives before timeout', async () => {
    const ws = createMockWs(false); // responds immediately
    const session = new BCSession(
      ws as any, createMockDecoder(), createMockEncoder(),
      createMockLogger() as any, 'default', 5000,
    );

    const resultPromise = session.invoke(dummyInteraction, dummyExpect);

    // Quiescence window (150ms) + the bounded expect-wait (this decoder emits no
    // events at all, so the predicate cannot match and the wait runs its two idle
    // slices before giving up).
    await vi.advanceTimersByTimeAsync(1000);

    const result = await resultPromise;
    expect(result.ok).toBe(true);
    expect(ws.close).not.toHaveBeenCalled();
    expect(ws.forceClose).not.toHaveBeenCalled();
  });

  it('an RPC timeout kills the session instead of leaving it desynced', async () => {
    // The per-RPC deadline fires 5s BEFORE the session watchdog. It used to return
    // a plain error and leave the session alive, so a late BC response was dropped
    // and openFormIds/modalStack drifted from the server.
    const ws = createMockWs(false);
    ws.sendRpc = vi.fn(async () =>
      err(new ProtocolError('RPC timed out after 1000ms', { method: 'Invoke' }, RPC_TIMEOUT_CODE)),
    ) as any;
    const session = new BCSession(
      ws as any, createMockDecoder(), createMockEncoder(),
      createMockLogger() as any, 'default', 1000,
    );

    const result = await session.invoke(dummyInteraction, dummyExpect);

    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.code).toBe(RPC_TIMEOUT_CODE);
    expect(session.isAlive).toBe(false);
    expect(ws.forceClose).toHaveBeenCalled();
  });

  it('an invoke queued behind a session-killing one never reaches the wire', async () => {
    const ws = createMockWs(false);
    let sends = 0;
    ws.sendRpc = vi.fn(async () => {
      sends += 1;
      return err(new ProtocolError('RPC timed out', {}, RPC_TIMEOUT_CODE));
    }) as any;
    const session = new BCSession(
      ws as any, createMockDecoder(), createMockEncoder(),
      createMockLogger() as any, 'default', 1000,
    );

    const first = session.invoke(dummyInteraction, dummyExpect);
    const second = session.invoke(dummyInteraction, dummyExpect);
    const [r1, r2] = await Promise.all([first, second]);

    expect(r1.ok).toBe(false);
    expect(r2.ok).toBe(false);
    if (!r2.ok) expect(r2.error.message).toContain('Session is dead');
    expect(sends).toBe(1); // the second invoke was rejected without sending
  });

  it('the watchdog is renewed by progress, so a long modal reconcile is not killed', async () => {
    // Every RPC answers after 4s: inside the 5s per-RPC budget, but the violation
    // + reconcile + retry sequence adds up to ~12s, past the old FIXED
    // `timeout + 5s` total budget that used to kill the session mid-recovery.
    const ws = createMockWs(false);
    let sends = 0;
    ws.sendRpc = vi.fn(
      () => new Promise((resolve) => {
        sends += 1;
        const nth = sends;
        setTimeout(() => {
          resolve(nth === 1
            ? err(new ProtocolError('LogicalModalityViolationException: stale dialog'))
            : ok([]));
        }, 4000);
      }),
    ) as any;

    const decoder = { decode: vi.fn(() => (sends === 2 ? [{ type: 'FormClosed', formId: 'M1' }] : [])) };
    const session = new BCSession(
      ws as any, decoder as any, createMockEncoder(),
      createMockLogger() as any, 'default', 5000,
    );
    // Seed a stale modal so reconcileModalStack has something to close.
    (session as any).updateFormTracking([{ type: 'DialogOpened', formId: 'M1', controlTree: {} }]);

    const p = session.invoke(dummyInteraction, dummyExpect);
    await vi.advanceTimersByTimeAsync(30000);
    const result = await p;

    expect(result.ok).toBe(true);
    expect(session.isAlive).toBe(true);
    expect(sends).toBe(3); // violation + one reconcile answer + retry
  });
});
