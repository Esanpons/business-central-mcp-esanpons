// tests/protocol/form-tree-builder.test.ts
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { buildFormTree } from '../../src/protocol/form-tree-builder.js';
import { isLogicalFormNode, isGroupNode, isFieldNode, isActionNode, isRepeaterNode } from '../../src/protocol/form-node.js';
import type { FormNode } from '../../src/protocol/form-node.js';
import { findByControlPath } from '../../src/protocol/form-tree-walk.js';
import { applyPropertyChange, buildPathIndex } from '../../src/protocol/form-tree-mutator.js';
import { fields, actions, groupVisibility } from '../../src/protocol/form-views.js';

const __dirname = dirname(fileURLToPath(import.meta.url));

describe('buildFormTree — root + groups', () => {
  it('returns a LogicalFormNode for the lf root', () => {
    const raw = { t: 'lf', ServerId: 'F1', Caption: 'Page', PageType: 0, Children: [] };
    const root = buildFormTree(raw);
    expect(isLogicalFormNode(root)).toBe(true);
    expect(root.controlPath).toBe('server:');
    if (isLogicalFormNode(root)) {
      expect(root.serverId).toBe('F1');
      expect(root.pageType).toBe('Card');
      expect(root.properties.caption).toBe('Page');
    }
  });

  it('builds nested gc nodes with correct controlPaths', () => {
    const raw = {
      t: 'lf', ServerId: 'F1', PageType: 0, Children: [
        { t: 'gc', Caption: 'Outer', Children: [
          { t: 'gc', Caption: 'Inner', Children: [] },
        ] },
      ],
    };
    const root = buildFormTree(raw);
    expect(isLogicalFormNode(root)).toBe(true);
    if (!isLogicalFormNode(root)) return;
    const outer = root.children[0]!;
    expect(isGroupNode(outer)).toBe(true);
    expect(outer.controlPath).toBe('server:c[0]');
    if (!isGroupNode(outer)) return;
    const inner = outer.children[0]!;
    expect(inner.controlPath).toBe('server:c[0]/c[0]');
    expect(inner.properties.caption).toBe('Inner');
  });

  it('returns Unknown pageType for unmapped wire values', () => {
    const raw = { t: 'lf', ServerId: 'F1', PageType: 999, Children: [] };
    const root = buildFormTree(raw);
    if (isLogicalFormNode(root)) expect(root.pageType).toBe('Unknown');
  });
});

describe('buildFormTree — fields', () => {
  it('builds FieldNode for each FIELD_TYPES variant', () => {
    const raw = {
      t: 'lf', ServerId: 'F1', PageType: 0, Children: [
        { t: 'sc', Caption: 'StringField', StringValue: 'hi', Editable: true, ColumnBinder: { Name: 'b1' } },
        { t: 'dc', Caption: 'DecField', StringValue: '12.34' },
        { t: 'bc', Caption: 'BoolField', StringValue: 'true' },
        { t: 'ssc', Caption: 'StaticString' },
      ],
    };
    const root = buildFormTree(raw);
    if (!('children' in root)) throw new Error('expected children');
    const fields = root.children.filter(isFieldNode);
    expect(fields.length).toBe(4);
    expect(fields[0]!.type).toBe('sc');
    expect(fields[0]!.properties.stringValue).toBe('hi');
    expect(fields[0]!.properties.editable).toBe(true);
    expect(fields[0]!.columnBinder?.name).toBe('b1');
    expect(fields[3]!.type).toBe('ssc');
  });

  it('skips ssc spacers (no caption, no binder)', () => {
    const raw = { t: 'lf', ServerId: 'F1', PageType: 0, Children: [
      { t: 'ssc' },
      { t: 'ssc', Caption: 'real text' },
    ] };
    const root = buildFormTree(raw);
    if (!('children' in root)) throw new Error('expected children');
    const fields = root.children.filter(isFieldNode);
    expect(fields.length).toBe(1);
    expect(fields[0]!.properties.caption).toBe('real text');
  });

  it('skips MappingHint=PlaceholderField fields', () => {
    const raw = { t: 'lf', ServerId: 'F1', PageType: 0, Children: [
      { t: 'sc', Caption: 'real', ColumnBinder: { Name: 'b' } },
      { t: 'sc', Caption: 'placeholder', MappingHint: 'PlaceholderField' },
    ] };
    const root = buildFormTree(raw);
    if (!('children' in root)) throw new Error('expected children');
    const fields = root.children.filter(isFieldNode);
    expect(fields.length).toBe(1);
    expect(fields[0]!.properties.caption).toBe('real');
  });

  it('reads ExpressionProperties.Visible when top-level Visible is absent', () => {
    const raw = { t: 'lf', ServerId: 'F1', PageType: 0, Children: [
      { t: 'sc', Caption: 'x', ExpressionProperties: { Visible: true } },
    ] };
    const root = buildFormTree(raw);
    if (!('children' in root)) throw new Error('expected children');
    const f = root.children[0] as FormNode;
    expect(f.properties.visible).toBe(true);
  });
});

