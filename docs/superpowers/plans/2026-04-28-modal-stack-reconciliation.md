# Modal-Stack Reconciliation Plan (limits.md #4)

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** When BC's server returns `LogicalModalityViolationException` mid-session (because an orphaned modal is open server-side), reconcile by aborting the topmost stale modal(s) and retrying the original interaction once. Avoid the current workaround (kill the session, reconnect, force the caller to re-open every page). Page contexts survive recovery; the caller sees the operation succeed transparently.

**Architecture:** `BCSession` already tracks `_openFormIds`. Add a parallel ordered `modalStack: string[]` updated from `DialogOpened` (push) and `FormClosed` (pop). On a JSON-RPC error matching `LogicalModalityViolationException`, the invoke wrapper:
1. Calls `reconcileModalStack()` which sends `InvokeAction { systemAction: 320 (Abort), formId, controlPath: 'server:' }` to each modal in stack from top to bottom (max-N attempts).
2. Re-executes the original interaction once.
3. If still violation, falls through to the existing dead-session path so SessionManager handles it.

The decompiled source (`Microsoft.Dynamics.Framework.UI.LogicalModalityVerifier`, `LogicalDispatcherFrame.ModalForm`) confirms BC's server-side modal stack model — Abort on the topmost frame is the canonical close.

**Tech Stack:** TypeScript (ESM, strict), Vitest. No new dependencies.

**Pre-flight:** Work in a dedicated worktree branched off master after the section-first-class plan has merged (so `bc-session.ts` lands stable). Run `npx tsc --noEmit && npx vitest run` and confirm green.

---

## File Structure

### New files
- `src/session/modal-stack.ts` — small ordered structure with `push/pop/peek/size/snapshot`, isolated for testability
- `tests/unit/modal-stack.test.ts` — unit tests for the stack
- `tests/unit/bc-session-modal-recovery.test.ts` — fakes the WS layer, drives a synthetic violation+recover scenario
- `tests/integration/modal-recovery.test.ts` — live BC scenario (only runs in integration config)

### Modified files
- `src/session/bc-session.ts` — own a `ModalStack`, update on every event batch, intercept `LogicalModalityViolationException` in `invokeInternal`, expose `modalStackSnapshot()` for tests
- `src/protocol/page-context-repo.ts` — invalidate any page whose `rootFormId` is on the just-closed modal stack (modal-rooted pages become unusable)
- `src/core/errors.ts` — add `ModalReconcileError` for the rare case both reconciliation attempts fail
- `tests/protocol/page-context-repo-modal.test.ts` — extend with a section-invalidation case if needed

---

## Conventions for every task

- Use `npx vitest run <path>` for narrow runs, `npx vitest run tests/unit tests/protocol` for the unit/protocol sweep
- After each task: typecheck (`npx tsc --noEmit`), narrow test (must pass), full unit/protocol sweep (must pass)
- Integration test runs only at Task 8
- ESM imports include `.js` extension
- Commit message format: `feat:` for new behaviour, `refactor:` for shape moves

---

## Task 1: ModalStack utility

**Files:**
- Create: `src/session/modal-stack.ts`
- Create: `tests/unit/modal-stack.test.ts`

- [ ] **Step 1: Write the failing test**

Create `tests/unit/modal-stack.test.ts`:

```typescript
// tests/unit/modal-stack.test.ts
import { describe, it, expect } from 'vitest';
import { ModalStack } from '../../src/session/modal-stack.js';

describe('ModalStack', () => {
  it('push and peek return LIFO order', () => {
    const s = new ModalStack();
    s.push('a');
    s.push('b');
    expect(s.peek()).toBe('b');
    expect(s.size).toBe(2);
  });

  it('pop returns and removes the topmost id', () => {
    const s = new ModalStack();
    s.push('a');
    s.push('b');
    expect(s.pop()).toBe('b');
    expect(s.peek()).toBe('a');
    expect(s.size).toBe(1);
  });

  it('remove deletes an arbitrary id without disturbing order', () => {
    const s = new ModalStack();
    s.push('a');
    s.push('b');
    s.push('c');
    s.remove('b');
    expect(s.snapshot()).toEqual(['a', 'c']);
  });

  it('push deduplicates an already-tracked id', () => {
    const s = new ModalStack();
    s.push('a');
    s.push('a');
    expect(s.snapshot()).toEqual(['a']);
  });

  it('snapshot returns a defensive copy', () => {
    const s = new ModalStack();
    s.push('a');
    const snap = s.snapshot();
    snap.push('b');
    expect(s.snapshot()).toEqual(['a']);
  });

  it('clear empties the stack', () => {
    const s = new ModalStack();
    s.push('a');
    s.clear();
    expect(s.size).toBe(0);
    expect(s.peek()).toBeUndefined();
  });
});
```

- [ ] **Step 2: Run, expect failure**

Run: `npx vitest run tests/unit/modal-stack.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement the stack**

Create `src/session/modal-stack.ts`:

```typescript
// src/session/modal-stack.ts
//
// Tracks the open modal-form chain server-side. BC's web server holds a
// LogicalDispatcher.Frames stack (decompiled
// Microsoft.Dynamics.Framework.UI.LogicalDispatcher); to clear an orphaned
// modal we must Abort the topmost frame. The ModalStack mirrors that
// ordering on the client side so reconciliation can walk the stack from top
// to bottom.

export class ModalStack {
  private readonly ids: string[] = [];

  get size(): number {
    return this.ids.length;
  }

  push(formId: string): void {
    if (!formId) return;
    const ix = this.ids.indexOf(formId);
    if (ix >= 0) return; // dedupe — DialogOpened may fire twice in some envs
    this.ids.push(formId);
  }

  pop(): string | undefined {
    return this.ids.pop();
  }

  peek(): string | undefined {
    return this.ids[this.ids.length - 1];
  }

  remove(formId: string): void {
    const ix = this.ids.indexOf(formId);
    if (ix >= 0) this.ids.splice(ix, 1);
  }

  clear(): void {
    this.ids.length = 0;
  }

  snapshot(): string[] {
    return [...this.ids];
  }
}
```

- [ ] **Step 4: Run tests, expect pass**

Run: `npx vitest run tests/unit/modal-stack.test.ts`
Expected: PASS, 6 tests.

- [ ] **Step 5: Typecheck**

Run: `npx tsc --noEmit`
Expected: no errors.

- [ ] **Step 6: Commit**

```bash
git add src/session/modal-stack.ts tests/unit/modal-stack.test.ts
git commit -m "feat: add ModalStack utility for session-level modal tracking"
```

---

## Task 2: ModalReconcileError

**Files:**
- Modify: `src/core/errors.ts`

- [ ] **Step 1: Locate the existing error classes**

Read `src/core/errors.ts` to confirm the pattern (existing classes: ProtocolError, ConnectionError, SessionLostError, TimeoutError).

- [ ] **Step 2: Add the new error class**

Append to `src/core/errors.ts`:

```typescript
/**
 * Thrown when bc-mcp detected a `LogicalModalityViolationException` and the
 * automatic modal-stack reconciliation could not clear it (Abort failed, or
 * the violation persisted after retry). The session is killed and recreated
 * by the SessionManager — page contexts are invalidated, callers must re-open
 * any pages.
 */
export class ModalReconcileError extends ProtocolError {
  constructor(message: string, context?: Record<string, unknown>) {
    super(message, context);
    this.name = 'ModalReconcileError';
  }
}
```

- [ ] **Step 3: Typecheck**

Run: `npx tsc --noEmit`
Expected: no errors.

- [ ] **Step 4: Commit**

```bash
git add src/core/errors.ts
git commit -m "feat: add ModalReconcileError"
```

---

## Task 3: Maintain modalStack from event stream

**Files:**
- Modify: `src/session/bc-session.ts`

- [ ] **Step 1: Add `modalStack` to BCSession and update tracking**

In `src/session/bc-session.ts`:

Add the import at the top of the file:

```typescript
import { ModalStack } from './modal-stack.js';
```

Inside `class BCSession`, add an instance member alongside `_openFormIds`:

```typescript
  private readonly modalStack = new ModalStack();
