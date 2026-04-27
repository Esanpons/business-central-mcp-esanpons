// tests/protocol/form-tree-builder.test.ts
import { describe, it, expect } from 'vitest';
import { buildFormTree } from '../../src/protocol/form-tree-builder.js';
import { isLogicalFormNode, isGroupNode } from '../../src/protocol/form-node.js';

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
