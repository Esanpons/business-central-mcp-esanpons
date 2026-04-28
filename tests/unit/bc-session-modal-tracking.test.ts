// tests/unit/bc-session-modal-tracking.test.ts
import { describe, it, expect } from 'vitest';
import type { BCEvent } from '../../src/protocol/types.js';
import { BCSession } from '../../src/session/bc-session.js';

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