```

Replace the existing `updateFormTracking` method body with:

```typescript
  private updateFormTracking(events: BCEvent[]): void {
    for (const event of events) {
      if (event.type === 'FormCreated' && event.formId) {
        this._openFormIds.add(event.formId);
        // Non-modal: do not push onto modalStack
      }
      if (event.type === 'DialogOpened' && event.formId) {
        this._openFormIds.add(event.formId);
        this.modalStack.push(event.formId);
      }
      if (event.type === 'FormClosed' && event.formId) {
        this._openFormIds.delete(event.formId);
        this.modalStack.remove(event.formId);
      }
    }
  }
```

Add a test seam below the existing `removeOpenForm` method:

```typescript
  /** Test seam: snapshot of the current modal stack (top-most last). */
  modalStackSnapshot(): string[] {
    return this.modalStack.snapshot();
  }
```

In `removeOpenForm`, also remove from the modal stack:

```typescript
  removeOpenForm(formId: string): void {
    this._openFormIds.delete(formId);
    this.modalStack.remove(formId);
  }
```

- [ ] **Step 2: Add a unit test for stack updates**

Create `tests/unit/bc-session-modal-recovery.test.ts`:

```typescript
// tests/unit/bc-session-modal-recovery.test.ts
import { describe, it, expect } from 'vitest';
import type { BCEvent } from '../../src/protocol/types.js';

// Minimal BCSession-shaped harness: reach into private updateFormTracking via
// a thin extension class so we can drive the event-tracking pure function in
// isolation without standing up a WebSocket.
import { BCSession } from '../../src/session/bc-session.js';
import { ModalStack } from '../../src/session/modal-stack.js';

class TrackingProbe extends (BCSession as any) {
  constructor() {
    super(
      { isConnected: true, sendRpc: async () => ({ ok: true, value: [] }), close: () => {}, onMessage: () => () => {}, spaInstanceId: '', nextSequenceNo: 1, lastClientAckSequenceNumber: 0 },
      { decode: () => [] },
      { encode: () => ({ method: '', params: [] }), encodeOpenSession: () => ({ method: '', params: [] }) },
      { info() {}, debug() {}, warn() {}, error() {} },
      'default',
      30000,
    );
  }
  feed(events: BCEvent[]): void {
    (this as any).updateFormTracking(events);
  }
  stack(): string[] {
    return this.modalStackSnapshot();
  }
  open(): string[] {
    return Array.from(this.openFormIds);
  }
}

describe('BCSession modal-stack tracking', () => {
  it('DialogOpened pushes to stack and openFormIds', () => {
    const s = new TrackingProbe();
    s.feed([{ type: 'DialogOpened', formId: 'M1', controlTree: {} }]);
    expect(s.stack()).toEqual(['M1']);
    expect(s.open()).toContain('M1');
  });

  it('FormClosed pops stack and removes from openFormIds', () => {
    const s = new TrackingProbe();
    s.feed([
      { type: 'DialogOpened', formId: 'M1', controlTree: {} },
      { type: 'DialogOpened', formId: 'M2', controlTree: {} },
      { type: 'FormClosed', formId: 'M2' },
    ]);
    expect(s.stack()).toEqual(['M1']);
  });

  it('FormCreated does not affect modal stack', () => {
    const s = new TrackingProbe();
    s.feed([
      { type: 'FormCreated', formId: 'F1', controlTree: {} },
      { type: 'DialogOpened', formId: 'M1', controlTree: {} },
    ]);
    expect(s.stack()).toEqual(['M1']);
    expect(s.open()).toEqual(expect.arrayContaining(['F1', 'M1']));
  });
});
```

- [ ] **Step 3: Run tests, expect pass**

Run: `npx vitest run tests/unit/bc-session-modal-recovery.test.ts`
Expected: PASS, 3 tests.

- [ ] **Step 4: Typecheck**

Run: `npx tsc --noEmit`
Expected: no errors.

- [ ] **Step 5: Commit**

```bash
git add src/session/bc-session.ts tests/unit/bc-session-modal-recovery.test.ts
git commit -m "feat: track BC modal stack from session event stream"
```

---

## Task 4: reconcileModalStack method

**Files:**
- Modify: `src/session/bc-session.ts`

- [ ] **Step 1: Write the failing test for reconciliation order**

Append to `tests/unit/bc-session-modal-recovery.test.ts`:

```typescript
import { describe, it, expect, vi } from 'vitest';
import { ok } from '../../src/core/result.js';

