// tests/protocol/cue-detection.test.ts
import { describe, it, expect } from 'vitest';
import {
  isCueGroupNode,
  isCueFieldNode,
  cueDrillDownPath,
} from '../../src/protocol/cue-detection.js';
import { buildFormTree } from '../../src/protocol/form-tree-builder.js';
import { walkTree } from '../../src/protocol/form-tree-walk.js';

const fixture = {
  t: 'lf',
  ServerId: 'rc',
  PageType: 2,
  Children: [
    {
      t: 'stackgc',
      Caption: 'Group',
      DesignName: 'TestGroup',
      Children: [
        {
          t: 'gc',
          MappingHint: 'STACKGROUP',
          Children: [
            {
              t: 'stackc',
              Caption: 'Cue1',
              StringValue: '3',
              HasAction: true,
              ColumnBinder: { Name: 'b1' },
            },
          ],
        },
      ],
    },
  ],
};

describe('cue-detection', () => {
  const tree = buildFormTree(fixture);
  const nodes = [...walkTree(tree)];

  it('isCueGroupNode true for stackgc, false for inner gc', () => {
    const stackgcs = nodes.filter(isCueGroupNode);
    expect(stackgcs).toHaveLength(1);
  });

  it('isCueFieldNode true for stackc only', () => {
    const cueFields = nodes.filter(isCueFieldNode);
    expect(cueFields).toHaveLength(1);
    expect(cueFields[0]!.properties.caption).toBe('Cue1');
  });

  it('cueDrillDownPath returns the cue field controlPath', () => {
    const cue = nodes.find(isCueFieldNode)!;
    expect(cueDrillDownPath(cue)).toBe(cue.controlPath);
  });
});
