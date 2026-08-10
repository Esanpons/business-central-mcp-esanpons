// tests/protocol/row-mapping.test.ts
//
// Row cells are keyed by columnBinderName on the wire and by CAPTION in MCP output.
// The remap therefore has to produce keys that are unique — a collision silently
// drops a column's values from every row.

import { describe, it, expect } from 'vitest';
import { buildBinderToCaptionMap, mapRowCellKeys, remapCells } from '../../src/protocol/row-mapping.js';
import type { RepeaterColumn } from '../../src/protocol/types.js';

const col = (columnBinderName: string, caption: string): RepeaterColumn =>
  ({ controlPath: `server:c[0]/co[${columnBinderName}]`, caption, type: 'rcc', columnBinderName });

describe('buildBinderToCaptionMap', () => {
  it('maps binder names to captions', () => {
    const map = buildBinderToCaptionMap([col('c1', 'No.'), col('c2', 'Description')]);
    expect(map.get('c1')).toBe('No.');
    expect(map.get('c2')).toBe('Description');
  });

  it('disambiguates duplicate captions with an ordinal', () => {
    const map = buildBinderToCaptionMap([col('c1', 'Amount'), col('c2', 'Amount')]);
    expect([...map.values()]).toEqual(['Amount', 'Amount#2']);
  });

  it('never generates a key that collides with a REAL caption', () => {
    // A repeater that genuinely ships a column captioned "Amount#2" used to end up
    // with two columns claiming the same cell key.
    const map = buildBinderToCaptionMap([col('c1', 'Amount'), col('c2', 'Amount#2'), col('c3', 'Amount')]);
    const values = [...map.values()];
    expect(new Set(values).size).toBe(values.length);
    expect(values).toEqual(['Amount', 'Amount#2', 'Amount#3']);
  });

  it('falls back to the binder name for a caption-less column', () => {
    const map = buildBinderToCaptionMap([col('c9', '')]);
    expect(map.get('c9')).toBe('c9');
  });
});

describe('mapRowCellKeys / remapCells', () => {
  it('rekeys cells and unwraps BC cell objects', () => {
    const rows = mapRowCellKeys(
      [{ bookmark: 'B1', cells: { c1: { stringValue: 'ITEM1' }, c2: { objectValue: 5 } } }],
      [col('c1', 'No.'), col('c2', 'Quantity')],
    );
    expect(rows[0]!.cells).toEqual({ 'No.': 'ITEM1', Quantity: 5 });
  });

  it('keeps unknown keys as-is', () => {
    expect(remapCells({ zz: 'x' }, new Map())).toEqual({ zz: 'x' });
  });
});