class ReconcileProbe extends (BCSession as any) {
  public sentInteractions: any[] = [];
  constructor() {
    super(
      { isConnected: true, sendRpc: async () => ({ ok: true, value: [] }), close: () => {}, onMessage: () => () => {}, spaInstanceId: '', nextSequenceNo: 1, lastClientAckSequenceNumber: 0 },
      { decode: () => [] },
      { encode: (interaction: any) => { this.sentInteractions.push(interaction); return { method: '', params: [] }; }, encodeOpenSession: () => ({ method: '', params: [] }) },
      { info() {}, debug() {}, warn() {}, error() {} },
      'default',
      30000,
    );
    // Simulate live session
    (this as any)._initialized = true;
  }
  feed(events: any[]): void { (this as any).updateFormTracking(events); }
  stack(): string[] { return this.modalStackSnapshot(); }
  reconcile(): Promise<any> { return (this as any).reconcileModalStack(); }
}

describe('BCSession.reconcileModalStack', () => {
  it('aborts topmost first, then next-down, popping stack each time', async () => {
    const s = new ReconcileProbe();
    s.feed([
      { type: 'DialogOpened', formId: 'M1', controlTree: {} },
      { type: 'DialogOpened', formId: 'M2', controlTree: {} },
    ]);
    expect(s.stack()).toEqual(['M1', 'M2']);

    // Stub the actual invoke path — feed FormClosed in response so the stack pops
    const realInvoke = (s as any).invoke.bind(s);
    (s as any).invoke = vi.fn(async (interaction: any) => {
      // Simulate BC closing the modal we just aborted
      s.feed([{ type: 'FormClosed', formId: interaction.formId }]);
      return ok([]);
    });

    const result = await s.reconcile();
    expect(result.ok).toBe(true);
    expect(s.stack()).toEqual([]);

    const calls = (s as any).invoke.mock.calls.map((c: any[]) => c[0]);
    expect(calls.map((c: any) => c.formId)).toEqual(['M2', 'M1']);
    expect(calls.every((c: any) => c.systemAction === 320)).toBe(true);
  });

  it('returns error if Abort itself fails', async () => {
    const s = new ReconcileProbe();
    s.feed([{ type: 'DialogOpened', formId: 'M1', controlTree: {} }]);
    (s as any).invoke = vi.fn(async () => ({ ok: false, error: { message: 'BOOM' } }));
    const result = await s.reconcile();
    expect(result.ok).toBe(false);
  });
});
```

- [ ] **Step 2: Run, expect failure**

Run: `npx vitest run tests/unit/bc-session-modal-recovery.test.ts -t reconcileModalStack`
Expected: FAIL — `reconcileModalStack is not a function`.

- [ ] **Step 3: Implement reconcileModalStack**

Add to `src/session/bc-session.ts`, near the other public methods (e.g. before `closeGracefully`):

```typescript
  /**
   * Walk the modal stack from top to bottom, sending Abort (SystemAction=320)
   * to each modal until the stack is empty or an Abort fails. After each
   * successful Abort the FormClosed event from the response pops the stack
   * via updateFormTracking. Used to clear stale modal state that produced a
   * `LogicalModalityViolationException`.
   *
   * Reference: decompiled `LogicalModalityVerifier.IsUnderModalForm`, which
   * inspects `LogicalDispatcher.Frames`. SystemAction.Abort=320 closes the
   * topmost frame's ModalForm.
   */
  async reconcileModalStack(): Promise<Result<void, ProtocolError>> {
    const MAX = 10; // safety cap; modal stacks deeper than this indicate a deeper bug
    for (let i = 0; i < MAX && this.modalStack.size > 0; i++) {
      const top = this.modalStack.peek()!;
      const result = await this.invoke(
        { type: 'InvokeAction', formId: top, controlPath: 'server:', systemAction: 320 } as BCInteraction,
        (event) => event.type === 'InvokeCompleted',
      );
      if (isErr(result)) {
        return err(new ProtocolError(`reconcileModalStack: Abort on formId=${top} failed: ${result.error.message}`));
      }
      // If BC didn't emit FormClosed for this formId, force-pop to make progress.
      if (this.modalStack.peek() === top) {
        this.modalStack.pop();
        this._openFormIds.delete(top);
      }
    }
    if (this.modalStack.size > 0) {
      return err(new ProtocolError(`reconcileModalStack: stack still has ${this.modalStack.size} entries after ${MAX} attempts`));
    }
    return ok(undefined);
  }
