import { describe, it, expect } from 'vitest';
import { FormProjection } from '../../src/protocol/form-state.js';
import type { FormState } from '../../src/protocol/form-state.js';
import type { BCEvent } from '../../src/protocol/types.js';
import { buildFormTree } from '../../src/protocol/form-tree-builder.js';
import {
  fields as treeFields, repeaters as treeRepeaters,
} from '../../src/protocol/form-views.js';

function makeForm(overrides: Partial<FormState> = {}): FormState {
  const root = buildFormTree({ t: 'lf', ServerId: 'f1', PageType: 0, Children: [] });
  return {
    formId: 'f1',
    root,
    rows: new Map(),
    ...overrides,
  };
}

/** Creates a form whose tree contains a repeater at server:c[1] with one column.
 * A dummy group at c[0] pushes the repeater to index 1, matching the original
 * test controlPath `server:c[1]`. */
function makeRepeaterForm(): FormState {
  const root = buildFormTree({
    t: 'lf', ServerId: 'f1', PageType: 1,
    Children: [
      { t: 'gc', Children: [] },  // c[0] — dummy group
      { t: 'rc', Children: [], Columns: [{ t: 'rcc', Caption: 'No.' }] },  // c[1] — repeater
    ],
  });
  return {
    formId: 'f1',
    root,
    rows: new Map(),
  };
}

