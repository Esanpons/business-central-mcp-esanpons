// bc-saas F-60 / F-58 / F-70 / F-64 b — how a NEW line is written.
//
// Measured live on devel1 (BC27, 2026-10-04):
//  - `New` (SystemAction 10) inserts ABOVE the current row, so lines 1, 2, 3 written
//    with newLine came back 3, 2, 1 (F-60).
//  - A document's lines grid is padded with `DraftRecord…` rows. Selecting a DIFFERENT
//    unused draft for each line and typing into the current row appended them in
//    order; re-selecting the same draft edited the line just created.
//  - BC answers line writes with cell echoes only — never with row data — so the
//    projection kept showing the empty draft (F-58) and the only bookmark a caller saw
//    was the placeholder BC re-keys on commit (F-70).
import { describe, it, expect, vi } from 'vitest';
import { DataService } from '../../src/services/data-service.js';
import { PageContextRepository } from '../../src/protocol/page-context-repo.js';
import { ok } from '../../src/core/result.js';
import type { BCEvent, BCInteraction } from '../../src/protocol/types.js';

const logger = { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() } as never;
const done = { type: 'InvokeCompleted', sequenceNumber: 1, completedInteractions: [] } as BCEvent;

// Lines subform: repeater at server:c[0], columns co[0..3] = Type, No., Description, Quantity.
const linesTree = {
  t: 'lf', ServerId: 'L', Caption: 'Lines', IsSubForm: true,
  Children: [{ t: 'rc', Columns: [
    { t: 'rcc', Caption: 'Type', ColumnBinder: { Name: 'type' } },
    { t: 'rcc', Caption: 'No.', ColumnBinder: { Name: 'no' } },
    { t: 'rcc', Caption: 'Description', ColumnBinder: { Name: 'desc' } },
    { t: 'rcc', Caption: 'Quantity', ColumnBinder: { Name: 'qty' } },
  ] }],
};

const rowsEvent = (bookmarks: string[]): BCEvent => ({
  type: 'DataLoaded', formId: 'L', controlPath: 'server:c[0]', currentRowOnly: false,
  rows: bookmarks.map((b, i) => ({ DataRowInserted: [i, { bookmark: b, cells: b.startsWith('DraftRecord') ? {} : { type: 'Item', no: '1968-S', desc: b } }] })),
} as BCEvent);

function setup(initialRows: string[], opts: { afterRefresh?: string[]; echo?: (i: BCInteraction) => BCEvent[] } = {}) {
  const repo = new PageContextRepository();
  repo.create('pc', 'ROOT');
  repo.registerDiscoveredChildForm('pc', { serverId: 'L', caption: 'Lines', controlTree: linesTree, isSubForm: true, isPart: true });
  repo.applyToPage('pc', [rowsEvent(initialRows)]);
  const sent: BCInteraction[] = [];
  const session = {
    invoke: async (i: BCInteraction) => {
      sent.push(i);
      const out: BCEvent[] = [];
      if (i.type === 'SaveValue') {
        out.push({ type: 'PropertyChanged', formId: 'L', controlPath: i.controlPath, changes: { StringValue: i.newValue } } as BCEvent);
        out.push(...(opts.echo?.(i) ?? []));
      }
      if (i.type === 'InvokeAction' && i.systemAction === 30 && opts.afterRefresh) out.push(rowsEvent(opts.afterRefresh));
      return ok([...out, done]);
    },
    removeOpenForm: vi.fn(),
  } as never;
  return { repo, sent, svc: new DataService(session, repo, logger) };
}

const summary = (sent: BCInteraction[]) => sent.map(i =>
  i.type === 'SetCurrentRow' ? `select:${(i as { key: string }).key}`
    : i.type === 'SaveValue' ? `save:${(i as { controlPath: string }).controlPath.split('/').pop()}`
      : i.type === 'InvokeAction' ? `action:${(i as { systemAction: number }).systemAction}`
        : i.type);