describe('buildFormTree — actions', () => {
  it('builds ActionNode with systemAction + iconIdentifier', () => {
    const raw = { t: 'lf', ServerId: 'F1', PageType: 9, Children: [
      { t: 'ac', Caption: '&Next', SystemAction: 0, Icon: { Identifier: 'Actions/NextRecord/16.png' } },
    ] };
    const root = buildFormTree(raw);
    if (!('children' in root)) throw new Error('expected children');
    const action = root.children.find(isActionNode);
    expect(action).toBeDefined();
    expect(action!.systemAction).toBe(0);
    expect(action!.iconIdentifier).toBe('Actions/NextRecord/16.png');
    expect(action!.properties.caption).toBe('&Next');
    expect(action!.isLineScoped).toBe(false);
  });

  it('walks sub-actions inside an ActionNode\'s Children', () => {
    const raw = { t: 'lf', ServerId: 'F1', PageType: 0, Children: [
      { t: 'ac', Caption: 'Menu', Children: [
        { t: 'ac', Caption: 'Item1', SystemAction: 10 },
        { t: 'ac', Caption: 'Item2', SystemAction: 20 },
      ] },
    ] };
    const root = buildFormTree(raw);
    if (!('children' in root)) throw new Error('expected children');
    const menu = root.children[0] as FormNode;
    if (!isActionNode(menu)) throw new Error('expected ActionNode');
    expect(menu.children.length).toBe(2);
    expect(menu.children[0]!.properties.caption).toBe('Item1');
    expect(menu.children[1]!.systemAction).toBe(20);
  });

  it('marks actions inside a repeater as line-scoped', () => {
    const raw = { t: 'lf', ServerId: 'F1', PageType: 1, Children: [
      { t: 'rc', Children: [
        { t: 'ac', Caption: 'RowAction', SystemAction: 20 },
      ], Columns: [] },
    ] };
    const root = buildFormTree(raw);
    if (!('children' in root)) throw new Error('expected children');
    const rep = root.children[0] as FormNode;
    if (rep.type !== 'rc' || !('children' in rep)) throw new Error('expected RepeaterNode');
    const action = rep.children.find(isActionNode);
    expect(action?.isLineScoped).toBe(true);
  });
});

describe('buildFormTree — repeaters', () => {
  it('builds RepeaterNode with columns', () => {
    const raw = { t: 'lf', ServerId: 'F1', PageType: 1, Children: [
      { t: 'rc', Columns: [
        { t: 'rcc', Caption: 'No.', ColumnBinder: { Name: 'no' } },
        { t: 'rcc', Caption: 'Name', ColumnBinder: { Name: 'name' } },
      ], Children: [] },
    ] };
    const root = buildFormTree(raw);
    if (!('children' in root)) throw new Error();
    const rep = root.children.find(isRepeaterNode);
    expect(rep).toBeDefined();
    expect(rep!.columns.length).toBe(2);
    expect(rep!.columns[0]!.controlPath).toBe('server:c[0]/co[0]');
    expect(rep!.columns[0]!.properties.caption).toBe('No.');
    expect(rep!.columns[0]!.columnBinder?.name).toBe('no');
  });

  it('skips placeholder columns (MappingHint=PlaceholderField)', () => {
    const raw = { t: 'lf', ServerId: 'F1', PageType: 1, Children: [
      { t: 'rc', Columns: [
        { t: 'rcc', Caption: 'real', ColumnBinder: { Name: 'r' } },
        { t: 'rcc', MappingHint: 'PlaceholderField' },
      ], Children: [] },
    ] };
    const root = buildFormTree(raw);
    if (!('children' in root)) throw new Error();
    const rep = root.children.find(isRepeaterNode);
    expect(rep!.columns.length).toBe(1);
  });
});

import { isFormHostNode } from '../../src/protocol/form-node.js';

