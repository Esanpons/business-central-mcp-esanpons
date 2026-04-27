// tests/protocol/form-tree-walk.test.ts
import { describe, it, expect } from 'vitest';
import { walkTree, findByControlPath, ancestorsOf, parentOf } from '../../src/protocol/form-tree-walk.js';
import type { FormNode } from '../../src/protocol/form-node.js';

function tree(): FormNode {
  return {
    type: 'lf', controlPath: 'server:', serverId: '1', pageType: 'Card',
    properties: { caption: 'Root' },
    children: [
      { type: 'gc', controlPath: 'server:c[0]', properties: { caption: 'Group' }, children: [
        { type: 'sc', controlPath: 'server:c[0]/c[0]', properties: { caption: 'A' } },
        { type: 'sc', controlPath: 'server:c[0]/c[1]', properties: { caption: 'B' } },
      ] },
    ],
  };
}

describe('walkTree', () => {
  it('yields every node in pre-order', () => {
    const paths = [...walkTree(tree())].map(n => n.controlPath);
    expect(paths).toEqual(['server:', 'server:c[0]', 'server:c[0]/c[0]', 'server:c[0]/c[1]']);
  });
});

describe('findByControlPath', () => {
  it('locates nested nodes by path', () => {
    const found = findByControlPath(tree(), 'server:c[0]/c[1]');
    expect(found?.properties.caption).toBe('B');
  });
  it('returns undefined for unknown paths', () => {
    expect(findByControlPath(tree(), 'server:c[42]')).toBeUndefined();
  });
});

describe('parentOf', () => {
  it('returns parent + index for a child node', () => {
    const r = parentOf(tree(), 'server:c[0]/c[1]');
    expect(r?.parent.controlPath).toBe('server:c[0]');
    expect(r?.index).toBe(1);
  });
  it('returns undefined for the root itself', () => {
    expect(parentOf(tree(), 'server:')).toBeUndefined();
  });
});

describe('ancestorsOf', () => {
  it('returns the full ancestor chain in document order', () => {
    const chain = ancestorsOf(tree(), 'server:c[0]/c[1]');
    expect(chain.map(n => n.controlPath)).toEqual(['server:', 'server:c[0]']);
  });
  it('returns empty array for the root', () => {
    expect(ancestorsOf(tree(), 'server:')).toEqual([]);
  });
});
