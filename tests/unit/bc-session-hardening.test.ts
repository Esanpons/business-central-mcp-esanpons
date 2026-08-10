// Regression cover for the BCSession hardening:
//   - async Message frames are delivered ONCE, even with a nested invoke
//   - a failed license auto-dismiss keeps the dialog tracked
//   - runReport omits `&tenant=` on SaaS
import { describe, it, expect, vi } from 'vitest';
import { gzipSync } from 'node:zlib';
import { BCSession } from '../../src/session/bc-session.js';
import { ok, err } from '../../src/core/result.js';
import { ProtocolError } from '../../src/core/errors.js';
import type { BCEvent } from '../../src/protocol/types.js';

const silentLogger = { info() {}, warn() {}, error() {}, debug() {} };

/** WS double that can push an async `Message` frame to its subscribers. */
function fakeWs() {
  const handlers: Array<(raw: unknown) => void> = [];
  return {
    isConnected: true,
    spaInstanceId: 'spa',
    nextSequenceNo: 1,
    lastClientAckSequenceNumber: 0,
    sent: [] as Array<{ method: string; params: unknown[] }>,
    sendRpc: vi.fn(async function (this: any, method: string, params: unknown[]) {
      this.sent.push({ method, params });
      return ok([]);
    }),
    onMessage(h: (raw: unknown) => void) {
      handlers.push(h);
      return () => {
        const ix = handlers.indexOf(h);
        if (ix >= 0) handlers.splice(ix, 1);
      };
    },
    emitAsync(): void {
      // Same shape BC pushes: gzip+base64 handler array.
      const compressedData = gzipSync(Buffer.from(JSON.stringify([{ Type: 'x' }]), 'utf8')).toString('base64');
      const frame = { method: 'Message', params: [{ compressedData }] };
      for (const h of [...handlers]) h(frame);
    },
    handlerCount: () => handlers.length,
    close: vi.fn(),
    forceClose: vi.fn(),
  };
}

const encoder = {
  encode: () => ({ method: 'Invoke', params: [{}] }),
  encodeOpenSession: () => ({ method: 'OpenSession', params: [{}] }),
} as never;

describe('BCSession async-event collectors', () => {
  it('delivers an async frame to the innermost collector only (no duplicates)', async () => {
    // Two collectors are active at once whenever an invoke nests another invoke
    // (modal reconcile, license auto-dismiss). Both used to decode the SAME frame,
    // so the caller received every async event twice -- duplicated DataLoaded
    // means duplicated rows.
    const ws = fakeWs();
    const decoder = { decode: vi.fn(() => [{ type: 'DataLoaded', formId: 'F1' } as unknown as BCEvent]) };
    const session = new BCSession(ws as never, decoder as never, encoder, silentLogger as never, 'default', 1000);

    const outer: BCEvent[] = [];
    const inner: BCEvent[] = [];
    const releaseOuter = (session as unknown as { collectAsyncMessages(s: BCEvent[]): () => void })
      .collectAsyncMessages(outer);
    const releaseInner = (session as unknown as { collectAsyncMessages(s: BCEvent[]): () => void })
      .collectAsyncMessages(inner);

    ws.emitAsync();
    expect(inner).toHaveLength(1);
    expect(outer).toHaveLength(0);

    // Once the nested invoke finishes, the outer collector resumes receiving.
    releaseInner();
    ws.emitAsync();
    expect(outer).toHaveLength(1);
    expect(inner).toHaveLength(1);

    releaseOuter();
    expect(ws.handlerCount()).toBe(0);
  });

  it('unsubscribing twice is a no-op and does not unregister another collector', () => {
    const ws = fakeWs();
    const decoder = { decode: vi.fn(() => [] as BCEvent[]) };
    const session = new BCSession(ws as never, decoder as never, encoder, silentLogger as never, 'default', 1000);
    const collect = (session as unknown as { collectAsyncMessages(s: BCEvent[]): () => void }).collectAsyncMessages.bind(session);

    const a: BCEvent[] = [];
    const b: BCEvent[] = [];
    const releaseA = collect(a);
    const releaseB = collect(b);
    releaseB();
    releaseB();
    expect(ws.handlerCount()).toBe(1);
    releaseA();
    expect(ws.handlerCount()).toBe(0);
  });
});

describe('BCSession license dialog auto-dismiss', () => {
  function sessionWithLicenseDialog(dismissOk: boolean) {
    const ws = fakeWs();
    const dialog = {
      type: 'DialogOpened',
      formId: 'LIC',
      controlTree: { Caption: 'Your evaluation license expires soon' },
    } as unknown as BCEvent;
    const decoder = { decode: vi.fn(() => [dialog]) };
    const session = new BCSession(ws as never, decoder as never, encoder, silentLogger as never, 'default', 1000);
    if (!dismissOk) {
      // `invoke` returns a Result, it never throws -- the old try/catch could not
      // see this failure at all.
      (session as unknown as { invoke: unknown }).invoke = async () => err(new ProtocolError('BC refused Ok'));
    } else {
      (session as unknown as { invoke: unknown }).invoke = async () => ok([]);
    }
    return { ws, session };
  }

  it('drops the dialog from tracking when the dismiss succeeds', async () => {
    const { session } = sessionWithLicenseDialog(true);
    await session.initialize('default');
    expect(session.openFormIds.has('LIC')).toBe(false);
    expect(session.modalStackSnapshot()).toEqual([]);
  });

  it('KEEPS the dialog tracked when the dismiss fails, so reconcile can close it', async () => {
    const { session } = sessionWithLicenseDialog(false);
    const result = await session.initialize('default');
    expect(result.ok).toBe(true); // init still succeeds
    expect(session.openFormIds.has('LIC')).toBe(true);
    expect(session.modalStackSnapshot()).toEqual(['LIC']);
  });
});

describe('BCSession.runReport tenant parameter', () => {
  it('sends &tenant= on-prem', async () => {
    const ws = fakeWs();
    const captured: string[] = [];
    const session = new BCSession(
      ws as never,
      { decode: () => [] } as never,
      { encode: (i: { query?: string }) => { captured.push(i.query ?? ''); return { method: 'Invoke', params: [] }; }, encodeOpenSession: () => ({ method: '', params: [] }) } as never,
      silentLogger as never,
      'default',
      1000,
    );
    await session.runReport(6);
    expect(captured[0]).toBe('report=6&tenant=default');
  });

  it('omits &tenant= in AAD/SaaS mode (the tenant is bound at session open)', async () => {
    const ws = fakeWs();
    const captured: string[] = [];
    const session = new BCSession(
      ws as never,
      { decode: () => [] } as never,
      { encode: (i: { query?: string }) => { captured.push(i.query ?? ''); return { method: 'Invoke', params: [] }; }, encodeOpenSession: () => ({ method: '', params: [] }) } as never,
      silentLogger as never,
      'backend-tenant',
      1000,
      '',
      true, // omitTenantInQueries
    );
    await session.runReport(6);
    expect(captured[0]).toBe('report=6');
  });
});