describe('buildFormTree — fhc + filc', () => {
  it('captures hosted form ServerId without descending into the lf subtree', () => {
    const raw = { t: 'lf', ServerId: 'F1', PageType: 0, Children: [
      { t: 'fhc', Caption: 'Factbox', Children: [
        { t: 'lf', ServerId: 'CHILD1', Caption: 'Customer Stats', PageType: 3, IsSubForm: false, IsPart: true, Children: [] },
      ] },
    ] };
    const root = buildFormTree(raw);
    if (!('children' in root)) throw new Error();
    const fhc = root.children.find(isFormHostNode);
    expect(fhc).toBeDefined();
    expect(fhc!.hostedFormServerId).toBe('CHILD1');
    expect(fhc!.hostedFormCaption).toBe('Customer Stats');
    expect(fhc!.hostedFormIsPart).toBe(true);
  });

  it('builds a FilterNode for filc', () => {
    const raw = { t: 'lf', ServerId: 'F1', PageType: 1, Children: [
      { t: 'filc', Caption: 'Filter' },
    ] };
    const root = buildFormTree(raw);
    if (!('children' in root)) throw new Error();
    const filter = root.children[0]!;
    expect(filter.type).toBe('filc');
  });
});

// -- Finding 7: a tagless node must not drop its subtree --

describe('buildFormTree — tagless nodes', () => {
  it('builds the children of a node that carries no `t`', () => {
    const raw = {
      t: 'lf', ServerId: 'F1', PageType: 0, Children: [
        // No `t`: BC occasionally emits a bare container. Its descendants must
        // still get controlPaths, otherwise PropertyChanged on them no-ops.
        { Caption: 'Tagless', Children: [{ t: 'sc', Caption: 'Inner Field' }] },
      ],
    };
    const root = buildFormTree(raw);
    if (!('children' in root)) throw new Error('root has no children');
    const tagless = root.children[0]!;
    expect(tagless.controlPath).toBe('server:c[0]');
    expect('children' in tagless && tagless.children).toHaveLength(1);
    const inner = findByControlPath(root, 'server:c[0]/c[0]');
    expect(inner).toBeDefined();
    expect(inner!.properties.caption).toBe('Inner Field');
  });

  it('exposes tagless-node descendants to the fields() view', () => {
    const root = buildFormTree({
      t: 'lf', ServerId: 'F1', PageType: 0, Children: [
        { Children: [{ t: 'sc', Caption: 'Deep' }] },
      ],
    });
    expect(fields(root).map(f => f.properties.caption)).toEqual(['Deep']);
  });
});

// -- Finding 6: repeater HeaderActions (ha[N]) --

