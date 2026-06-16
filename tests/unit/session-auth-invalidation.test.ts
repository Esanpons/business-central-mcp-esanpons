import { describe, it, expect, vi, beforeEach } from 'vitest';
import { SessionManager } from '../../src/session/session-manager.js';
import { SessionLostError, ConnectionError } from '../../src/core/errors.js';
import { ok, err } from '../../src/core/result.js';

// Cobreix el fix de reconnexió post-publish: després d'un al_publish el NST recicla
// l'app domain i invalida les cookies/CSRF forms-auth. El singleton NTLMAuthProvider
// les reutilitzava (flag authenticated mai resetejat) i el gate isAuthenticated()
// saltava el /SignIn, fent que tota reconnexió fallés. El fix: cridar
// authProvider.invalidate() abans de cada intent de create perquè es refaci un
// /SignIn fresc, més un lock que coalesça recoveries concurrents.

function createMockSession(alive = true) {
  return {
    isAlive: alive,
    isInitialized: true,
    close: vi.fn(),
    closeGracefully: vi.fn(),
    invoke: vi.fn(),
    openFormIds: new Set<string>(),
  };
}

function createMockPageContextRepo() {
  return {
    listPageContextIds: vi.fn(() => ['ctx:1', 'ctx:2']),
    clearAll: vi.fn(),
    size: 2,
  };
}

function createMockLogger() {
  return { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() };
}

function createMockAuthProvider() {
  return {
    authenticate: vi.fn(async () => ok({ cookies: 'fresh-cookies', csrfToken: 'fresh-token' })),
    getWebSocketHeaders: vi.fn(() => ({ Cookie: 'fresh-cookies' })),
    getWebSocketQueryParams: vi.fn(() => ({ csrftoken: 'fresh-token' })),
    isAuthenticated: vi.fn(() => true),
    invalidate: vi.fn(),
  };
}

/** Subclass that records delay calls instead of sleeping */
class TestSessionManager extends SessionManager {
  public delayCalls: number[] = [];
  protected override delay(ms: number): Promise<void> {
    this.delayCalls.push(ms);
    return Promise.resolve();
  }
}

describe('Auth invalidation on reconnect (post-publish fix)', () => {
  let logger: ReturnType<typeof createMockLogger>;
  let repo: ReturnType<typeof createMockPageContextRepo>;
  let auth: ReturnType<typeof createMockAuthProvider>;

  beforeEach(() => {
    logger = createMockLogger();
    repo = createMockPageContextRepo();
    auth = createMockAuthProvider();
  });

  it('invalidates auth before EVERY create attempt during recovery', async () => {
    const aliveSession = createMockSession(true);
    const newSession = createMockSession(true);

    // initial OK, then recovery: 1 failure (stale cookies rejected) then success
    const factory = {
      create: vi.fn()
        .mockResolvedValueOnce(ok(aliveSession))
        .mockResolvedValueOnce(err(new ConnectionError('Session initialization failed: InvalidSessionException')))
        .mockResolvedValueOnce(ok(newSession)),
    };
    const mgr = new TestSessionManager(
      factory as any, repo as any, logger as any,
      { maxRetries: 4, baseDelayMs: 1000 }, undefined, auth as any,
    );

    await mgr.getSession();                          // initial connect
    expect(auth.invalidate).toHaveBeenCalledTimes(1); // invalidate also runs on first connect (idempotent)

    (aliveSession as any).isAlive = false;            // session dies (NST recycled by publish)
    await expect(mgr.getSession()).rejects.toThrow(SessionLostError);

    // 3 creates total (initial + 2 recovery), and invalidate() ran before each one.
    // This is the core of the fix: stale cookies are never reused — a fresh /SignIn
    // is forced on every attempt.
    expect(factory.create).toHaveBeenCalledTimes(3);
    expect(auth.invalidate).toHaveBeenCalledTimes(3);
  });

  it('recovers automatically after a dead session by re-signing-in', async () => {
    const aliveSession = createMockSession(true);
    const newSession = createMockSession(true);

    const factory = {
      create: vi.fn()
        .mockResolvedValueOnce(ok(aliveSession))
        .mockResolvedValueOnce(ok(newSession)),
    };
    const mgr = new TestSessionManager(
      factory as any, repo as any, logger as any,
      { maxRetries: 4, baseDelayMs: 1000 }, undefined, auth as any,
    );

    await mgr.getSession();
    (aliveSession as any).isAlive = false;

    // First post-death call recreates the session and throws the informative error
    await expect(mgr.getSession()).rejects.toThrow(SessionLostError);
    // Next call returns the freshly recreated session — recovery succeeded in-process
    const s = await mgr.getSession();
    expect(s).toBe(newSession);
    expect(auth.invalidate).toHaveBeenCalled();
  });

  it('coalesces concurrent recovery into a SINGLE re-login (concurrency lock)', async () => {
    const aliveSession = createMockSession(true);
    const newSession = createMockSession(true);

    let releaseRecovery!: () => void;
    const recoveryGate = new Promise<void>(r => { releaseRecovery = r; });

    const factory = {
      create: vi.fn()
        .mockResolvedValueOnce(ok(aliveSession))      // initial
        .mockImplementationOnce(async () => {          // recovery: slow, gated
          await recoveryGate;
          return ok(newSession);
        }),
    };
    const mgr = new TestSessionManager(
      factory as any, repo as any, logger as any,
      { maxRetries: 4, baseDelayMs: 1000 }, undefined, auth as any,
    );

    await mgr.getSession();
    (aliveSession as any).isAlive = false;

    // Two tool calls hit recovery concurrently (stdio rl.on('line', async) doesn't serialize)
    const p1 = mgr.getSession().catch(e => e);
    const p2 = mgr.getSession().catch(e => e);

    // Let both callers reach the shared recovery promise
    await Promise.resolve();
    await Promise.resolve();

    releaseRecovery();
    await Promise.all([p1, p2]);

    // Without the lock there would be 2 recovery creates + 2 /SignIn competing for the
    // NTLM slot. With the lock, both callers share ONE recovery: initial + 1 recovery.
    expect(factory.create).toHaveBeenCalledTimes(2);
    expect(auth.invalidate).toHaveBeenCalledTimes(2);
  });

  it('caps exponential backoff at 30s so high retry counts stay bounded', async () => {
    const factory = { create: vi.fn().mockResolvedValue(err(new ConnectionError('NST still recycling'))) };
    const mgr = new TestSessionManager(
      factory as any, repo as any, logger as any,
      { maxRetries: 6, baseDelayMs: 2000 }, undefined, auth as any,
    );

    await expect(mgr.getSession()).rejects.toThrow();

    // attempts 1..6: 2000, 4000, 8000, 16000, then capped 30000 (would be 32000), 30000 (would be 64000)
    expect(mgr.delayCalls).toEqual([2000, 4000, 8000, 16000, 30000, 30000]);
  });

  it('still works when no authProvider is wired (optional param, back-compat)', async () => {
    const session = createMockSession(true);
    const factory = { create: vi.fn().mockResolvedValueOnce(ok(session)) };
    // No authProvider passed — must not throw (optional dependency)
    const mgr = new TestSessionManager(factory as any, repo as any, logger as any);

    const s = await mgr.getSession();
    expect(s).toBe(session);
  });
});