```

- [ ] **Step 4: Run tests, expect pass**

Run: `npx vitest run tests/unit/bc-session-modal-recovery.test.ts`
Expected: PASS, all tests.

- [ ] **Step 5: Typecheck**

Run: `npx tsc --noEmit`
Expected: no errors.

- [ ] **Step 6: Commit**

```bash
git add src/session/bc-session.ts tests/unit/bc-session-modal-recovery.test.ts
git commit -m "feat: implement reconcileModalStack with top-down Abort"
```

---

## Task 5: Auto-recovery on LogicalModalityViolation

**Files:**
- Modify: `src/session/bc-session.ts`

- [ ] **Step 1: Write the failing integration-style unit test**

Append to `tests/unit/bc-session-modal-recovery.test.ts`:

```typescript
describe('BCSession invoke with auto-recovery', () => {
  it('retries once after reconcileModalStack on LogicalModalityViolation', async () => {
    const s = new ReconcileProbe();
    s.feed([{ type: 'DialogOpened', formId: 'M1', controlTree: {} }]);

    // First sendRpc returns the violation; second returns success
    let callCount = 0;
    (s as any).ws.sendRpc = vi.fn(async () => {
      callCount += 1;
      if (callCount === 1) {
        return { ok: false, error: { message: 'LogicalModalityViolationException: There is a dialog open' } };
      }
      return { ok: true, value: [] };
    });

    // Stub reconcileModalStack to succeed and pop the stack
    (s as any).reconcileModalStack = vi.fn(async () => {
      s.feed([{ type: 'FormClosed', formId: 'M1' }]);
      return ok(undefined);
    });

    const result = await s.invoke(
      { type: 'OpenForm', query: 'page=22&tenant=default' } as any,
      () => true,
    );
    expect(result.ok).toBe(true);
    expect(callCount).toBe(2);
    expect((s as any).reconcileModalStack).toHaveBeenCalledTimes(1);
  });

  it('marks session dead and returns ModalReconcileError when retry fails again', async () => {
    const s = new ReconcileProbe();
    s.feed([{ type: 'DialogOpened', formId: 'M1', controlTree: {} }]);

    (s as any).ws.sendRpc = vi.fn(async () => ({
      ok: false, error: { message: 'LogicalModalityViolationException: persistent' },
    }));
    (s as any).reconcileModalStack = vi.fn(async () => ok(undefined));

    const result = await s.invoke(
      { type: 'OpenForm', query: 'page=22&tenant=default' } as any,
      () => true,
    );
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.name).toBe('ModalReconcileError');
    }
    expect((s as any).dead).toBe(true);
  });
});
```

- [ ] **Step 2: Run, expect failure**

Run: `npx vitest run tests/unit/bc-session-modal-recovery.test.ts -t auto-recovery`
Expected: FAIL — invoke does not retry today.

- [ ] **Step 3: Add the recovery branch to invokeInternal**

In `src/session/bc-session.ts`, modify the post-`sendRpc` error block (currently around lines 200-209). Replace:

```typescript
      if (isErr(rpcResult)) {
        // Check for fatal session errors:
        // - InvalidSessionException in the message text
        // - JSON-RPC error code 1 (InvalidSession) regardless of exception type
        const msg = rpcResult.error.message;
        if (msg.includes('InvalidSessionException') || msg.includes('"code":1')) {
          this.markDead();
        }
        return rpcResult;
      }
