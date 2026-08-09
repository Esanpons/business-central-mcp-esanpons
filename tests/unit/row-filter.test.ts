import { describe, it, expect } from 'vitest';
import { matchesFilterValue, filterRows, resolveCellKey, cellText } from '../../src/protocol/row-filter.js';

// G8 — the matcher behind line/subpage filtering. It has to speak the same value
// syntax a BC user types, because that is what an agent will pass through.

describe('matchesFilterValue', () => {
  const cases: Array<[unknown, string, boolean, string]> = [
    // exact, case- and space-insensitive
    ['Item', 'item', true, 'exact match ignores case'],
    ['  Item ', 'Item', true, 'exact match ignores surrounding space'],
    ['Item', 'Resource', false, 'different value does not match'],
    ['', 'Item', false, 'empty cell does not match a value'],
    ['Item', '', true, 'an empty expression matches everything'],

    // wildcards
    ['CONSULTING LTD', '*consult*', true, 'substring wildcard'],
    ['CONSULTING LTD', 'consult*', true, 'prefix wildcard'],
    ['CONSULTING LTD', '*LTD', true, 'suffix wildcard'],
    ['CONSULTING LTD', '*banking*', false, 'wildcard that does not occur'],
    ['A1', 'A?', true, 'single-character wildcard'],
    ['A12', 'A?', false, 'single-character wildcard is not greedy'],

    // ranges
    ['10', '5..15', true, 'numeric range includes the value'],
    ['20', '5..15', false, 'numeric range excludes the value'],
    ['5', '5..15', true, 'range is inclusive at the low end'],
    ['15', '5..15', true, 'range is inclusive at the high end'],
    ['20000', '10000..', true, 'open-ended range (from)'],
    ['5000', '10000..', false, 'open-ended range (from) excludes lower'],
    ['5000', '..10000', true, 'open-ended range (to)'],
    ['C', 'A..D', true, 'string range'],

    // comparisons
    ['100', '>50', true, 'greater than'],
    ['100', '>100', false, 'greater than is strict'],
    ['100', '>=100', true, 'greater or equal'],
    ['10', '<50', true, 'less than'],
    ['10', '<=10', true, 'less or equal'],
    ['Item', '<>Resource', true, 'not equal matches a different value'],
    ['Item', '<>Item', false, 'not equal rejects the same value'],

    // sets
    ['20', '10|20|30', true, 'set membership'],
    ['40', '10|20|30', false, 'value outside the set'],
    ['CONSULTING', 'bank*|*consult*', true, 'set of wildcards'],

    // number formatting: BC displays thousands separators
    ['1.234,56', '>1000', true, 'es-style formatted number parses'],
    ['1,234.56', '>1000', true, 'en-style formatted number parses'],
  ];

  for (const [cell, expr, expected, label] of cases) {
    it(`${label}: cell=${JSON.stringify(cell)} filter="${expr}" -> ${expected}`, () => {
      expect(matchesFilterValue(cell, expr)).toBe(expected);
    });
  }

  it('reads BC cell objects, not just plain strings', () => {
    expect(matchesFilterValue({ stringValue: 'Item' }, 'item')).toBe(true);
    expect(matchesFilterValue({ objectValue: 42 }, '>40')).toBe(true);
    expect(cellText({ stringValue: 'x', objectValue: 'y' })).toBe('x');
    expect(cellText(null)).toBe('');
  });
});

describe('resolveCellKey', () => {
  const keys = ['Type', 'No.', 'Description', 'Quantity'];

  it('matches the caption as shown in the rows', () => {
    expect(resolveCellKey('Description', keys)).toBe('Description');
  });

  it('ignores case and surrounding space', () => {
    expect(resolveCellKey('  quantity ', keys)).toBe('Quantity');
  });

  it('returns null for an unknown column so the caller can list what exists', () => {
    expect(resolveCellKey('Importe', keys)).toBeNull();
  });

  it('accepts an alias (AL name -> caption) when one is supplied', () => {
    const aliases = new Map([['Line Amount', 'Quantity']]);
    expect(resolveCellKey('Line Amount', keys, aliases)).toBe('Quantity');
  });
});

describe('filterRows', () => {
  const rows = [
    { bookmark: 'b1', cells: { Type: 'Item', 'No.': '1000', Quantity: '5' } },
    { bookmark: 'b2', cells: { Type: 'Item', 'No.': '1001', Quantity: '20' } },
    { bookmark: 'b3', cells: { Type: 'Resource', 'No.': '2000', Quantity: '1' } },
    { bookmark: 'b4', cells: { Type: '', 'No.': '', Quantity: '' } },
  ];

  it('keeps only matching rows and reports what it scanned', () => {
    const out = filterRows(rows, [{ column: 'Type', value: 'Item' }]);
    expect(out.rows.map(r => r.bookmark)).toEqual(['b1', 'b2']);
    expect(out.scanned).toBe(4);
    expect(out.applied).toEqual([{ column: 'Type', value: 'Item', resolvedKey: 'Type' }]);
  });

  it('ANDs several filters', () => {
    const out = filterRows(rows, [
      { column: 'Type', value: 'Item' },
      { column: 'Quantity', value: '>10' },
    ]);
    expect(out.rows.map(r => r.bookmark)).toEqual(['b2']);
  });

  it('returns an empty result — not everything — for a value nothing matches', () => {
    const out = filterRows(rows, [{ column: 'No.', value: 'zzz' }]);
    expect(out.rows).toEqual([]);
    expect(out.scanned).toBe(4);
  });

  it('throws naming the available columns when one cannot be resolved', () => {
    expect(() => filterRows(rows, [{ column: 'Importe', value: '1' }]))
      .toThrowError(/Filter column not found: "Importe".*Type, No\., Quantity/s);
  });

  it('does not mutate the input rows', () => {
    const before = JSON.stringify(rows);
    filterRows(rows, [{ column: 'Type', value: 'Item' }]);
    expect(JSON.stringify(rows)).toBe(before);
  });
});
