// tests/unit/bc-session-modal-tracking.test.ts
import { describe, it, expect, vi } from 'vitest';
import type { BCEvent } from '../../src/protocol/types.js';
import { BCSession } from '../../src/session/bc-session.js';
import { ok } from '../../src/core/result.js';

class TrackingProbe extends (BCSession as any) {
  constructor() {
    super(
      {
        isConnected: true,
        sendRpc: async () => ({ ok: true, value: [] }),
        close: () => {},
        onMessage: () => () => {},
        spaInstanceId: '',
        nextSequenceNo: 1,
        lastClientAckSequenceNumber: 0,
      },
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

  it('removeOpenForm clears both openFormIds and modalStack', () => {
    const s = new TrackingProbe();
    s.feed([{ type: 'DialogOpened', formId: 'M1', controlTree: {} }]);
    expect(s.stack()).toEqual(['M1']);
    (s as any).removeOpenForm('M1');
    expect(s.stack()).toEqual([]);
    expect(s.open()).not.toContain('M1');
  });
});

class ReconcileProbe extends (BCSession as any) {
  public sentInteractions: any[] = [];
  constructor() {
    super(
      {
        isConnected: true,
        sendRpc: async () => ({ ok: true, value: [] }),
        close: () => {},
        onMessage: () => () => {},
        spaInstanceId: '',
        nextSequenceNo: 1,
        lastClientAckSequenceNumber: 0,
      },
      { decode: () => [] },
      {
        encode: (interaction: any) => {
          this.sentInteractions.push(interaction);
          return { method: '', params: [] };
        },
        encodeOpenSession: () => ({ method: '', params: [] }),
      },
      { info() {}, debug() {}, warn() {}, error() {} },
      'default',
      30000,
    );
    (this as any)._initialized = true;
  }
  feed(events: any[]): void {
    (this as any).updateFormTracking(events);
  }
  stack(): string[] {
    return this.modalStackSnapshot();
  }
  reconcile(): Promise<any> {
    return (this as any).reconcileModalStack();
  }
}

describe('BCSession.reconcileModalStack', () => {
  it('aborts topmost first, then next-down, popping stack each time', async () => {
    const s = new ReconcileProbe();
    s.feed([
      { type: 'DialogOpened', formId: 'M1', controlTree: {} },
      { type: 'DialogOpened', formId: 'M2', controlTree: {} },
    ]);
    expect(s.stack()).toEqual(['M1', 'M2']);

    // Stub invokeUnqueued -- simulate BC closing the modal we just aborted.
    // reconcileModalStack uses invokeUnqueued (queue-bypassing) because it
    // runs inside an already-enqueued task.
    (s as any).invokeUnqueued = vi.fn(async (interaction: any) => {
      s.feed([{ type: 'FormClosed', formId: interaction.formId }]);
      return ok([]);
    });

    const result = await s.reconcile();
    expect(result.ok).toBe(true);
    expect(s.stack()).toEqual([]);

    const calls = (s as any).invokeUnqueued.mock.calls.map((c: any[]) => c[0]);
    expect(calls.map((c: any) => c.formId)).toEqual(['M2', 'M1']);
    // B1: the FIRST answer tried is No=390 — the one a confirm dialog actually
    // accepts. Abort=320 alone left the dialog open server-side and cost a full
    // session reset. One call per dialog here, because No closed it.
    expect(calls.every((c: any) => c.systemAction === 390)).toBe(true);
  });

  it('escalates No -> Cancel -> Abort -> CloseForm until the dialog really closes', async () => {
    const s = new ReconcileProbe();
    s.feed([{ type: 'DialogOpened', formId: 'M1', controlTree: {} }]);

    // BC ignores No and Cancel (the sticky-dialog case), then honours Abort.
    (s as any).invokeUnqueued = vi.fn(async (interaction: any) => {
      if (interaction.type === 'InvokeAction' && interaction.systemAction === 320) {
        s.feed([{ type: 'FormClosed', formId: interaction.formId }]);
      }
      return ok([]);
    });

    const result = await s.reconcile();
    expect(result.ok).toBe(true);
    expect(s.stack()).toEqual([]);

    const sent = (s as any).invokeUnqueued.mock.calls.map((c: any[]) => c[0]);
    expect(sent.map((c: any) => c.systemAction ?? c.type)).toEqual([390, 310, 320]);
  });

  it('falls back to CloseForm when no system answer closes the dialog', async () => {
    const s = new ReconcileProbe();
    s.feed([{ type: 'DialogOpened', formId: 'M1', controlTree: {} }]);

    (s as any).invokeUnqueued = vi.fn(async (interaction: any) => {
      if (interaction.type === 'CloseForm') {
        s.feed([{ type: 'FormClosed', formId: interaction.formId }]);
      }
      return ok([]);
    });

    const result = await s.reconcile();
    expect(result.ok).toBe(true);
    expect(s.stack()).toEqual([]);
    const sent = (s as any).invokeUnqueued.mock.calls.map((c: any[]) => c[0]);
    expect(sent[sent.length - 1].type).toBe('CloseForm');
  });

  it('does not give up on the first rejected answer — it tries the rest, then force-pops', async () => {
    const s = new ReconcileProbe();
    s.feed([{ type: 'DialogOpened', formId: 'M1', controlTree: {} }]);
    // Every answer is refused by BC (and the session stays alive).
    (s as any).invokeUnqueued = vi.fn(async () => ({ ok: false, error: { message: 'BOOM' } }));

    const result = await s.reconcile();
    // The local stack is cleared so the client stays consistent; the caller's next
    // invoke is what discovers whether BC still holds the dialog.
    expect(result.ok).toBe(true);
    expect(s.stack()).toEqual([]);
    expect((s as any).invokeUnqueued.mock.calls.length).toBe(4);
  });

  it('stops immediately when the session dies mid-reconcile', async () => {
    const s = new ReconcileProbe();
    s.feed([{ type: 'DialogOpened', formId: 'M1', controlTree: {} }]);
    (s as any).invokeUnqueued = vi.fn(async () => {
      (s as any).dead = true;
      return { ok: false, error: { message: 'InvalidSessionException' } };
    });
    const result = await s.reconcile();
    expect(result.ok).toBe(false);
  });

  it('force-pops if BC does NOT emit FormClosed for the aborted modal', async () => {
    const s = new ReconcileProbe();
    s.feed([{ type: 'DialogOpened', formId: 'M1', controlTree: {} }]);
    (s as any).invokeUnqueued = vi.fn(async () => ok([])); // Abort succeeds but BC doesn't close
    const result = await s.reconcile();
    expect(result.ok).toBe(true);
    expect(s.stack()).toEqual([]); // force-popped
  });

  it('returns ok with empty stack', async () => {
    const s = new ReconcileProbe();
    (s as any).invokeUnqueued = vi.fn();
    const result = await s.reconcile();
    expect(result.ok).toBe(true);
    expect((s as any).invokeUnqueued).not.toHaveBeenCalled();
  });
});

describe('BCSession invoke with auto-recovery', () => {
  it('retries once after reconcileModalStack on LogicalModalityViolation', async () => {
    const s = new ReconcileProbe();
    s.feed([{ type: 'DialogOpened', formId: 'M1', controlTree: {} }]);

    let callCount = 0;
    (s as any).ws.sendRpc = vi.fn(async () => {
      callCount += 1;
      if (callCount === 1) {
        return { ok: false, error: { message: 'LogicalModalityViolationException: There is a dialog open' } };
      }
      return { ok: true, value: [] };
    });

    (s as any).reconcileModalStack = vi.fn(async () => {
      s.feed([{ type: 'FormClosed', formId: 'M1' }]);
      return ok([{ type: 'FormClosed', formId: 'M1' }]);
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
    (s as any).reconcileModalStack = vi.fn(async () => ok([]));

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

  it('marks session dead with ModalReconcileError when reconciliation itself fails', async () => {
    const s = new ReconcileProbe();
    s.feed([{ type: 'DialogOpened', formId: 'M1', controlTree: {} }]);

    (s as any).ws.sendRpc = vi.fn(async () => ({
      ok: false, error: { message: 'LogicalModalityViolationException: stuck' },
    }));
    (s as any).reconcileModalStack = vi.fn(async () => ({ ok: false, error: { message: 'Abort failed' } }));

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

  it('non-modal-violation errors continue to bubble unchanged', async () => {
    const s = new ReconcileProbe();
    (s as any).ws.sendRpc = vi.fn(async () => ({
      ok: false, error: { message: 'SomeOtherError: random' },
    }));
    (s as any).reconcileModalStack = vi.fn();

    const result = await s.invoke(
      { type: 'OpenForm', query: 'page=22&tenant=default' } as any,
      () => true,
    );
    expect(result.ok).toBe(false);
    expect((s as any).reconcileModalStack).not.toHaveBeenCalled();
  });
});

describe('BCSession fatal-error detection (B4)', () => {
  it('marks the session dead on JSON-RPC code 1', async () => {
    const s = new ReconcileProbe();
    (s as any).ws.sendRpc = vi.fn(async () => ({
      ok: false, error: { message: 'JSON-RPC error: {"code":1,"message":"InvalidSession"}' },
    }));
    const result = await s.invoke({ type: 'OpenForm', query: 'x' } as any, () => true);
    expect(result.ok).toBe(false);
    expect((s as any).dead).toBe(true);
  });

  it('does NOT mark the session dead on code 12 (non-fatal, was a false positive)', async () => {
    const s = new ReconcileProbe();
    (s as any).ws.sendRpc = vi.fn(async () => ({
      ok: false, error: { message: 'JSON-RPC error: {"code":12,"message":"SomeValidation"}' },
    }));
    const result = await s.invoke({ type: 'OpenForm', query: 'x' } as any, () => true);
    expect(result.ok).toBe(false);
    expect((s as any).dead).toBe(false);
  });
});

describe('BCSession invoke + reconcile end-to-end (no stubs)', () => {
  it('completes recovery without deadlocking when reconcileModalStack runs for real', async () => {
    const s = new ReconcileProbe();
    s.feed([{ type: 'DialogOpened', formId: 'M1', controlTree: {} }]);

    let sendCount = 0;
    (s as any).ws.sendRpc = vi.fn(async (_method: string, _params: unknown[]) => {
      sendCount += 1;
      if (sendCount === 1) {
        // First send: original interaction hits modal violation
        return { ok: false, error: { message: 'LogicalModalityViolationException: stale dialog' } };
      }
      if (sendCount === 2) {
        // Second send: the Abort from reconcileModalStack succeeds and BC
        // echoes a FormClosed for M1 (decoder injects it -- see below).
        return { ok: true, value: [] };
      }
      // Third send: the retry of the original interaction.
      return { ok: true, value: [] };
    });

    // Decoder fakes a FormClosed event ONLY on the second sendRpc (the Abort
    // response) so reconcileModalStack pops M1. The first call doesn't reach
    // decode (sendRpc errored), and the third call doesn't need any events.
    (s as any).decoder.decode = vi.fn((_data: unknown) => {
      const decoded: any[] = [];
      if (sendCount === 2) {
        decoded.push({ type: 'FormClosed', formId: 'M1' });
      }
      return decoded;
    });

    // Race the real invoke path against a 5s deadlock-detector. If the
    // promise queue self-deadlocks, the race rejects.
    const result = await Promise.race([
      s.invoke(
        { type: 'OpenForm', query: 'page=22&tenant=default' } as any,
        () => true,
      ),
      new Promise<never>((_, reject) =>
        setTimeout(() => reject(new Error('DEADLOCK: invoke did not complete within 5s')), 5000),
      ),
    ]);

    expect(result.ok).toBe(true);
    expect(sendCount).toBe(3); // original violation + abort + retry
    expect(s.stack()).toEqual([]);
  }, 10000);
});