```

With:

```typescript
      if (isErr(rpcResult)) {
        const msg = rpcResult.error.message;
        if (msg.includes('InvalidSessionException') || msg.includes('"code":1')) {
          this.markDead();
          return rpcResult;
        }
        if (msg.includes('LogicalModalityViolationException')) {
          // Stale modal — try to reconcile then retry once
          this.logger.warn(`LogicalModalityViolation detected, reconciling modal stack (size=${this.modalStack.size})`);
          const reconcile = await this.reconcileModalStack();
          if (isErr(reconcile)) {
            this.markDead();
            return err(new ModalReconcileError(`Modal reconciliation failed: ${reconcile.error.message}`, { originalError: msg }));
          }
          // Re-encode + resend with current sequence numbers
          const retryContext: EncodeContext = {
            callbackId,
            sequenceNo: this.ws.nextSequenceNo,
            lastClientAckSequenceNumber: this.ws.lastClientAckSequenceNumber,
            openFormIds: this._openFormIds,
            session: { sessionId: this.sessionId, sessionKey: this.sessionKey, company: this.company, tenantId: this.tenantId, spaInstanceId: this.ws.spaInstanceId },
          };
          const retryEncoded = this.encoder.encode(interaction, retryContext);
          const retryRpc = await this.ws.sendRpc(retryEncoded.method, retryEncoded.params, timeoutMs);
          if (isErr(retryRpc)) {
            this.markDead();
            return err(new ModalReconcileError(`Retry after modal reconcile still failed: ${retryRpc.error.message}`, { originalError: msg }));
          }
          if (Array.isArray(retryRpc.value)) {
            allEvents.push(...this.decoder.decode(retryRpc.value));
          }
          // fall through into the normal post-success path
        } else {
          return rpcResult;
        }
      } else {
        const responseData = rpcResult.value;
        if (Array.isArray(responseData)) {
          allEvents.push(...this.decoder.decode(responseData));
        }
      }
