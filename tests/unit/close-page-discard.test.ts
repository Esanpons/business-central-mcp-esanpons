// tests/unit/close-page-discard.test.ts
//
// bc-saas F-47 b: `bc_close_page { discardChanges: true }` on a page with unsaved
// changes answered `success:false` with "¿Desea descartar estos cambios?" — and the
// page context was already gone, so answering it failed with "Page context not
// found". Two faults, both measured live on devel1 (BC27, 2026-10-03):
//  - the dialog it had ALREADY answered was reported as pending (every DialogOpened
//    in the events was), and
//  - it answered No=390, which KEEPS the page open (after No the root form still
//    answered a Refresh; after Yes=380 it was gone with FormNotFoundException).
import { describe, it, expect, vi } from 'vitest';
import { PageService } from '../../src/services/page-service.js';
import { PageContextRepository } from '../../src/protocol/page-context-repo.js';
import { ClosePageOperation } from '../../src/operations/close-page.js';
import { ok } from '../../src/core/result.js';
import type { BCEvent, BCInteraction } from '../../src/protocol/types.js';

const discardConfirm: BCEvent = {
  type: 'DialogOpened', formId: 'C7',
  controlTree: {
    t: 'lmd', Caption: 'Confirmar', MappingHint: 'ConfirmDialog', DialogType: 5, ExceptionType: 0, IsModal: true,
    Message: 'La página contiene cambios no guardados. ¿Desea descartar estos cambios?',
  },
};

function setup(onAnswer: (i: BCInteraction) => BCEvent[] = () => []) {
  const sent: BCInteraction[] = [];
  const untracked: string[] = [];
  const session = {
    invoke: async (i: BCInteraction) => {
      sent.push(i);
      const extra = i.type === 'CloseForm' && i.formId === 'root' ? [discardConfirm]
        : i.type === 'InvokeAction' ? onAnswer(i) : [];
      return ok([...extra, { type: 'InvokeCompleted', sequenceNumber: 1, completedInteractions: [] } as BCEvent]);
    },
    removeOpenForm: (f: string) => { untracked.push(f); },
    addOpenForm: vi.fn(),
  } as never;
  const logger = { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() } as never;
  const repo = new PageContextRepository();
  repo.create('pc:42', 'root', { pageId: '42' });
  const op = new ClosePageOperation(new PageService(session, repo, logger));
  return { op, repo, sent, untracked };
}

describe('bc_close_page with unsaved changes', () => {
  it('discardChanges answers YES (the answer that discards) and reports a clean close', async () => {
    const { op, repo, sent, untracked } = setup();
    const r = await op.execute({ pageContextId: 'pc:42', discardChanges: true });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(sent.find(i => i.type === 'InvokeAction')).toMatchObject({ formId: 'C7', systemAction: 380 });
    expect(r.value.success).toBe(true);
    expect(r.value.dialogsOpened).toEqual([]);
    expect(r.value.requiresDialogResponse).toBe(false);
    expect(repo.get('pc:42')).toBeUndefined();
    expect(untracked).toEqual(expect.arrayContaining(['C7', 'root']));
  });

  it('without discardChanges, surfaces the question with its real text and keeps the context', async () => {
    const { op, repo } = setup();
    const r = await op.execute({ pageContextId: 'pc:42' });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.value.success).toBe(false);
    expect(r.value.dialogsOpened).toEqual([{
      formId: 'C7', kind: 'confirm', caption: 'Confirmar',
      message: 'La página contiene cambios no guardados. ¿Desea descartar estos cambios?',
    }]);
    expect(r.value.hint).toMatch(/"yes".*discards/);
    expect(repo.get('pc:42')).toBeDefined();
  });

  it('reports an error BC raises while discarding, instead of claiming the page closed', async () => {
    const error: BCEvent = {
      type: 'DialogOpened', formId: 'E1',
      controlTree: { t: 'lmd', Caption: 'Error', MappingHint: 'ErrorDialog', DialogType: 3, ExceptionType: 1, Message: 'No se puede descartar.' },
    };
    const { op, repo } = setup((i) => (i.formId === 'C7' ? [error] : []));
    const r = await op.execute({ pageContextId: 'pc:42', discardChanges: true });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.value.success).toBe(false);
    expect(r.value.dialogsOpened).toEqual([{ formId: 'E1', kind: 'error', caption: 'Error', message: 'No se puede descartar.' }]);
    expect(repo.get('pc:42')).toBeDefined();
  });
});
