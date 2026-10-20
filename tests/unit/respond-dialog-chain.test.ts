// bc-saas F-44 / F-45: what an ANSWER to a dialog must hand back.
//
// Every event shape below is the one measured live on devel1 (BC27, 2026-10-03):
//  - a Confirm answered Yes, whose AL code then calls Message(), comes back with a
//    `MessageToShow` (not a dialog) carrying the text;
//  - a Refresh on a page holding an unsaved change raises the lmd ConfirmDialog
//    "La página contiene cambios no guardados. ¿Desea descartar estos cambios?";
//  - BC never sends FormClosed for an answered dialog.
import { describe, it, expect } from 'vitest';
import { RespondDialogOperation } from '../../src/operations/respond-dialog.js';
import { ok } from '../../src/core/result.js';
import type { BCEvent, BCInteraction } from '../../src/protocol/types.js';

const logger = { info() {}, warn() {}, error() {}, debug() {} } as never;

const discardConfirm = (formId: string): BCEvent => ({
  type: 'DialogOpened', formId,
  controlTree: {
    t: 'lmd', Caption: 'Confirmar', MappingHint: 'ConfirmDialog', DialogType: 5, ExceptionType: 0, IsModal: true,
    Message: 'La página contiene cambios no guardados. ¿Desea descartar estos cambios?',
  },
});

function makeCtx(withLines = false) {
  return {
    pageContextId: 'pc1',
    rootFormId: 'root',
    forms: new Map(withLines ? [['root', {}], ['lines', {}]] : [['root', {}]]),
    sections: new Map<string, unknown>([
      ['header', { sectionId: 'header', kind: 'header', caption: 'H', formId: 'root', valid: true }],
      ['dialog', { sectionId: 'dialog', kind: 'dialog', caption: 'D', formId: 'DLG', valid: true }],
      ...(withLines ? [['lines', { sectionId: 'lines', kind: 'lines', caption: 'L', formId: 'lines', valid: true, repeaterControlPath: 'server:c[1]' }] as [string, unknown]] : []),
    ]),
  };
}

function makeRepo(ctx: unknown, removed: string[] = []) {
  return {
    get: () => ctx,
    notFoundError: () => new Error('nf'),
    applyToPage: () => ctx,
    removeDialog: (_pc: string, f: string) => { removed.push(f); },
    getByFormId: () => undefined,
  } as never;
}

/** Session double: answers each interaction with the scripted events, records what was sent and untracked. */
function makeSession(script: (i: BCInteraction) => BCEvent[]) {
  const sent: BCInteraction[] = [];
  const untracked: string[] = [];
  const session = {
    invoke: async (i: BCInteraction) => { sent.push(i); return ok([...script(i), { type: 'InvokeCompleted', sequenceNumber: 1, completedInteractions: [] } as BCEvent]); },
    removeOpenForm: (f: string) => { untracked.push(f); },
  };
  return { session: session as never, sent, untracked };
}

