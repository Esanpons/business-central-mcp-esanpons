import { describe, it, expect, vi } from 'vitest';
import { SessionManager } from '../../src/session/session-manager.js';
import { ResetSessionOperation } from '../../src/operations/reset-session.js';
import { buildResetSessionTool } from '../../src/mcp/tool-registry.js';
import { ok, err } from '../../src/core/result.js';
import { ConnectionError } from '../../src/core/errors.js';

/**
 * bc-saas F-39 §4 ter: there was NO way back to a clean session. bc_close_page closes
 * one page, takes no `all`, and was observed RAISING modalDepth (2 -> 3) while cleaning
 * up. Open forms and the modal stack are per-SESSION state, so only replacing the
 * session clears them — which until now meant a person restarting the server process.
 */
function mockSession(company = 'CRONUS ES', forms = 19, modals = 2) {
  return {
    isAlive: true,
    isInitialized: true,
    companyName: company,
    openFormIds: new Set(Array.from({ length: forms }, (_, i) => `f${i}`)),
    modalStackSnapshot: () => Array.from({ length: modals }, (_, i) => `m${i}`),
    close: vi.fn(),
    closeGracefully: vi.fn(async () => {}),
    changeCompany: vi.fn(),
    invoke: vi.fn(),
  };
}

function mockRepo() {
  return { listPageContextIds: vi.fn(() => ['ctx:1', 'ctx:2']), clearAll: vi.fn(), size: 2 };
}
const mockLogger = () => ({ info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() });

class TestSessionManager extends SessionManager {
  protected override delay(): Promise<void> { return Promise.resolve(); }
}

async function managerWithLiveSession(first = mockSession(), next = mockSession('CRONUS ES', 0, 0)) {
  const repo = mockRepo();
  const logger = mockLogger();
  let calls = 0;
  const factory = { create: vi.fn(async () => ok(calls++ === 0 ? first : next)) };
  const mgr = new TestSessionManager(factory as never, repo as never, logger as never);
  await mgr.getSession(); // publish `first`
  return { mgr, repo, logger, factory, first, next };
}

describe('SessionManager.resetSession', () => {
  it('replaces the session and reports the state it dropped', async () => {
    const { mgr, first, next } = await managerWithLiveSession();
    const r = await mgr.resetSession();

    expect(first.closeGracefully).toHaveBeenCalled();
    expect(mgr.currentSession).toBe(next);
    expect(r.previousOpenForms).toBe(19);
    expect(r.previousModalDepth).toBe(2);
    // The whole point: the NEW session carries neither.
    expect(mgr.currentSession?.openFormIds.size).toBe(0);
    expect(mgr.currentSession?.modalStackSnapshot().length).toBe(0);
  });

  it('clears the page contexts and reports them as invalidated', async () => {
    const { mgr, repo } = await managerWithLiveSession();
    const r = await mgr.resetSession();
    expect(repo.clearAll).toHaveBeenCalled();
    expect(r.invalidatedPageContextIds).toEqual(['ctx:1', 'ctx:2']);
    expect(mgr.needsServiceRebuild).toBe(true);
  });

  it('keeps the pinned company: a reset is not a company change', async () => {
    // The replacement session must come back ON the pinned company, as BC does: the
    // company is bound at OpenSession, which is why create() receives it.
    const { mgr, factory } = await managerWithLiveSession(
      mockSession(),
      mockSession('JBC SOLDERING JAPAN CO., LTD.', 0, 0),
    );
    mgr.rememberCompany('JBC SOLDERING JAPAN CO., LTD.');
    await mgr.resetSession();
    expect(factory.create).toHaveBeenLastCalledWith('JBC SOLDERING JAPAN CO., LTD.');
    expect(mgr.pinnedCompany).toBe('JBC SOLDERING JAPAN CO., LTD.');
  });

  it('falls back to an abrupt close when the graceful one fails', async () => {
    const wedged = mockSession();
    wedged.closeGracefully = vi.fn(async () => { throw new Error('stuck behind a modal'); });
    const { mgr } = await managerWithLiveSession(wedged);
    await mgr.resetSession();
    expect(wedged.close).toHaveBeenCalled();
    expect(mgr.currentSession).not.toBe(wedged);
  });

  it('works with no session at all (nothing to tear down)', async () => {
    const repo = mockRepo();
    const fresh = mockSession('CRONUS ES', 0, 0);
    const factory = { create: vi.fn(async () => ok(fresh)) };
    const mgr = new TestSessionManager(factory as never, repo as never, mockLogger() as never);
    const r = await mgr.resetSession();
    expect(r.previousOpenForms).toBe(0);
    expect(mgr.currentSession).toBe(fresh);
  });

  it('throws — never reports success — when the new session cannot be opened', async () => {
    const repo = mockRepo();
    const factory = { create: vi.fn(async () => err(new ConnectionError('connection refused'))) };
    const mgr = new TestSessionManager(factory as never, repo as never, mockLogger() as never, { maxRetries: 1, baseDelayMs: 0 });
    await expect(mgr.resetSession()).rejects.toThrow();
  });
});

describe('ResetSessionOperation', () => {
  it('maps the manager result to the tool output', async () => {
    const op = new ResetSessionOperation(async () => ({
      previousCompany: 'A', newCompany: 'A',
      invalidatedPageContextIds: ['ctx:1'],
      previousOpenForms: 19, previousModalDepth: 3,
    }), mockLogger() as never);
    const r = await op.execute({});
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.value).toMatchObject({
        success: true, newCompany: 'A',
        droppedOpenForms: 19, droppedModalDepth: 3,
        invalidatedPageContextIds: ['ctx:1'],
      });
    }
  });

  it('propagates a failure instead of returning a success-shaped result', async () => {
    const op = new ResetSessionOperation(async () => { throw new Error('BC unreachable'); }, mockLogger() as never);
    await expect(op.execute({})).rejects.toThrow('BC unreachable');
  });
});

describe('bc_reset_session tool', () => {
  it('is registered and takes no parameters', () => {
    const tool = buildResetSessionTool(async () => ({
      previousCompany: 'A', newCompany: 'A', invalidatedPageContextIds: [],
      previousOpenForms: 0, previousModalDepth: 0,
    }), mockLogger() as never);
    expect(tool.name).toBe('bc_reset_session');
    expect(tool.description).toMatch(/modal/i);
    expect((tool.inputSchema as { properties?: object }).properties ?? {}).toEqual({});
  });

  it('does not go through the session gate: it runs on a dead session', async () => {
    // The gate (ensureSession -> getSession) THROWS SessionLostError when the session
    // is dead. A reset routed through it would be unavailable exactly when needed.
    let ran = false;
    const tool = buildResetSessionTool(async () => {
      ran = true;
      return { previousCompany: 'A', newCompany: 'A', invalidatedPageContextIds: [], previousOpenForms: 0, previousModalDepth: 0 };
    }, mockLogger() as never);
    await tool.execute({});
    expect(ran).toBe(true);
  });
});
