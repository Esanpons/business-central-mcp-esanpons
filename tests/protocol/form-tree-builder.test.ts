// tests/protocol/form-tree-builder.test.ts
import { describe, it, expect } from 'vitest';
import { buildFormTree } from '../../src/protocol/form-tree-builder.js';
import { isLogicalFormNode, isGroupNode, isFieldNode } from '../../src/protocol/form-node.js';
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
