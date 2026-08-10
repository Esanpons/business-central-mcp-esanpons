import { describe, it, expect, vi } from 'vitest';
import { SessionManager } from '../../src/session/session-manager.js';
import { SessionLostError } from '../../src/core/errors.js';
import { ok, err } from '../../src/core/result.js';
import { ConnectionError } from '../../src/core/errors.js';

// B2/B3 regression cover. Both bugs only show up when a session DIES, which the
// happy-path tests never exercise.

function mockSession(company = 'CRONUS', alive = true) {
  const s = {
    isAlive: alive,
    isInitialized: true,
    companyName: company,
    close: vi.fn(),
    invoke: vi.fn(),
    openFormIds: new Set<string>(),
    changeCompany: vi.fn(async (name: string) => { s.companyName = name; return ok([]); }),
  };
  return s;
}

function mockRepo() {
  return {
    listPageContextIds: vi.fn(() => ['ctx:1', 'ctx:2']),
    clearAll: vi.fn(),
    size: 2,
  };
}

const silentLogger = { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() };

class TestSessionManager extends SessionManager {
  protected override delay(): Promise<void> {
    return Promise.resolve();
  }
}

describe('SessionManager recovery', () => {
  it('B2: re-applies the pinned company on the session created after a death', async () => {
    const dead = mockSession('CRONUS ES', false);
    const fresh = mockSession('CRONUS', true);
    let handed = 0;
    const factory = { create: vi.fn(async () => ok(handed++ === 0 ? dead : fresh)) };
    const repo = mockRepo();

    const mgr = new TestSessionManager(factory as never, repo as never, silentLogger as never);

    // First call installs `dead` (alive at that point).
    dead.isAlive = true;
    const first = await mgr.getSession();
    expect(first).toBe(dead);

    // The caller switches company; the operation reports it to the manager.
    mgr.rememberCompany('CRONUS ES');
    expect(mgr.pinnedCompany).toBe('CRONUS ES');

    // BC drops the session.
    dead.isAlive = false;
    await expect(mgr.getSession()).rejects.toThrow(SessionLostError);

    // The recreated session must be put back on the chosen company, not left on
    // whatever the server defaults to.
    expect(fresh.changeCompany).toHaveBeenCalledWith('CRONUS ES');
    expect(mgr.currentSession?.companyName).toBe('CRONUS ES');
  });

  it('B2: does not touch the company when none was pinned', async () => {
    const dead = mockSession('CRONUS', true);
    const fresh = mockSession('CRONUS', true);
    let handed = 0;
    const factory = { create: vi.fn(async () => ok(handed++ === 0 ? dead : fresh)) };
    const mgr = new TestSessionManager(factory as never, mockRepo() as never, silentLogger as never);

    await mgr.getSession();
    dead.isAlive = false;
    await expect(mgr.getSession()).rejects.toThrow(SessionLostError);

    expect(fresh.changeCompany).not.toHaveBeenCalled();
  });

  it('B3: a concurrent caller during recovery ALSO gets SessionLostError, not a silent session', async () => {
    const dead = mockSession('CRONUS', true);
    const fresh = mockSession('CRONUS', true);
    let handed = 0;
    let releaseCreate: (() => void) | null = null;
    const factory = {
      create: vi.fn(async () => {
        if (handed++ === 0) return ok(dead);
        // Hold the second create open so both callers are inside getSession at once.
        await new Promise<void>((r) => { releaseCreate = r; });
        return ok(fresh);
      }),
    };
    const repo = mockRepo();
    const mgr = new TestSessionManager(factory as never, repo as never, silentLogger as never);

    await mgr.getSession();
    dead.isAlive = false;

    const a = mgr.getSession().then(() => 'resolved', (e: unknown) => e);
    // Let the first caller reach the awaited create (session is null right now —
    // this is the exact window where the second caller used to take the
    // "first create" branch and get a session with no warning).
    await new Promise((r) => setTimeout(r, 0));
    const b = mgr.getSession().then(() => 'resolved', (e: unknown) => e);
    await new Promise((r) => setTimeout(r, 0));
    releaseCreate?.();

    const [ra, rb] = await Promise.all([a, b]);
    expect(ra).toBeInstanceOf(SessionLostError);
    expect(rb).toBeInstanceOf(SessionLostError);
    expect((rb as SessionLostError).message).toContain('no longer valid');
    // One recovery, one new session — not two.
    expect(factory.create).toHaveBeenCalledTimes(2); // initial + one recovery
  });

  it('does not publish the session until the pinned company has been applied', async () => {
    // Publishing first was a race: a concurrent getSession() could enqueue an
    // invoke ahead of the ChangeCompany and read the WRONG company.
    const dead = mockSession('CRONUS', true);
    const fresh = mockSession('CRONUS', true);
    let releaseChange: (() => void) | null = null;
    fresh.changeCompany = vi.fn(async (name: string) => {
      await new Promise<void>((r) => { releaseChange = r; });
      fresh.companyName = name;
      return ok([]);
    });
    let handed = 0;
    const factory = { create: vi.fn(async () => ok(handed++ === 0 ? dead : fresh)) };
    const mgr = new TestSessionManager(factory as never, mockRepo() as never, silentLogger as never);

    await mgr.getSession();
    mgr.rememberCompany('CRONUS ES');
    dead.isAlive = false;

    const recovering = mgr.getSession().then(() => 'resolved', (e: unknown) => e);
    // Let recovery reach the (blocked) changeCompany.
    await new Promise((r) => setTimeout(r, 0));
    await new Promise((r) => setTimeout(r, 0));
    expect(fresh.changeCompany).toHaveBeenCalled();
    // The half-configured session must NOT be visible yet.
    expect(mgr.currentSession).toBeNull();

    releaseChange!();
    expect(await recovering).toBeInstanceOf(SessionLostError);
    expect(mgr.currentSession).toBe(fresh);
    expect(mgr.currentSession?.companyName).toBe('CRONUS ES');
  });

  it('first-connect failure surfaces the underlying reason, not a bare Error', async () => {
    const factory = {
      create: vi.fn(async () => err(new ConnectionError('Authentication failed: Invalid username or password'))),
    };
    const mgr = new TestSessionManager(factory as never, mockRepo() as never, silentLogger as never, {
      maxRetries: 1,
      baseDelayMs: 1,
    });

    try {
      await mgr.getSession();
      throw new Error('should have thrown');
    } catch (e) {
      expect(e).toBeInstanceOf(SessionLostError);
      const sle = e as SessionLostError;
      expect(sle.code).toBe('SESSION_LOST');
      expect(sle.reconnectFailed).toBe(true);
      expect(sle.message).toContain('Session creation failed after all retry attempts');
      expect(sle.message).toContain('Invalid username or password');
    }
  });

  it('concurrent first callers share one create and both get the same session', async () => {
    let releaseCreate: (() => void) | null = null;
    const session = mockSession('CRONUS', true);
    const factory = {
      create: vi.fn(async () => {
        await new Promise<void>((r) => { releaseCreate = r; });
        return ok(session);
      }),
    };
    const mgr = new TestSessionManager(factory as never, mockRepo() as never, silentLogger as never);

    const a = mgr.getSession();
    await new Promise((r) => setTimeout(r, 0));
    const b = mgr.getSession();
    await new Promise((r) => setTimeout(r, 0));
    releaseCreate!();

    expect(await a).toBe(session);
    expect(await b).toBe(session);
    expect(factory.create).toHaveBeenCalledTimes(1);
  });

  it('B3: a concurrent caller gets the reconnect-failed error when recovery fails', async () => {
    const dead = mockSession('CRONUS', true);
    let handed = 0;
    let releaseCreate: (() => void) | null = null;
    const factory = {
      create: vi.fn(async () => {
        if (handed++ === 0) return ok(dead);
        await new Promise<void>((r) => { releaseCreate = r; });
        return err(new ConnectionError('connection refused'));
      }),
    };
    const mgr = new TestSessionManager(factory as never, mockRepo() as never, silentLogger as never, {
      maxRetries: 0,
      baseDelayMs: 1,
    });

    await mgr.getSession();
    dead.isAlive = false;

    const a = mgr.getSession().then(() => 'resolved', (e: unknown) => e);
    await new Promise((r) => setTimeout(r, 0));
    const b = mgr.getSession().then(() => 'resolved', (e: unknown) => e);
    await new Promise((r) => setTimeout(r, 0));
    releaseCreate?.();

    const [ra, rb] = await Promise.all([a, b]);
    for (const r of [ra, rb]) {
      expect(r).toBeInstanceOf(SessionLostError);
      expect((r as SessionLostError).message).toContain('all reconnect attempts failed');
    }
  });
});
