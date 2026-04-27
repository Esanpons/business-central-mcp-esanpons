// tests/protocol/form-tree-builder.test.ts
import { describe, it, expect } from 'vitest';
import { buildFormTree } from '../../src/protocol/form-tree-builder.js';
import { isLogicalFormNode, isGroupNode, isFieldNode, isActionNode, isRepeaterNode } from '../../src/protocol/form-node.js';
import type { FormNode } from '../../src/protocol/form-node.js';

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
