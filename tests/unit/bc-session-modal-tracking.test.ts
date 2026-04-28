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

    // Stub invoke -- simulate BC closing the modal we just aborted.
    (s as any).invoke = vi.fn(async (interaction: any) => {
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

  it('force-pops if BC does NOT emit FormClosed for the aborted modal', async () => {
    const s = new ReconcileProbe();
    s.feed([{ type: 'DialogOpened', formId: 'M1', controlTree: {} }]);
    (s as any).invoke = vi.fn(async () => ok([])); // Abort succeeds but BC doesn't close
    const result = await s.reconcile();
    expect(result.ok).toBe(true);
    expect(s.stack()).toEqual([]); // force-popped
  });

  it('returns ok with empty stack', async () => {
    const s = new ReconcileProbe();
    (s as any).invoke = vi.fn();
    const result = await s.reconcile();
    expect(result.ok).toBe(true);
    expect((s as any).invoke).not.toHaveBeenCalled();
  });
});