describe('bc_respond_dialog reports what BC did after the answer', () => {
  it('returns the AL Message() raised after the answer (F-44)', async () => {
    const { session } = makeSession((i) => (i.type === 'InvokeAction' && i.formId === 'DLG'
      ? [{ type: 'MessageToShow', formId: '', text: 'Document 2001777 has been archived.', messageType: 'None', actions: ['Ok'], defaultAction: 'Ok' }]
      : []));
    const op = new RespondDialogOperation(session, makeRepo(makeCtx()), logger);
    const r = await op.execute({ pageContextId: 'pc1', dialogFormId: 'DLG', response: 'yes' });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.value.messages).toEqual([{ text: 'Document 2001777 has been archived.', type: 'None' }]);
    expect(r.value.dialogsOpened).toEqual([]);
  });

  it('reports the NEXT dialog of a chain with its real text, and keeps it tracked (F-45)', async () => {
    const next: BCEvent = {
      type: 'DialogOpened', formId: 'DLG2',
      controlTree: { t: 'lmd', Caption: 'Confirmar', MappingHint: 'ConfirmDialog', DialogType: 5, ExceptionType: 0, Message: '¿Quieres verlos?' },
    };
    const { session, untracked } = makeSession((i) => (i.type === 'InvokeAction' && i.formId === 'DLG' ? [next] : []));
    const removed: string[] = [];
    const op = new RespondDialogOperation(session, makeRepo(makeCtx(), removed), logger);
    const r = await op.execute({ pageContextId: 'pc1', dialogFormId: 'DLG', response: 'yes' });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.value.requiresDialogResponse).toBe(true);
    expect(r.value.dialogsOpened).toEqual([{ formId: 'DLG2', message: '¿Quieres verlos?', caption: 'Confirmar', kind: 'confirm' }]);
    // The ANSWERED dialog is gone on both sides; the new one is not touched.
    expect(untracked).toEqual(['DLG']);
    expect(removed).toEqual(['DLG']);
  });

  it('untracks the answered dialog from the SESSION modal stack, not only from the page (F-45)', async () => {
    // BC sends no FormClosed for an answered dialog. Only the page context used to be
    // pruned, so modalDepth grew with every answer and the modality reconcile later
    // walked a stack of forms BC had long thrown away.
    const { session, untracked } = makeSession(() => []);
    const op = new RespondDialogOperation(session, makeRepo(makeCtx()), logger);
    await op.execute({ pageContextId: 'pc1', dialogFormId: 'DLG', response: 'ok' });
    expect(untracked).toContain('DLG');
  });

  it('does not untrack a dialog BC re-published with the same formId', async () => {
    const { session, untracked } = makeSession((i) => (i.type === 'InvokeAction' && i.formId === 'DLG'
      ? [{ type: 'DialogOpened', formId: 'DLG', controlTree: { t: 'lf', Caption: 'Still here' } }]
      : []));
    const op = new RespondDialogOperation(session, makeRepo(makeCtx()), logger);
    const r = await op.execute({ pageContextId: 'pc1', dialogFormId: 'DLG', response: 'ok' });
    expect(untracked).not.toContain('DLG');
    if (r.ok) expect(r.value.dialogsOpened.map(d => d.formId)).toEqual(['DLG']);
  });

  it('settles the "discard changes?" confirm its OWN re-sync raised with No, and does not report it', async () => {
    // Measured live: answering a dialog on a page with an unsaved change, then
    // re-syncing the lines (Refresh), made BC ask whether to discard the changes. That
    // dialog was dropped: the caller got dialogsOpened:[] while BC held a modal.
    const { session, sent, untracked } = makeSession((i) => {
      if (i.type === 'InvokeAction' && i.formId === 'lines' && i.systemAction === 30) return [discardConfirm('CNF')];
      return [];
    });
    const op = new RespondDialogOperation(session, makeRepo(makeCtx(true)), logger);
    const r = await op.execute({ pageContextId: 'pc1', dialogFormId: 'DLG', response: 'cancel' });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    const answer = sent.find(i => i.formId === 'CNF');
    expect(answer).toMatchObject({ type: 'InvokeAction', systemAction: 390 }); // No: keep the page as it is
    expect(untracked).toContain('CNF');
    expect(r.value.dialogsOpened).toEqual([]);
  });

  it('REPORTS a dialog the re-sync raised but cannot settle itself (F-45)', async () => {
    const modalPage: BCEvent = { type: 'DialogOpened', formId: 'PG', controlTree: { t: 'lf', Caption: 'Seleccionar', IsModal: true } };
    const { session, sent } = makeSession((i) => (i.type === 'LoadForm' && i.formId === 'lines' ? [modalPage] : []));
    const op = new RespondDialogOperation(session, makeRepo(makeCtx(true)), logger);
    const r = await op.execute({ pageContextId: 'pc1', dialogFormId: 'DLG', response: 'ok' });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.value.requiresDialogResponse).toBe(true);
    expect(r.value.dialogsOpened).toEqual([{ formId: 'PG', message: 'Seleccionar', kind: 'page' }]);
    // Nothing more is sent to the page while that modal is up.
    expect(sent.some(i => i.type === 'InvokeAction' && i.formId === 'lines')).toBe(false);
  });
});

describe('bc_respond_dialog presses the dialog\'s OWN button (bc-saas F-47 d)', () => {
  // "Posted Sales Shipment - Update" (page 1350; 1351 is its return-shipment twin),
  // shape measured live on devel1: a lookup-mode modal whose "Aceptar" is
  // SystemAction LookupOk=330 at server:c[1]/c[0]. Its OnQueryClosePage only saves on
  // CloseAction = LookupOK, so answering with a plain Ok=300 threw the edit away.
  async function withUpdateDialog(response: 'ok' | 'cancel') {
    const { PageContextRepository } = await import('../../src/protocol/page-context-repo.js');
    const repo = new PageContextRepository();
    repo.create('pc', 'root', { pageId: '130' });
    repo.applyToPage('pc', [{
      type: 'DialogOpened', formId: 'UPD',
      controlTree: {
        t: 'lf', Caption: 'Posted Sales Shipment - Update', IsModal: true, ServerId: 'UPD',
        Children: [
          { t: 'gc', Children: [{ t: 'sc', Caption: 'Package Tracking No.', StringValue: '', Editable: true }] },
          { t: 'gc', Children: [{ t: 'ac', Caption: 'Aceptar', SystemAction: 330 }, { t: 'ac', Caption: 'Cancelar', SystemAction: 340 }] },
        ],
      },
    } as BCEvent]);
    const { session, sent } = makeSession(() => []);
    const op = new RespondDialogOperation(session, repo as never, logger);
    const r = await op.execute({ pageContextId: 'pc', dialogFormId: 'UPD', response });
    return { r, answer: sent.find(i => i.formId === 'UPD') };
  }

  it('"ok" sends LookupOk=330 on the dialog\'s Aceptar button', async () => {
    const { r, answer } = await withUpdateDialog('ok');
    expect(r.ok).toBe(true);
    expect(answer).toMatchObject({ type: 'InvokeAction', systemAction: 330, controlPath: 'server:c[1]/c[0]' });
  });

  it('"cancel" sends LookupCancel=340', async () => {
    const { answer } = await withUpdateDialog('cancel');
    expect(answer).toMatchObject({ systemAction: 340, controlPath: 'server:c[1]/c[1]' });
  });

  it('keeps the generic answer when the dialog publishes no button for it', async () => {
    const { session, sent } = makeSession(() => []);
    const op = new RespondDialogOperation(session, makeRepo(makeCtx()), logger);
    await op.execute({ pageContextId: 'pc1', dialogFormId: 'DLG', response: 'ok' });
    expect(sent[0]).toMatchObject({ formId: 'DLG', systemAction: 300, controlPath: 'server:c[0]' });
  });
});