describe('buildFormTree — repeater HeaderActions', () => {
  // Shape taken from src/protocol/captures/cuegroup-rolecenter-2026-04-28.json
  const rawWithHeaderActions = {
    t: 'lf', ServerId: 'F1', PageType: 1, Children: [
      {
        t: 'rc', Caption: 'Lines',
        Columns: [{ t: 'rcc', Caption: 'No.', ColumnBinder: { Name: 'no' } }],
        Children: [],
        HeaderActions: [
          { t: 'ac', Caption: 'Open', Enabled: false, Icon: { Identifier: 'Actions/ViewDetails/16.png' } },
          { t: 'ac', Caption: 'Edit', Enabled: true, SystemAction: 40 },
        ],
      },
    ],
  };

  function repeaterOf(root: FormNode) {
    if (!('children' in root)) throw new Error('root has no children');
    const rep = root.children[0]!;
    if (!isRepeaterNode(rep)) throw new Error('expected a repeater');
    return rep;
  }

  it('parses HeaderActions into ActionNodes at the ha[N] path', () => {
    const rep = repeaterOf(buildFormTree(rawWithHeaderActions));
    expect(rep.headerActions).toHaveLength(2);
    expect(rep.headerActions.map(a => a.controlPath)).toEqual(['server:c[0]/ha[0]', 'server:c[0]/ha[1]']);
    expect(rep.headerActions[0]!.properties.caption).toBe('Open');
    expect(rep.headerActions[0]!.properties.enabled).toBe(false);
    expect(rep.headerActions[0]!.iconIdentifier).toBe('Actions/ViewDetails/16.png');
    expect(rep.headerActions[1]!.systemAction).toBe(40);
  });

  it('marks header actions as line-scoped (they operate on the current row)', () => {
    const root = buildFormTree(rawWithHeaderActions);
    const open = findByControlPath(root, 'server:c[0]/ha[0]')!;
    expect(isActionNode(open)).toBe(true);
    if (isActionNode(open)) expect(open.isLineScoped).toBe(true);
  });

  it('surfaces header actions through the actions() view', () => {
    const root = buildFormTree(rawWithHeaderActions);
    expect(actions(root).map(a => a.properties.caption)).toEqual(['Open', 'Edit']);
  });

  it('indexes header actions in buildPathIndex', () => {
    const idx = buildPathIndex(buildFormTree(rawWithHeaderActions));
    expect(idx.get('server:c[0]/ha[1]')?.properties.caption).toBe('Edit');
  });

  it('defaults to an empty array when the repeater has no HeaderActions', () => {
    const rep = repeaterOf(buildFormTree({
      t: 'lf', ServerId: 'F1', PageType: 1, Children: [{ t: 'rc', Columns: [], Children: [] }],
    }));
    expect(rep.headerActions).toEqual([]);
  });

  it('resolves a PropertyChanged on an ha[N] path', () => {
    const root = buildFormTree(rawWithHeaderActions);
    const updated = applyPropertyChange(root, 'server:c[0]/ha[0]', { enabled: true });
    expect(updated).not.toBe(root);
    const changed = findByControlPath(updated, 'server:c[0]/ha[0]')!;
    expect(changed.properties.enabled).toBe(true);
    expect(changed.properties.caption).toBe('Open');           // merged, not replaced
    // Sibling reused by reference (structural sharing).
    expect(findByControlPath(updated, 'server:c[0]/ha[1]')).toBe(findByControlPath(root, 'server:c[0]/ha[1]'));
  });

  it('parses HeaderActions off the live Role Center capture', () => {
    const capture = JSON.parse(
      readFileSync(resolve(__dirname, '../../src/protocol/captures/cuegroup-rolecenter-2026-04-28.json'), 'utf8'),
    ) as Array<{ type: string; controlTree?: unknown }>;
    const formCreated = capture.find(e => e.type === 'FormCreated' && e.controlTree)!;
    // Header actions live inside hosted CardPart trees; pull the raw rc nodes
    // carrying HeaderActions and rebuild one standalone.
    const rcs: Array<Record<string, unknown>> = [];
    (function scan(o: unknown): void {
      if (!o || typeof o !== 'object') return;
      if (Array.isArray(o)) { o.forEach(scan); return; }
      const rec = o as Record<string, unknown>;
      if (rec.t === 'rc' && Array.isArray(rec.HeaderActions)) rcs.push(rec);
      for (const v of Object.values(rec)) scan(v);
    })(formCreated.controlTree);
    expect(rcs.length).toBeGreaterThan(0);
    const rep = repeaterOf(buildFormTree({ t: 'lf', ServerId: 'X', PageType: 3, Children: [rcs[0]] }));
    expect(rep.headerActions.length).toBeGreaterThan(0);
    expect(rep.headerActions[0]!.properties.caption).toBeTruthy();
  });
});

// -- Finding 13: option/enum Items --