```

You will also need to remove the existing `responseData`/decode block lower in the same function (it has been moved into the `else` branch above) — locate the block at lines ~211-215 and delete it.

Add the import for `ModalReconcileError` near the top of the file:

```typescript
import { ProtocolError, TimeoutError, ModalReconcileError } from '../core/errors.js';
```

- [ ] **Step 4: Run all unit tests**

Run: `npx vitest run tests/unit`
Expected: PASS, including the two new auto-recovery cases.

- [ ] **Step 5: Run full unit/protocol sweep**

Run: `npx vitest run tests/unit tests/protocol`
Expected: PASS.

- [ ] **Step 6: Typecheck**

Run: `npx tsc --noEmit`
Expected: no errors.

- [ ] **Step 7: Commit**

```bash
git add src/session/bc-session.ts tests/unit/bc-session-modal-recovery.test.ts
git commit -m "feat: auto-reconcile modal stack on LogicalModalityViolation"
```

---

## Task 6: Invalidate modal-rooted page contexts on Abort

**Files:**
- Modify: `src/protocol/page-context-repo.ts`
- Modify: `tests/protocol/page-context-repo-modal.test.ts`

- [ ] **Step 1: Write the failing test**

Append to `tests/protocol/page-context-repo-modal.test.ts`:

```typescript
it('marks isModal page contexts invalid when their root form is closed', () => {
  const repo = new PageContextRepository(new FormProjection(), new SectionResolver());
  // Create a modal-rooted page
  repo.create('pc:modal', 'M1', { isModal: true, wizardState: null });
  expect(repo.get('pc:modal')).toBeDefined();
  // BC closes M1
  repo.applyToPage('pc:modal', [{ type: 'FormClosed', formId: 'M1' }]);
  // The page context should mark its sections invalid (or remove itself entirely)
  const ctx = repo.get('pc:modal');
  if (ctx) {
    for (const sec of ctx.sections.values()) {
      expect(sec.valid).toBe(false);
    }
  }
});
```

- [ ] **Step 2: Run, expect pass or fail; if it already passes, skip ahead**

Run: `npx vitest run tests/protocol/page-context-repo-modal.test.ts`

If the existing `markFormClosed` (page-context-repo.ts:302) already invalidates sections referencing a closed root form, this test passes — confirm and move on.

If it fails, extend `markFormClosed` so that when the closed `formId` equals a page's `rootFormId` AND the page `isModal`, every section in the page is marked invalid. Use the same pattern already employed elsewhere in the file (`new Map(page.sections); sections.set(...);`).

- [ ] **Step 3: Run unit/protocol sweep**

Run: `npx vitest run tests/unit tests/protocol`
Expected: PASS.

- [ ] **Step 4: Commit**

```bash
git add tests/protocol/page-context-repo-modal.test.ts src/protocol/page-context-repo.ts
git commit -m "feat: invalidate modal-rooted pages when their form closes"
```

---

## Task 7: Drop dead-session retry on LogicalModalityViolation in SessionManager

The previous fallback in `session-manager.ts:144` retried `LogicalModalityViolationException` only during initial `createWithBackoff`. With Task 5 in place, mid-session violations are reconciled on the live session and never reach SessionManager unless the session is genuinely dead.

**Files:**
- Modify: `src/session/session-manager.ts`

- [ ] **Step 1: Update the log message and keep the retry behaviour**

In `session-manager.ts` lines 144-148, change to:

```typescript
      if (errorMsg.includes('LogicalModalityViolation')) {
        this.logger.warn(`LogicalModalityViolation during initial connect (NTLM slot held by previous session?), attempt ${attempt + 1}: ${errorMsg}`);
      } else {
        this.logger.warn(`Session create failed on attempt ${attempt + 1}: ${errorMsg}`);
      }
```

- [ ] **Step 2: Run unit tests**

Run: `npx vitest run tests/unit/session-manager.test.ts tests/unit/session-reconnect.test.ts`
Expected: PASS.

- [ ] **Step 3: Commit**

```bash
git add src/session/session-manager.ts
git commit -m "docs: clarify SessionManager handles only initial-connect modal violations"
```

---

## Task 8: Live integration test against BC

**Files:**
- Create: `tests/integration/modal-recovery.test.ts`

- [ ] **Step 1: Write the integration test**

Create `tests/integration/modal-recovery.test.ts`:

```typescript
// tests/integration/modal-recovery.test.ts
//
// End-to-end test for limits.md #4: orphaned modal recovery.
// Steps: open a posted Sales Invoice list, run Send/Print which spawns a Send
// Document dialog; we explicitly do NOT respond. The next bc-mcp call must
// transparently reconcile the stale modal and succeed.

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { createTestSession } from './helpers/session.js';

