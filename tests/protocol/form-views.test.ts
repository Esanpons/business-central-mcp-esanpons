// tests/protocol/form-views.test.ts
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { buildFormTree } from '../../src/protocol/form-tree-builder.js';
import { fields, actions, repeaters, tabs, groupVisibility, cues, type CueView } from '../../src/protocol/form-views.js';

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

describe('cues view', () => {
  const tree = buildFormTree({
    t: 'lf', ServerId: 'rc', PageType: 2,
    Children: [
      {
        t: 'stackgc', Caption: 'Documents', DesignName: 'DocumentQueue',
        Children: [{
          t: 'gc', MappingHint: 'STACKGROUP',
          Children: [
            { t: 'stackc', Caption: 'Failed', StringValue: '3', HasAction: true, ColumnBinder: { Name: 'a' } },
            { t: 'stackc', Caption: 'Pending', StringValue: '12', HasAction: true, ColumnBinder: { Name: 'b' } },
          ],
        }],
      },
      {
        t: 'stackgc', Caption: 'Print', DesignName: 'PrintQueue',
        Children: [{
          t: 'gc', MappingHint: 'STACKGROUP',
          Children: [
            { t: 'stackc', Caption: 'Printed', StringValue: '99', HasAction: true, ColumnBinder: { Name: 'c' } },
          ],
        }],
      },
      // Non-cue gc with same Caption to ensure we don't pick up regular fields
      {
        t: 'gc', Caption: 'NotACueGroup',
        Children: [{ t: 'sc', Caption: 'Note', StringValue: 'hi' }],
      },
    ],
  });

  it('collects cues across all stackgcs in the tree', () => {
    const result = cues(tree);
    expect(result.map(c => c.caption)).toEqual(['Failed', 'Pending', 'Printed']);
  });

  it('extracts groupCaption from the parent stackgc', () => {
    const result = cues(tree);
    expect(result[0]!.groupCaption).toBe('Documents');
    expect(result[2]!.groupCaption).toBe('Print');
  });

  it('extracts value (stringValue) per cue', () => {
    const result = cues(tree);
    expect(result[0]!.value).toBe('3');
    expect(result[1]!.value).toBe('12');
    expect(result[2]!.value).toBe('99');
  });

  it('returns identical reference on repeated calls (memoisation)', () => {
    expect(cues(tree)).toBe(cues(tree));
  });

  it('returns [] for a tree with no cuegroups', () => {
    const empty = buildFormTree({ t: 'lf', ServerId: 'x', PageType: 0, Children: [] });
    expect(cues(empty)).toEqual([]);
  });

  it('parses live fixture: >=1 cuegroup, >=1 cue field across hosted CardParts', () => {
    const fixturePath = resolve(__dirname, '../../src/protocol/captures/cuegroup-rolecenter-2026-04-28.json');
    const fixtureEvents = JSON.parse(readFileSync(fixturePath, 'utf8')) as Array<Record<string, unknown>>;
    const rc = fixtureEvents.find(e => e.type === 'FormCreated' && !e.parentFormId);
    expect(rc).toBeDefined();

    // Walk fhc children
    function findFhcLfs(node: unknown, results: unknown[] = []): unknown[] {
      if (!node || typeof node !== 'object') return results;
      const obj = node as Record<string, unknown>;
      if (obj.t === 'fhc') {
        const cs = obj.Children as unknown[] | undefined;
        if (Array.isArray(cs) && cs[0]) results.push(cs[0]);
      }
      const cs = obj.Children as unknown[] | undefined;
      if (Array.isArray(cs)) for (const c of cs) findFhcLfs(c, results);
      return results;
    }
    const hosted = findFhcLfs((rc as Record<string, unknown>).controlTree);

    let totalCues = 0;
    for (const lf of hosted) {
      const tree = buildFormTree(lf);
      totalCues += cues(tree).length;
    }
    expect(totalCues).toBeGreaterThan(0);
  });
});

// Type-only check — ensures CueView export shape stays stable.
const _typecheck: CueView | undefined = undefined;
void _typecheck;