describe('buildFormTree — option fields', () => {
  it('parses Items + CurrentIndex on a sec control', () => {
    const root = buildFormTree({
      t: 'lf', ServerId: 'F1', PageType: 0, Children: [{
        t: 'sec', Caption: 'Status', StringValue: 'Started', CurrentIndex: 1,
        Items: [
          { Text: 'Not Started', Value: '0' },
          { Text: 'Started', Value: '1' },
          { Text: 'Completed', Value: '3' },
        ],
      }],
    });
    const field = fields(root)[0]!;
    expect(field.properties.options).toEqual([
      { text: 'Not Started', value: '0' },
      { text: 'Started', value: '1' },
      { text: 'Completed', value: '3' },
    ]);
    expect(field.properties.optionIndex).toBe(1);
  });

  it('parses boolean (bc) Items as No/Yes options', () => {
    const root = buildFormTree({
      t: 'lf', ServerId: 'F1', PageType: 0, Children: [{
        t: 'bc', Caption: 'Mark as completed', CurrentIndex: -1,
        Items: [{ Text: 'No', Value: 'False' }, { Text: 'Yes', Value: 'True' }],
      }],
    });
    const field = fields(root)[0]!;
    expect(field.properties.options!.map(o => o.value)).toEqual(['False', 'True']);
    expect(field.properties.optionIndex).toBe(-1);
  });

  it('leaves options undefined on a plain string control', () => {
    const root = buildFormTree({
      t: 'lf', ServerId: 'F1', PageType: 0, Children: [{ t: 'sc', Caption: 'Name' }],
    });
    expect(fields(root)[0]!.properties.options).toBeUndefined();
  });

  it('propagates row-template options onto the matching rcc column (Children)', () => {
    const root = buildFormTree({
      t: 'lf', ServerId: 'F1', PageType: 1, Children: [{
        t: 'rc',
        Columns: [
          { t: 'rcc', Caption: 'Status', ColumnBinder: { Name: 'b_status' } },
          { t: 'rcc', Caption: 'Name', ColumnBinder: { Name: 'b_name' } },
        ],
        Children: [
          { t: 'sec', Caption: 'Status', ColumnBinder: { Name: 'b_status' }, Items: [{ Text: 'Open', Value: '0' }] },
        ],
      }],
    });
    if (!('children' in root)) throw new Error('root has no children');
    const rep = root.children[0]!;
    if (!isRepeaterNode(rep)) throw new Error('expected a repeater');
    expect(rep.columns[0]!.properties.options).toEqual([{ text: 'Open', value: '0' }]);
    expect(rep.columns[1]!.properties.options).toBeUndefined();
  });

  it('propagates row-template options published under CurrentRow (live wire shape)', () => {
    const root = buildFormTree({
      t: 'lf', ServerId: 'F1', PageType: 1, Children: [{
        t: 'rc',
        Columns: [{ t: 'rcc', Caption: 'Status', ColumnBinder: { Name: 'b_status' } }],
        CurrentRow: {
          t: 'rrc',
          Children: [
            { t: 'sec', Caption: 'Status', ColumnBinder: { Name: 'b_status' }, Items: [{ Text: 'Skipped', Value: '2' }] },
          ],
        },
      }],
    });
    if (!('children' in root)) throw new Error('root has no children');
    const rep = root.children[0]!;
    if (!isRepeaterNode(rep)) throw new Error('expected a repeater');
    expect(rep.columns[0]!.properties.options).toEqual([{ text: 'Skipped', value: '2' }]);
  });
});

// -- Finding 14: ExpressionProperties.Visible fallback for every control kind --

describe('buildFormTree — ExpressionProperties.Visible fallback', () => {
  it('applies to a group container', () => {
    const root = buildFormTree({
      t: 'lf', ServerId: 'F1', PageType: 9, Children: [
        { t: 'gc', Caption: 'Step 2', ExpressionProperties: { Visible: false }, Children: [] },
      ],
    });
    const gc = findByControlPath(root, 'server:c[0]')!;
    expect(gc.properties.visible).toBe(false);
    expect(gc.properties.hasVisibleExpression).toBe(true);
    expect(groupVisibility(root).get('server:c[0]')).toBe(false);
  });

  it('applies to an action and a repeater', () => {
    const root = buildFormTree({
      t: 'lf', ServerId: 'F1', PageType: 1, Children: [
        { t: 'ac', Caption: 'Post', ExpressionProperties: { Visible: false } },
        { t: 'rc', Columns: [], Children: [], ExpressionProperties: { Visible: false } },
      ],
    });
    expect(findByControlPath(root, 'server:c[0]')!.properties.visible).toBe(false);
    expect(findByControlPath(root, 'server:c[1]')!.properties.visible).toBe(false);
  });

  it('still applies to fields (unchanged behaviour)', () => {
    const root = buildFormTree({
      t: 'lf', ServerId: 'F1', PageType: 0, Children: [
        { t: 'sc', Caption: 'Hidden', ExpressionProperties: { Visible: false } },
      ],
    });
    expect(fields(root)[0]!.properties.visible).toBe(false);
  });

  it('never overrides an explicit top-level Visible', () => {
    const root = buildFormTree({
      t: 'lf', ServerId: 'F1', PageType: 0, Children: [
        { t: 'gc', Caption: 'G', Visible: true, ExpressionProperties: { Visible: false }, Children: [] },
      ],
    });
    expect(findByControlPath(root, 'server:c[0]')!.properties.visible).toBe(true);
  });

  it('records hasVisibleExpression without inventing a visible value for a non-boolean expression', () => {
    const root = buildFormTree({
      t: 'lf', ServerId: 'F1', PageType: 0, Children: [
        { t: 'gc', Caption: 'G', ExpressionProperties: { Visible: 'SomeBinding' }, Children: [] },
      ],
    });
    const gc = findByControlPath(root, 'server:c[0]')!;
    expect(gc.properties.hasVisibleExpression).toBe(true);
    expect(gc.properties.visible).toBeUndefined();
  });
});
