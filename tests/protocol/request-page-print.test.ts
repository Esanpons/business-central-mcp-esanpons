// bc-saas F-55 / F-71: "ok" on a report request page did not run the report.
//
// Measured live on devel1 (BC27, 2026-10-04): page 143 "&Print..." opens a
// `DialogToShow` with MappingHint "RequestPage" (PageType 13) whose buttons are
//   "Enviar a..." SystemAction 410, "Imprimir" 420, "Vista previa y cerrar" 400,
//   "Cancelar" 310 — and hidden copies of the first three. There is NO Ok=300.
// Ok=300 sent to it came back as a bare InvokeCompleted: the page stayed open on the
// server, nothing after Report.RunModal ran (the DeCA "¿Se ha entregado...?" Confirm),
// and the NEXT call died with LogicalModalityViolation on an empty modal stack.
// Pressing 420 (or 400) answered with the UriToShow below and closed the page.
import { describe, it, expect, vi } from 'vitest';
import { EventDecoder } from '../../src/protocol/event-decoder.js';
import { detectFiles } from '../../src/protocol/mutation-result.js';
import { RespondDialogOperation } from '../../src/operations/respond-dialog.js';
import { PageContextRepository } from '../../src/protocol/page-context-repo.js';
import { ok } from '../../src/core/result.js';
import type { BCEvent, BCInteraction } from '../../src/protocol/types.js';

// The handler BC sent after "Imprimir" (session id shortened).
const URI = 'DynamicFileHandler.axd?form=4F&sessionid=DEFAULTCRONUS_04SR6392671319876184135NAV&type=File&fid=pcog3h4hswoh0pjplrib25ot&fname=Sales%20Invoice.pdf';
const uriHandler = { handlerType: 'DN.LogicalClientEventRaisingHandler', parameters: ['UriToShow', URI] };

describe('UriToShow (the rendered report)', () => {
  it('is decoded instead of dropped', () => {
    const events = new EventDecoder().decode([uriHandler]);
    expect(events).toEqual([{ type: 'UriToShow', formId: '', uri: URI }]);
  });

  it('is reported as a file with its decoded name', () => {
    const events = new EventDecoder().decode([uriHandler, uriHandler]);
    expect(detectFiles(events)).toEqual([{ fileName: 'Sales Invoice.pdf', uri: URI }]);
  });
});

// The request page's control tree, reduced to what matters: the action bar at c[0],
// visible buttons first, then a hidden duplicate of "Imprimir" (BC publishes several).
const requestPage = {
  t: 'lf', ServerId: 'RP', MappingHint: 'RequestPage', PageType: 13, Caption: 'Sales Invoice',
  Children: [
    { t: 'gc', Children: [
      { t: 'ac', Caption: 'Enviar a...', SystemAction: 410, Visible: true },
      { t: 'ac', Caption: 'Imprimir', SystemAction: 420, Visible: true },
      { t: 'ac', Caption: 'Vista previa && cerrar', SystemAction: 400, Visible: true },
      { t: 'ac', Caption: 'Imprimir', SystemAction: 420, Visible: false },
      { t: 'ac', Caption: 'Cancelar', SystemAction: 310 },
    ] },
  ],
};

function setup(tree: unknown) {
  const repo = new PageContextRepository();
  repo.create('pc:list', 'LIST');
  repo.applyToPage('pc:list', [
    { type: 'FormCreated', formId: 'LIST', controlTree: { t: 'lf', ServerId: 'LIST', PageType: 1, Caption: 'Posted Sales Invoices', Children: [] } } as BCEvent,
    { type: 'DialogOpened', formId: 'RP', controlTree: tree } as BCEvent,
  ]);
  const sent: BCInteraction[] = [];
  const untracked: string[] = [];
  const session = {
    invoke: async (i: BCInteraction) => {
      sent.push(i);
      const printed = i.type === 'InvokeAction' && i.formId === 'RP' && (i.systemAction === 420 || i.systemAction === 400);
      const decoded = printed ? new EventDecoder().decode([uriHandler]) : [];
      return ok([...decoded, { type: 'InvokeCompleted', sequenceNumber: 1, completedInteractions: [] } as BCEvent]);
    },
    removeOpenForm: (f: string) => { untracked.push(f); },
  } as never;
  const logger = { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() } as never;
  return { op: new RespondDialogOperation(session, repo, logger), sent, untracked };
}

describe('"ok" on a request page presses its own button', () => {
  it('sends Print (420) on the VISIBLE "Imprimir", never Ok=300', async () => {
    const { op, sent, untracked } = setup(requestPage);
    const r = await op.execute({ pageContextId: 'pc:list', dialogFormId: 'RP', response: 'ok' });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    const answer = sent.find(i => i.type === 'InvokeAction' && i.formId === 'RP') as { systemAction: number; controlPath: string };
    expect(answer.systemAction).toBe(420);
    expect(answer.controlPath).toBe('server:c[0]/c[1]');
    expect(r.value.files).toEqual([{ fileName: 'Sales Invoice.pdf', uri: URI }]);
    // Answered for real, so it is right to untrack it.
    expect(untracked).toContain('RP');
  });

  it('falls back to Preview (400) when the page offers no Print', async () => {
    const noPrint = { ...requestPage, Children: [{ t: 'gc', Children: [
      { t: 'ac', Caption: 'Vista previa && cerrar', SystemAction: 400, Visible: true },
      { t: 'ac', Caption: 'Cancelar', SystemAction: 310 },
    ] }] };
    const { op, sent } = setup(noPrint);
    const r = await op.execute({ pageContextId: 'pc:list', dialogFormId: 'RP', response: 'ok' });
    expect(r.ok).toBe(true);
    const answer = sent.find(i => i.type === 'InvokeAction' && i.formId === 'RP') as { systemAction: number };
    expect(answer.systemAction).toBe(400);
  });

  it('"cancel" still presses Cancelar (310)', async () => {
    const { op, sent } = setup(requestPage);
    await op.execute({ pageContextId: 'pc:list', dialogFormId: 'RP', response: 'cancel' });
    const answer = sent.find(i => i.type === 'InvokeAction' && i.formId === 'RP') as { systemAction: number; controlPath: string };
    expect(answer.systemAction).toBe(310);
    expect(answer.controlPath).toBe('server:c[0]/c[4]');
  });
});