describe('newLine appends on an unused draft row (F-60)', () => {
  it('selects the first draft after the last real line instead of sending New, and writes once into it', async () => {
    const { svc, sent } = setup(['R1', 'DraftRecord1', 'DraftRecord2', 'DraftRecord3'], { afterRefresh: ['R1', 'R2', 'DraftRecord7'] });
    const r = await svc.writeFields('pc', { Description: 'second', Type: 'Comment' }, { sectionId: 'lines', newLine: true });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    // Type before Description (identifying columns first), all on the current row,
    // then a commit by moving to another draft and a re-sync of the grid.
    expect(summary(sent)).toEqual([
      'select:DraftRecord1', 'save:c[0]', 'save:c[2]',
      'select:DraftRecord2', 'LoadForm', 'action:30',
    ]);
    expect(sent.some(i => i.type === 'InvokeAction' && (i as { systemAction: number }).systemAction === 10)).toBe(false);
    expect(r.value.newLineCreated).toBe(true);
    expect(r.value.newLineBookmark).toBe('R2');
  });

  it('the next newLine takes the NEXT draft, not the one already consumed', async () => {
    // No re-sync data: the projection keeps the stale drafts, exactly as BC leaves it.
    const { svc, sent } = setup(['DraftRecord1', 'DraftRecord2', 'DraftRecord3']);
    await svc.writeFields('pc', { Description: 'one' }, { sectionId: 'lines', newLine: true });
    await svc.writeFields('pc', { Description: 'two' }, { sectionId: 'lines', newLine: true });
    const selects = summary(sent).filter(s => s.startsWith('select:'));
    // line 1 -> D1 (parking D2), line 2 -> D2 (parking D3)
    expect(selects).toEqual(['select:DraftRecord1', 'select:DraftRecord2', 'select:DraftRecord2', 'select:DraftRecord3']);
  });

  it('falls back to New when the grid offers no draft rows', async () => {
    const { svc, sent } = setup(['R1']);
    await svc.writeFields('pc', { Description: 'x' }, { sectionId: 'lines', newLine: true });
    expect(summary(sent)[0]).toBe('action:10');
  });

  it('says so when the re-read grid holds no new line (F-64 b)', async () => {
    const { svc } = setup(['R1', 'DraftRecord1', 'DraftRecord2'], { afterRefresh: ['R1', 'DraftRecord9'] });
    const r = await svc.writeFields('pc', { Description: 'ignored' }, { sectionId: 'lines', newLine: true });
    expect(r.ok && r.value.newLineCreated).toBe(false);
    expect(r.ok && r.value.newLineBookmark).toBeUndefined();
  });
});

describe('a write aimed at a DraftRecord bookmark selects it ONCE (F-70)', () => {
  it('selects the draft one time and writes every field into the current row', async () => {
    const { svc, sent } = setup(['DraftRecord8740', 'DraftRecord8741']);
    const r = await svc.writeFields('pc', { 'No.': '1968-S', Quantity: '1' }, { sectionId: 'lines', bookmark: 'DraftRecord8740' });
    expect(r.ok).toBe(true);
    const s = summary(sent);
    expect(s.filter(x => x === 'select:DraftRecord8740')).toHaveLength(1);
    expect(s.slice(0, 3)).toEqual(['select:DraftRecord8740', 'save:c[1]', 'save:c[3]']);
  });
});

describe('re-asserting what BC reset (F-58)', () => {
  it('re-writes a quantity BC reset, judged on the LAST echo of that cell', async () => {
    // BC echoes 2, then resets the cell to 0 while resolving the line.
    const { svc, sent } = setup(['DraftRecord1', 'DraftRecord2'], {
      echo: (i) => (i.type === 'SaveValue' && i.controlPath.endsWith('c[3]') && sent.filter(x => x.type === 'SaveValue' && (x as { controlPath: string }).controlPath.endsWith('c[3]')).length === 1
        ? [{ type: 'PropertyChanged', formId: 'L', controlPath: i.controlPath, changes: { StringValue: '0' } } as BCEvent]
        : []),
    });
    await svc.writeFields('pc', { Type: 'Item', 'No.': '1968-S', Quantity: '2' }, { sectionId: 'lines', newLine: true });
    expect(summary(sent).filter(x => x === 'save:c[3]')).toHaveLength(2);
  });

  it('never re-writes an identifying column, and ignores case (no Type re-validation emptying No.)', async () => {
    const { svc, sent } = setup(['DraftRecord1', 'DraftRecord2'], {
      echo: (i) => (i.type === 'SaveValue' && i.controlPath.endsWith('c[0]')
        ? [{ type: 'PropertyChanged', formId: 'L', controlPath: i.controlPath, changes: { StringValue: 'Cargo (Prod.)' } } as BCEvent]
        : []),
    });
    await svc.writeFields('pc', { Type: 'Cargo (prod.)', 'No.': 'V-DEDUCCIÓN', Quantity: '1' }, { sectionId: 'lines', newLine: true });
    expect(summary(sent).filter(x => x === 'save:c[0]')).toHaveLength(1);
  });
});
