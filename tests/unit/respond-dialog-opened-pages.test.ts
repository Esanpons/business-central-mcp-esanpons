// bc-saas F-56 (2nd case) / F-65: posting confirmed through a dialog ("Registrar..." ->
// StrMenu "&Enviar") that fails with several errors does NOT raise an error dialog:
// BC opens page "Mensajes de error" (Error Messages) as a new, ownerless FormCreated.
// bc_respond_dialog only looked up formIds it already knew, so the page never got a
// pageContextId, was never reported, and the failed posting came back as
// `success: true` with nothing else.
import { describe, it, expect, vi } from 'vitest';
import { RespondDialogOperation } from '../../src/operations/respond-dialog.js';
import { ActionService } from '../../src/services/action-service.js';
import { PageContextRepository } from '../../src/protocol/page-context-repo.js';
import { ok } from '../../src/core/result.js';
import type { BCEvent, BCInteraction } from '../../src/protocol/types.js';

const logger = { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() } as never;

const errorMessagesPage: BCEvent = {
  type: 'FormCreated', formId: 'ERR',
  controlTree: {
    t: 'lf', ServerId: 'ERR', PageType: 1, Caption: 'Mensajes de error',
    Children: [{ t: 'rc', Columns: [{ t: 'rcc', Caption: 'Descripción', ColumnBinder: { Name: 'd' } }] }],
  },
} as BCEvent;

function setup(answerEvents: BCEvent[]) {
  const repo = new PageContextRepository();
  repo.create('pc:order', 'ROOT');
  repo.applyToPage('pc:order', [
    { type: 'FormCreated', formId: 'ROOT', controlTree: { t: 'lf', ServerId: 'ROOT', PageType: 0, Caption: 'Devolución compra', Children: [] } } as BCEvent,
    { type: 'DialogOpened', formId: 'DLG', ownerFormId: 'ROOT', controlTree: { t: 'lf', ServerId: 'DLG', MappingHint: 'SelectionMenuDialog', Caption: 'Elegir', Children: [] } } as BCEvent,
  ]);
  const sent: BCInteraction[] = [];
  const session = {
    invoke: async (i: BCInteraction) => {
      sent.push(i);
      const extra = i.type === 'InvokeAction' && i.formId === 'DLG' ? answerEvents : [];
      return ok([...extra, { type: 'InvokeCompleted', sequenceNumber: 1, completedInteractions: [] } as BCEvent]);
    },
    removeOpenForm: vi.fn(),
  } as never;
  const actions = new ActionService(session, repo, logger);
  const op = new RespondDialogOperation(session, repo, logger, undefined, (ev, src) => actions.adoptOpenedPages(ev, src, 'dialog'));
  return { repo, op, sent };
}

describe('bc_respond_dialog reports the pages the answer opened (F-65)', () => {
  it('registers the Error Messages page and returns it in openedPages with a note', async () => {
    const { repo, op } = setup([errorMessagesPage]);
    const r = await op.execute({ pageContextId: 'pc:order', dialogFormId: 'DLG', response: 'ok' });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.value.openedPages).toHaveLength(1);
    const opened = r.value.openedPages[0]!;
    expect(opened.caption).toBe('Mensajes de error');
    expect(opened.pageContextId).toMatch(/^session:page:dialog:/);
    // It is a real context now: readable, closeable.
    expect(repo.get(opened.pageContextId)?.rootFormId).toBe('ERR');
    expect(r.value.note).toMatch(/Error Messages/);
  });

  it('does not count a subpage (FormCreated WITH a parent) as an opened page', async () => {
    const sub = { type: 'FormCreated', formId: 'SUB', parentFormId: 'ROOT', controlTree: { t: 'lf', ServerId: 'SUB', Children: [] } } as BCEvent;
    const { op } = setup([sub]);
    const r = await op.execute({ pageContextId: 'pc:order', dialogFormId: 'DLG', response: 'ok' });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.value.openedPages).toEqual([]);
    expect(r.value.note).toBeUndefined();
  });
});