describe('FormProjection', () => {
  const projection = new FormProjection();

  it('applies DataLoaded to matching repeater', () => {
    const form = makeRepeaterForm();
    const event: BCEvent = {
      type: 'DataLoaded', formId: 'f1', controlPath: 'server:c[1]',
      currentRowOnly: false,
      rows: [
        { t: 'DataRowInserted', DataRowInserted: [0, { cells: { 'No.': '10000' }, bookmark: 'bm1' }] },
        { t: 'DataRowInserted', DataRowInserted: [1, { cells: { 'No.': '20000' }, bookmark: 'bm2' }] },
      ],
    };
    const updated = projection.apply(form, event);
    const rows = updated.rows.get('server:c[1]')!;
    expect(rows).toHaveLength(2);
    expect(rows[0]!.bookmark).toBe('bm1');
    // totalRowCount lives on the tree node, not in rows map
    const repNode = treeRepeaters(updated.root).get('server:c[1]')!;
    expect(repNode.properties.totalRowCount ?? null).toBeNull(); // not inferred from rows.length
  });

  it('ignores DataLoaded for unknown controlPath', () => {
    const form = makeRepeaterForm();
    const event: BCEvent = {
      type: 'DataLoaded', formId: 'f1', controlPath: 'server:c[99]',
      currentRowOnly: false, rows: [],
    };
    const updated = projection.apply(form, event);
    expect(updated.rows.get('server:c[1]') ?? []).toHaveLength(0);
  });

  it('merges currentRowOnly DataLoaded by bookmark', () => {
    const base = makeRepeaterForm();
    const form: FormState = {
      ...base,
      rows: new Map([['server:c[1]', [
        { bookmark: 'bm1', cells: { 'No.': '10000' } },
        { bookmark: 'bm2', cells: { 'No.': '20000' } },
      ]]]),
    };
    const event: BCEvent = {
      type: 'DataLoaded', formId: 'f1', controlPath: 'server:c[1]',
      currentRowOnly: true,
      rows: [{ t: 'DataRowUpdated', DataRowUpdated: [0, { cells: { 'No.': '10001' }, bookmark: 'bm1' }] }],
    };
    const updated = projection.apply(form, event);
    const rows = updated.rows.get('server:c[1]')!;
    expect(rows).toHaveLength(2);
    expect(rows[0]!.cells['No.']).toBe('10001');
    expect(rows[1]!.cells['No.']).toBe('20000');
  });

  it('appends a newly inserted row on currentRowOnly (M11)', () => {
    const base = makeRepeaterForm();
    const form: FormState = {
      ...base,
      rows: new Map([['server:c[1]', [
        { bookmark: 'bm1', cells: { 'No.': '10000' } },
      ]]]),
    };
    // A new line created via New arrives as currentRowOnly with a bookmark not
    // yet present. The old merge dropped it; now it must be appended.
    const event: BCEvent = {
      type: 'DataLoaded', formId: 'f1', controlPath: 'server:c[1]',
      currentRowOnly: true,
      rows: [{ t: 'DataRowInserted', DataRowInserted: [1, { cells: { 'No.': '20000' }, bookmark: 'bm2' }] }],
    };
    const updated = projection.apply(form, event);
    const rows = updated.rows.get('server:c[1]')!;
    expect(rows).toHaveLength(2);
    expect(rows[1]!.bookmark).toBe('bm2');
  });

  it('drops an explicitly removed row on currentRowOnly (M10, best-effort)', () => {
    const base = makeRepeaterForm();
    const form: FormState = {
      ...base,
      rows: new Map([['server:c[1]', [
        { bookmark: 'bm1', cells: { 'No.': '10000' } },
        { bookmark: 'bm2', cells: { 'No.': '20000' } },
      ]]]),
    };
    const event: BCEvent = {
      type: 'DataLoaded', formId: 'f1', controlPath: 'server:c[1]',
      currentRowOnly: true,
      rows: [{ t: 'DataRowRemoved', DataRowRemoved: [1, { bookmark: 'bm2' }] }],
    };
    const updated = projection.apply(form, event);
    const rows = updated.rows.get('server:c[1]')!;
    expect(rows).toHaveLength(1);
    expect(rows[0]!.bookmark).toBe('bm1');
  });

  it('applies PropertyChanged TotalRowCount to repeater', () => {
    const form = makeRepeaterForm();
    const event: BCEvent = {
      type: 'PropertyChanged', formId: 'f1', controlPath: 'server:c[1]',
      changes: { TotalRowCount: 42 },
    };
    const updated = projection.apply(form, event);
    const repNode = treeRepeaters(updated.root).get('server:c[1]')!;
    expect(repNode.properties.totalRowCount).toBe(42);
  });

  it('applies PropertyChanged to tree fields', () => {
    // Build a form with a real field in the tree. The field lands at server:c[0]
    // (first child of the lf root).
    const root = buildFormTree({
      t: 'lf', ServerId: 'f1', PageType: 0,
      Children: [{ t: 'sc', Caption: 'Name', Editable: true, Visible: true }],
    });
    const form: FormState = { ...makeForm(), root };
    const event: BCEvent = {
      type: 'PropertyChanged', formId: 'f1', controlPath: 'server:c[0]',
      changes: { StringValue: 'Hello', Caption: 'Name', Editable: true, Visible: true },
    };
    const updated = projection.apply(form, event);
    const field = treeFields(updated.root).find(f => f.controlPath === 'server:c[0]');
    expect(field).toBeDefined();
    expect(field!.properties.stringValue).toBe('Hello');
    expect(field!.properties.caption).toBe('Name');
  });

  it('applies BookmarkChanged to correct repeater', () => {
    const form = makeRepeaterForm();
    const event: BCEvent = {
      type: 'BookmarkChanged', formId: 'f1', controlPath: 'server:c[1]', bookmark: 'bm5',
    };
    const updated = projection.apply(form, event);
    const repNode = treeRepeaters(updated.root).get('server:c[1]')!;
    expect(repNode.properties.bookmark).toBe('bm5');
  });

  it('creates initial FormState', () => {
    const form = projection.createInitial('myForm', 'parentForm');
    expect(form.formId).toBe('myForm');
    expect(form.parentFormId).toBe('parentForm');
    expect(form.rows.size).toBe(0);
    expect(treeFields(form.root)).toHaveLength(0);
    expect(treeRepeaters(form.root).size).toBe(0);
  });

  it('updates existing field on repeated PropertyChanged', () => {
    // Build a form with a real field at server:c[0] so that PropertyChanged
    // events can mutate it via the tree.
    const root = buildFormTree({
      t: 'lf', ServerId: 'f1', PageType: 0,
      Children: [{ t: 'sc', Caption: 'Field1', Editable: false, Visible: true }],
    });
    let form: FormState = { ...makeForm(), root };
    form = projection.apply(form, {
      type: 'PropertyChanged', formId: 'f1', controlPath: 'server:c[0]',
      changes: { StringValue: 'first', Caption: 'Field1' },
    } as BCEvent);
    expect(treeFields(form.root)).toHaveLength(1);
    form = projection.apply(form, {
      type: 'PropertyChanged', formId: 'f1', controlPath: 'server:c[0]',
      changes: { StringValue: 'second' },
    } as BCEvent);
    expect(treeFields(form.root)).toHaveLength(1);
    expect(treeFields(form.root)[0]!.properties.stringValue).toBe('second');
    expect(treeFields(form.root)[0]!.properties.caption).toBe('Field1'); // preserved from first apply
  });

  // Finding 3 — abbreviated row-change tags must not drop the whole rowset.
  describe('abbreviated row change keys', () => {
    it('reads rows delivered as drich (DataRowInserted abbreviation)', () => {
      const form = makeRepeaterForm();
      const updated = projection.apply(form, {
        type: 'DataLoaded', formId: 'f1', controlPath: 'server:c[1]', currentRowOnly: false,
        rows: [
          { t: 'drich', drich: [0, { cells: { 'No.': '10000' }, bookmark: 'bm1' }] },
          { t: 'drich', drich: [1, { cells: { 'No.': '20000' }, bookmark: 'bm2' }] },
        ],
      } as BCEvent);
      const rows = updated.rows.get('server:c[1]')!;
      expect(rows.map(r => r.bookmark)).toEqual(['bm1', 'bm2']);
      expect(rows[0]!.cells['No.']).toBe('10000');
    });

    it('reads rows delivered as druch (DataRowUpdated abbreviation)', () => {
      const base = makeRepeaterForm();
      const form: FormState = {
        ...base,
        rows: new Map([['server:c[1]', [{ bookmark: 'bm1', cells: { 'No.': '10000' } }]]]),
      };
      const updated = projection.apply(form, {
        type: 'DataLoaded', formId: 'f1', controlPath: 'server:c[1]', currentRowOnly: true,
        rows: [{ t: 'druch', druch: [0, { cells: { 'No.': '10001' }, bookmark: 'bm1' }] }],
      } as BCEvent);
      expect(updated.rows.get('server:c[1]')![0]!.cells['No.']).toBe('10001');
    });

    it('reads removals delivered as drrch (DataRowRemoved abbreviation)', () => {
      const base = makeRepeaterForm();
      const form: FormState = {
        ...base,
        rows: new Map([['server:c[1]', [
          { bookmark: 'bm1', cells: {} },
          { bookmark: 'bm2', cells: {} },
        ]]]),
      };
      const updated = projection.apply(form, {
        type: 'DataLoaded', formId: 'f1', controlPath: 'server:c[1]', currentRowOnly: true,
        rows: [{ t: 'drrch', drrch: [1, { bookmark: 'bm2' }] }],
      } as BCEvent);
      expect(updated.rows.get('server:c[1]')!.map(r => r.bookmark)).toEqual(['bm1']);
    });

    it('accepts an abbreviated payload key even when `t` is missing', () => {
      const form = makeRepeaterForm();
      const updated = projection.apply(form, {
        type: 'DataLoaded', formId: 'f1', controlPath: 'server:c[1]', currentRowOnly: false,
        rows: [{ drich: [0, { cells: {}, bookmark: 'bmX' }] }],
      } as BCEvent);
      expect(updated.rows.get('server:c[1]')!.map(r => r.bookmark)).toEqual(['bmX']);
    });

    it('tolerates a malformed row payload without dropping its siblings', () => {
      const form = makeRepeaterForm();
      const updated = projection.apply(form, {
        type: 'DataLoaded', formId: 'f1', controlPath: 'server:c[1]', currentRowOnly: false,
        rows: [
          { t: 'drich', drich: [0, null] },
          { t: 'drich', drich: [1, { cells: {}, bookmark: 'bmOk' }] },
        ],
      } as BCEvent);
      expect(updated.rows.get('server:c[1]')!.map(r => r.bookmark)).toEqual(['bmOk']);
    });
  });

  // Finding 4 — the current-row bookmark arrives as `Data.CurrentBookmark`.
  describe('Data.CurrentBookmark', () => {
    it('maps Data.CurrentBookmark onto the repeater bookmark property', () => {
      const form = makeRepeaterForm();
      const updated = projection.apply(form, {
        type: 'PropertyChanged', formId: 'f1', controlPath: 'server:c[1]',
        changes: { 'Data.CurrentBookmark': '6e50f179-7956-4aef-b5cf-a425c1bd1c68' },
      } as BCEvent);
      const rep = treeRepeaters(updated.root).get('server:c[1]')!;
      expect(rep.properties.bookmark).toBe('6e50f179-7956-4aef-b5cf-a425c1bd1c68');
    });

    it('still honors the plain Bookmark name', () => {
      const form = makeRepeaterForm();
      const updated = projection.apply(form, {
        type: 'PropertyChanged', formId: 'f1', controlPath: 'server:c[1]',
        changes: { Bookmark: 'plain' },
      } as BCEvent);
      expect(treeRepeaters(updated.root).get('server:c[1]')!.properties.bookmark).toBe('plain');
    });
  });

  // Finding 5 — an unrecognized PropertyChanged must not invalidate view caches.
  describe('no-op PropertyChanged', () => {
    it('returns the SAME form and root when no tracked property changed', () => {
      const form = makeRepeaterForm();
      const before = treeRepeaters(form.root);
      const updated = projection.apply(form, {
        type: 'PropertyChanged', formId: 'f1', controlPath: 'server:c[1]',
        changes: { ValidationResults: [], SomethingCosmetic: 1 },
      } as BCEvent);
      expect(updated).toBe(form);
      expect(updated.root).toBe(form.root);
      // Same root reference => the memoised view is still the same object.
      expect(treeRepeaters(updated.root)).toBe(before);
    });

    it('returns the same form when the control path is unknown', () => {
      const form = makeRepeaterForm();
      const updated = projection.apply(form, {
        type: 'PropertyChanged', formId: 'f1', controlPath: 'server:c[404]',
        changes: { StringValue: 'x' },
      } as BCEvent);
      expect(updated).toBe(form);
    });

    it('DOES produce a new root when a tracked property changed', () => {
      const form = makeRepeaterForm();
      const updated = projection.apply(form, {
        type: 'PropertyChanged', formId: 'f1', controlPath: 'server:c[1]',
        changes: { TotalRowCount: 7 },
      } as BCEvent);
      expect(updated.root).not.toBe(form.root);
    });
  });

  // Finding 13 — option index tracking through PropertyChanged.
  describe('option fields', () => {
    function optionForm(): FormState {
      const root = buildFormTree({
        t: 'lf', ServerId: 'f1', PageType: 0,
        Children: [{
          t: 'sec', Caption: 'Status', StringValue: 'Started', CurrentIndex: 1,
          Items: [{ Text: 'Not Started', Value: '0' }, { Text: 'Started', Value: '1' }],
        }],
      });
      return { formId: 'f1', root, rows: new Map() };
    }

    it('updates optionIndex from CurrentIndex', () => {
      const updated = projection.apply(optionForm(), {
        type: 'PropertyChanged', formId: 'f1', controlPath: 'server:c[0]',
        changes: { StringValue: 'Not Started', CurrentIndex: 0 },
      } as BCEvent);
      const f = treeFields(updated.root)[0]!;
      expect(f.properties.optionIndex).toBe(0);
      expect(f.properties.stringValue).toBe('Not Started');
    });

    it('clears the stale optionIndex when the echo carries only StringValue', () => {
      const updated = projection.apply(optionForm(), {
        type: 'PropertyChanged', formId: 'f1', controlPath: 'server:c[0]',
        changes: { StringValue: 'Not Started' },
      } as BCEvent);
      const f = treeFields(updated.root)[0]!;
      expect(f.properties.optionIndex).toBeUndefined();
      expect(f.properties.options).toHaveLength(2); // build-time options survive
    });
  });

  // Finding 15 — blank bookmarks are not an identity.
  describe('currentRowOnly merge with blank bookmarks', () => {
    it('appends blank-bookmark upserts instead of patching the first blank row', () => {
      const base = makeRepeaterForm();
      const form: FormState = {
        ...base,
        rows: new Map([['server:c[1]', [
          { bookmark: '', cells: { 'No.': 'A' } },
          { bookmark: '', cells: { 'No.': 'B' } },
        ]]]),
      };
      const updated = projection.apply(form, {
        type: 'DataLoaded', formId: 'f1', controlPath: 'server:c[1]', currentRowOnly: true,
        rows: [{ t: 'DataRowInserted', DataRowInserted: [2, { cells: { 'No.': 'C' } }] }],
      } as BCEvent);
      const rows = updated.rows.get('server:c[1]')!;
      expect(rows.map(r => r.cells['No.'])).toEqual(['A', 'B', 'C']);
    });

    it('appends every blank-bookmark upsert in a batch (no collapse into one)', () => {
      const base = makeRepeaterForm();
      const form: FormState = { ...base, rows: new Map([['server:c[1]', []]]) };
      const updated = projection.apply(form, {
        type: 'DataLoaded', formId: 'f1', controlPath: 'server:c[1]', currentRowOnly: true,
        rows: [
          { t: 'DataRowInserted', DataRowInserted: [0, { cells: { 'No.': 'X' } }] },
          { t: 'DataRowInserted', DataRowInserted: [1, { cells: { 'No.': 'Y' } }] },
        ],
      } as BCEvent);
      expect(updated.rows.get('server:c[1]')!.map(r => r.cells['No.'])).toEqual(['X', 'Y']);
    });

    it('still patches bookmarked rows by bookmark', () => {
      const base = makeRepeaterForm();
      const form: FormState = {
        ...base,
        rows: new Map([['server:c[1]', [
          { bookmark: '', cells: { 'No.': 'blank' } },
          { bookmark: 'bm1', cells: { 'No.': 'old' } },
        ]]]),
      };
      const updated = projection.apply(form, {
        type: 'DataLoaded', formId: 'f1', controlPath: 'server:c[1]', currentRowOnly: true,
        rows: [{ t: 'DataRowUpdated', DataRowUpdated: [1, { cells: { 'No.': 'new' }, bookmark: 'bm1' }] }],
      } as BCEvent);
      const rows = updated.rows.get('server:c[1]')!;
      expect(rows).toHaveLength(2);
      expect(rows.map(r => r.cells['No.'])).toEqual(['blank', 'new']);
    });
  });
});
