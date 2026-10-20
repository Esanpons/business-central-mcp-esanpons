// bc-saas F-65 (dialog subforms) / F-57 2nd case / F-64 c (dialog grids with no rows).
//
// Shape measured live on devel1 (BC27, 2026-10-04): Purchase Return Order -> "Get Posted
// Doc. Lines to Reverse" opens page 5855 as a DialogToShow whose tree hosts the lines in
// FOUR fhc nodes under server:c[3] (one visible, three hidden alternative views), each an
// lf subform with its repeater at server:c[1]. The dialog had a `dialog` section with its
// header fields only, and no rows came until LoadForm + InvokeAction(Refresh) on the
// subform — after which 49 rows arrived.
import { describe, it, expect, vi } from 'vitest';
import { PageContextRepository } from '../../src/protocol/page-context-repo.js';
import { PageService } from '../../src/services/page-service.js';
import { buildSection } from '../../src/protocol/section-dto.js';
import { withDialogSections, detectDialogs } from '../../src/protocol/mutation-result.js';
import { ok } from '../../src/core/result.js';
import type { BCEvent, BCInteraction } from '../../src/protocol/types.js';

const linesSubform = (serverId: string) => ({
  t: 'lf', ServerId: serverId, Caption: 'Lines', IsSubForm: true, IsPart: true,
  Children: [
    { t: 'gc', Children: [] },
    { t: 'rc', Columns: [
      { t: 'rcc', Caption: 'Document No.', ColumnBinder: { Name: 'docno' } },
      { t: 'rcc', Caption: 'No.', ColumnBinder: { Name: 'no' } },
    ] },
  ],
});

const dialog5855: BCEvent = {
  type: 'DialogOpened', formId: 'AB', ownerFormId: 'ROOT',
  controlTree: {
    t: 'lf', ServerId: 'AB', Caption: 'Posted Purchase Document Lines - 40000', PageType: 1,
    Children: [
      { t: 'sc', Caption: 'Document Type', ColumnBinder: { Name: 'dt' } },
      { t: 'gc', Children: [] },
      { t: 'gc', Children: [] },
      { t: 'gc', Caption: 'Control18', Children: [
        { t: 'fhc', Visible: true, Children: [linesSubform('A7')] },
        { t: 'fhc', Visible: false, Children: [linesSubform('A8')] },
        { t: 'fhc', Visible: false, Children: [linesSubform('A9')] },
      ] },
    ],
  },
} as BCEvent;

function repoWithDialog(): PageContextRepository {
  const repo = new PageContextRepository();
  repo.create('pc', 'ROOT');
  repo.applyToPage('pc', [
    { type: 'FormCreated', formId: 'ROOT', controlTree: { t: 'lf', ServerId: 'ROOT', PageType: 0, Caption: 'Purchase Return Order', Children: [] } } as BCEvent,
    dialog5855,
  ]);
  return repo;
}

describe('a dialog exposes the subforms it hosts (F-65)', () => {
  it('registers the VISIBLE hosted subform as dialog:Lines, not the hidden alternatives', () => {
    const ctx = repoWithDialog().get('pc')!;
    const dialogIds = [...ctx.sections.values()].filter(s => s.kind === 'dialog' || s.ownerDialogFormId).map(s => s.sectionId);
    expect(dialogIds).toEqual(['dialog', 'dialog:Lines']);
    expect(ctx.sections.get('dialog:Lines')).toMatchObject({ formId: 'A7', repeaterControlPath: 'server:c[1]', ownerDialogFormId: 'AB' });
    expect(ctx.forms.has('A8')).toBe(false);
  });

  it('the dialog entry in a result names its sections', () => {
    const repo = repoWithDialog();
    const out = withDialogSections(repo.get('pc'), detectDialogs([dialog5855]));
    expect(out[0]!.sections).toEqual(['dialog', 'dialog:Lines']);
  });

  it('answering the dialog removes its subform sections, forms and index too', () => {
    const repo = repoWithDialog();
    repo.removeDialog('pc', 'AB');
    const ctx = repo.get('pc')!;
    expect([...ctx.sections.keys()]).toEqual(['header']);
    expect(ctx.forms.has('A7')).toBe(false);
    expect(repo.getByFormId('A7')).toBeUndefined();
  });

  it('a FormClosed for the dialog does the same', () => {
    const repo = repoWithDialog();
    repo.applyToPage('pc', [{ type: 'FormClosed', formId: 'AB' } as BCEvent]);
    expect([...repo.get('pc')!.sections.keys()]).toEqual(['header']);
  });
});

describe('PageService.loadDialogContent loads the rows of a dialog grid (F-57 / F-64 c / F-65)', () => {
  it('sends LoadForm + Refresh on the hosted repeater and the rows become readable', async () => {
    const repo = repoWithDialog();
    const sent: BCInteraction[] = [];
    const session = {
      invoke: async (i: BCInteraction) => {
        sent.push(i);
        const rows = i.type === 'InvokeAction' && i.formId === 'A7'
          ? [{ type: 'DataLoaded', formId: 'A7', controlPath: 'server:c[1]', currentRowOnly: false,
            rows: [{ DataRowInserted: [0, { bookmark: 'b1', cells: { docno: '107249', no: '1968-S' } }] }] } as BCEvent]
          : [];
        return ok([...rows, { type: 'InvokeCompleted', sequenceNumber: 1, completedInteractions: [] } as BCEvent]);
      },
      removeOpenForm: vi.fn(),
    } as never;
    const logger = { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() } as never;
    const svc = new PageService(session, repo, logger, { tenantId: 'default', authMode: 'UserPassword' });

    await svc.loadDialogContent('pc', [dialog5855]);

    expect(sent.map(i => `${i.type}:${i.formId}`)).toEqual(['LoadForm:A7', 'InvokeAction:A7']);
    expect((sent[1] as { controlPath: string; systemAction: number })).toMatchObject({ controlPath: 'server:c[1]', systemAction: 30 });
    const section = buildSection(repo.get('pc')!, 'dialog:Lines');
    expect(section?.rows).toHaveLength(1);
    expect(section?.rows?.[0]?.cells).toMatchObject({ 'Document No.': '107249', 'No.': '1968-S' });
  });

  it('leaves a message box alone', async () => {
    const repo = new PageContextRepository();
    repo.create('pc', 'ROOT');
    const confirm = { type: 'DialogOpened', formId: 'C1', ownerFormId: 'ROOT', controlTree: { t: 'lmd', MappingHint: 'ConfirmDialog', DialogType: 5, ExceptionType: 0, Message: '¿Seguro?' } } as BCEvent;
    repo.applyToPage('pc', [confirm]);
    const sent: BCInteraction[] = [];
    const session = { invoke: async (i: BCInteraction) => { sent.push(i); return ok([]); }, removeOpenForm: vi.fn() } as never;
    const svc = new PageService(session, repo, { info() {}, warn() {}, error() {}, debug() {} } as never, { tenantId: 'default', authMode: 'UserPassword' });
    await svc.loadDialogContent('pc', [confirm]);
    expect(sent).toEqual([]);
  });
});
