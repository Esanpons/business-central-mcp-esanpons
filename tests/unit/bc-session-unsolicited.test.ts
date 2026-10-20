// tests/unit/bc-session-unsolicited.test.ts
//
// bc-saas F-43 / F-45: frames BC pushes while NO invoke is collecting.
//
// Measured live on devel1 (BC27, 2026-10-03): after a row change, BC refreshes every
// FactBox in async `Message` frames that land 10–300 ms AFTER the invoke returned —
// `PropertyChanged { PendingUpdates, Bookmark }` and the new StringValue of each
// factbox field. The invoke had already unsubscribed, so they reached no one and the
// FactBox kept the values of the record it was opened on ("Customer No.=2000001"
// after moving to another customer). The same hole would swallow a dialog that lands
// late, leaving BC with a modal the client does not track.
import { describe, it, expect, vi } from 'vitest';
import { gzipSync } from 'node:zlib';
import { BCSession } from '../../src/session/bc-session.js';
import { EventDecoder } from '../../src/protocol/event-decoder.js';
import { PageContextRepository } from '../../src/protocol/page-context-repo.js';
import { fields as treeFields } from '../../src/protocol/form-views.js';
import { ok } from '../../src/core/result.js';
import type { BCEvent } from '../../src/protocol/types.js';

const silentLogger = { info() {}, warn() {}, error() {}, debug() {} };

function fakeWs() {
  const handlers: Array<(raw: unknown) => void> = [];
  return {
    isConnected: true,
    spaInstanceId: 'spa',
    nextSequenceNo: 1,
    lastClientAckSequenceNumber: 0,
    sendRpc: vi.fn(async () => ok([])),
    onMessage(h: (raw: unknown) => void) {
      handlers.push(h);
      return () => { const ix = handlers.indexOf(h); if (ix >= 0) handlers.splice(ix, 1); };
    },
    /** Push one async frame carrying these BC handlers, exactly as BC does (gzip + base64). */
    push(handlersPayload: unknown[]): void {
      const compressedData = gzipSync(Buffer.from(JSON.stringify(handlersPayload), 'utf8')).toString('base64');
      for (const h of [...handlers]) h({ method: 'Message', params: [{ sequenceNumber: 9, compressedData }] });
    },
    close: vi.fn(),
    forceClose: vi.fn(),
  };
}

const encoder = {
  encode: () => ({ method: 'Invoke', params: [{}] }),
  encodeOpenSession: () => ({ method: 'OpenSession', params: [{}] }),
} as never;

/** The shape of the live frame for the "Customer Statistics" FactBox (formId 73). */
const factboxRefresh = (formId: string, value: string) => [{
  handlerType: 'DN.LogicalClientChangeHandler',
  parameters: [formId, [
    { t: 'lcpchs', ControlReference: { controlPath: 'server:', formId }, Changes: { PendingUpdates: 0, Bookmark: 'BM2' } },
    { t: 'lcpchs', ControlReference: { controlPath: 'server:c[0]', formId }, Changes: { StringValue: value } },
  ]],
}];

const lateConfirm = [{
  handlerType: 'DN.LogicalClientEventRaisingHandler',
  parameters: ['DialogToShow', {
    ServerId: 'C9', t: 'lmd', Caption: 'Confirmar', MappingHint: 'ConfirmDialog', DialogType: 5, ExceptionType: 0,
    Message: '¿Se ha entregado el documento impreso al transportista?',
  }],
}];

function sessionWith(ws: ReturnType<typeof fakeWs>): BCSession {
  return new BCSession(ws as never, new EventDecoder(), encoder, silentLogger as never, 'default', 1000);
}

describe('BCSession: frames that arrive between invokes', () => {
  it('folds a late FactBox refresh into the page context (F-43)', () => {
    const ws = fakeWs();
    const session = sessionWith(ws);
    const repo = new PageContextRepository();
    repo.create('pc:22', 'root', { pageId: '22' });
    repo.registerDiscoveredChildForm('pc:22', {
      serverId: '73', caption: 'Customer Statistics', isSubForm: false, isPart: true,
      controlTree: { t: 'lf', ServerId: '73', Caption: 'Customer Statistics', Children: [{ t: 'sc', Caption: 'Customer No.', StringValue: '2000001' }] },
    });
    session.onUnsolicitedEvents((events) => repo.applyEvents(events));

    ws.push(factboxRefresh('73', '2000004'));

    const form = repo.get('pc:22')!.forms.get('73')!;
    expect(treeFields(form.root).find(f => f.properties.caption === 'Customer No.')?.properties.stringValue).toBe('2000004');
  });

  it('leaves a frame that arrives DURING an invoke to that invoke (no double delivery)', async () => {
    const ws = fakeWs();
    const session = sessionWith(ws);
    const background: BCEvent[] = [];
    session.onUnsolicitedEvents((events) => background.push(...events));
    // The RPC answers only after BC pushed a frame mid-invoke.
    ws.sendRpc.mockImplementationOnce(async () => { ws.push(factboxRefresh('73', 'X')); return ok([]); });
    const r = await session.invoke({ type: 'LoadForm', formId: '73', loadData: true }, (e) => e.type === 'PropertyChanged');
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.value.filter(e => e.type === 'PropertyChanged')).toHaveLength(2);
    expect(background).toHaveLength(0);
  });

  it('tracks a dialog that arrives late and hands it to the next invoke (F-45)', async () => {
    const ws = fakeWs();
    const session = sessionWith(ws);
    session.onUnsolicitedEvents(() => {});

    ws.push(lateConfirm);
    // The modal stack must know it, or the next invoke dies with LogicalModalityViolation.
    expect(session.modalStackSnapshot()).toEqual(['C9']);

    const r = await session.invoke({ type: 'InvokeAction', formId: 'root', controlPath: 'server:c[0]', systemAction: 0 }, (e) => e.type === 'InvokeCompleted');
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.value.find(e => e.type === 'DialogOpened')).toMatchObject({ formId: 'C9' });
    // Reported once: the buffer is drained.
    expect(session.takeUnsolicitedNotices()).toEqual([]);
  });

  it('does not let a housekeeping invoke adopt a late dialog', async () => {
    const ws = fakeWs();
    const session = sessionWith(ws);
    session.onUnsolicitedEvents(() => {});
    ws.push(lateConfirm);
    const r = await session.invoke({ type: 'LoadForm', formId: 'x', loadData: true }, (e) => e.type === 'InvokeCompleted', undefined, { carryUnsolicited: false });
    if (r.ok) expect(r.value.some(e => e.type === 'DialogOpened')).toBe(false);
    expect(session.takeUnsolicitedNotices().map(e => e.type)).toEqual(['DialogOpened']);
  });
});
