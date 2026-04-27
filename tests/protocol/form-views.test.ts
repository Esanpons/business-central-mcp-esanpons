// tests/protocol/form-views.test.ts
import { describe, it, expect } from 'vitest';
import { buildFormTree } from '../../src/protocol/form-tree-builder.js';
import { fields, actions, repeaters, tabs, groupVisibility } from '../../src/protocol/form-views.js';

const sample = {
  t: 'lf', ServerId: 'F1', PageType: 0, Caption: 'Card', Children: [
    { t: 'gc', Children: [], MappingHint: 'TOOLBAR' },
    { t: 'gc', Caption: 'General', Children: [
      { t: 'sc', Caption: 'Name', ColumnBinder: { Name: 'n' } },
      { t: 'sc', Caption: 'City', Visible: false, ColumnBinder: { Name: 'c' } },
    ] },
    { t: 'ac', Caption: 'Refresh', SystemAction: 30 },
    { t: 'rc', Columns: [{ t: 'rcc', Caption: 'No.', ColumnBinder: { Name: 'no' } }], Children: [] },
  ],
};

describe('form-views', () => {
  it('fields() returns every FieldNode in document order', () => {
    const root = buildFormTree(sample);
    const list = fields(root);
    expect(list.map(f => f.properties.caption)).toEqual(['Name', 'City']);
  });

  it('actions() returns every ActionNode (including nested)', () => {
    const root = buildFormTree(sample);
    expect(actions(root).map(a => a.properties.caption)).toEqual(['Refresh']);
  });

  it('repeaters() keys by controlPath', () => {
    const root = buildFormTree(sample);
    const r = repeaters(root);
    expect(r.size).toBe(1);
    expect([...r.keys()]).toEqual(['server:c[3]']);
  });

  it('tabs() excludes toolbar/actionbar gcs and groups without captions', () => {
    const root = buildFormTree(sample);
    const t = tabs(root);
    expect(t.length).toBe(1);
    expect(t[0]!.caption).toBe('General');
    expect(t[0]!.fields.map(f => f.properties.caption)).toEqual(['Name', 'City']);
  });

  it('groupVisibility() records every gc encountered', () => {
    const root = buildFormTree(sample);
    const g = groupVisibility(root);
    expect(g.has('server:c[0]')).toBe(true);
    expect(g.has('server:c[1]')).toBe(true);
    expect(g.get('server:c[1]')).toBe(true); // default-true when Visible absent
  });

  it('memoises results — same root reference yields same array reference', () => {
    const root = buildFormTree(sample);
    expect(fields(root)).toBe(fields(root));
  });
});