describe('Modal stack reconciliation', () => {
  let session: Awaited<ReturnType<typeof createTestSession>>;

  beforeAll(async () => {
    session = await createTestSession();
  });

  afterAll(async () => {
    await session.close();
  });

  it('recovers transparently when the Send Document dialog is left open', async () => {
    // Open Posted Sales Invoices (page 143)
    const list = await session.openPage(143);
    expect(list.ok).toBe(true);
    if (!list.ok) return;

    // Read first row's bookmark
    const headerSection = list.value.sections.find(s => s.kind === 'header');
    const bookmark = headerSection?.rows?.[0]?.bookmark;
    if (!bookmark) {
      // Skip if env has no posted invoices
      console.warn('No posted invoices in env — skipping');
      return;
    }

    // Drill into the invoice
    const inv = await session.navigate(list.value.pageContextId, bookmark, 'drill_down');
    expect(inv.ok).toBe(true);

    // Trigger Send/Print — spawns a dialog that we INTENTIONALLY leave open
    if (inv.ok) {
      await session.executeAction(inv.value.targetPageContextId!, 'Send');
      // Do not respond to the dialog
    }

    // Modal should be on the stack now
    expect(session.bcSession.modalStackSnapshot().length).toBeGreaterThan(0);

    // Next call should reconcile silently
    const list2 = await session.openPage(22); // Customer List as a fresh open
    expect(list2.ok).toBe(true);

    // Stack should be clear now
    expect(session.bcSession.modalStackSnapshot()).toEqual([]);
  }, 60000);
});
```

- [ ] **Step 2: Add a `bcSession` accessor to the session helper**

If `tests/integration/helpers/session.ts` does not expose the underlying `BCSession`, add a getter so the assertion above works:

```typescript
get bcSession() { return this._bcSession; }
```

- [ ] **Step 3: Run the integration test**

Run: `npx vitest run --config vitest.integration.config.ts tests/integration/modal-recovery.test.ts`
Expected: PASS against a live BC27 environment (with at least one posted invoice).

- [ ] **Step 4: Run the full integration sweep**

Run: `npx vitest run --config vitest.integration.config.ts`
Expected: all pass; no regression.

- [ ] **Step 5: Commit**

```bash
git add tests/integration/modal-recovery.test.ts tests/integration/helpers/session.ts
git commit -m "test: live modal-recovery integration scenario"
```

---

## Task 9: Documentation

**Files:**
- Modify: `README.md` (or `CLAUDE.md` "Known Limitations" if a Limitations section exists)

- [ ] **Step 1: Replace the "Modal dialog left open" entry in `limits.md`**

Edit `limits.md` section "## 4. Modal dialog left open server-side persists across MCP calls". Replace its body with a brief note that the limitation is fixed via auto-reconciliation, leaving the symptom and the (now-historical) repro intact for context. Add a link/reference to the new flow in `bc-session.ts.invokeInternal` and `reconcileModalStack`.

Example replacement for the "Workaround" and "Fix candidate" sections:

```markdown
**Status (resolved 2026-04-XX)**

bc-mcp now auto-reconciles. On `LogicalModalityViolationException` during an
invoke, the session walks `modalStack` (DialogOpened-pushed, FormClosed-popped),
sends `InvokeAction { systemAction: 320 (Abort) }` to each modal from top to
bottom, then retries the original interaction once. If reconciliation fails,
`ModalReconcileError` is returned and the session is killed (existing
SessionManager recovery applies). Modal-rooted page contexts are invalidated
when their root form closes.

Reference: `src/session/bc-session.ts` — `reconcileModalStack`,
`invokeInternal` violation branch.
```

- [ ] **Step 2: Commit**

```bash
git add limits.md
git commit -m "docs: limits.md #4 fixed via modal-stack reconciliation"
```

---

## Self-review checklist

- [ ] Spec coverage:
  - Symptom: `LogicalModalityViolationException` on every call → handled by `invokeInternal` violation branch (Task 5)
  - Workaround: "Restart Claude Code session" → no longer needed; session survives
  - Fix candidate (a) "explicitly send the close-modal sequence" → exactly what `reconcileModalStack` does
  - Fix candidate (b) "tear down the WS session and create a brand new one" → still the fallback when reconcile itself fails (preserved via `markDead()` + `ModalReconcileError`)
- [ ] No placeholders, no "TBD", no "implement later"
- [ ] Type names consistent (`ModalStack`, `reconcileModalStack`, `ModalReconcileError`) used identically across files
- [ ] Each task ends with a commit
- [ ] Every code step shows the actual code
- [ ] Tests precede implementation in every behaviour-introducing task
