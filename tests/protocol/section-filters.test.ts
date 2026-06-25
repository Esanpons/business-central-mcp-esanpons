// tests/protocol/section-filters.test.ts
import { describe, it, expect } from 'vitest';
import { toSectionSummary, filterFieldsByGroup, filterColumns, sliceRows } from '../../src/protocol/section-filters.js';
import type { Section } from '../../src/protocol/section-dto.js';

const cardSection: Section = {
  sectionId: 'header', kind: 'header', caption: 'Sales Quote',
  fields: [
    { name: 'No.', controlPath: 'server:c[0]/c[0]', group: 'General', value: 'SQ1', editable: false, type: 'sc' },
    { name: 'Name', controlPath: 'server:c[1]/c[0]', group: 'Sell-to', value: 'SELL', editable: true, type: 'sc' },
    { name: 'Name', controlPath: 'server:c[2]/c[0]', group: 'Bill-to', value: 'BILL', editable: true, type: 'sc' },
  ],
  actions: [{ name: 'New', systemAction: 10, enabled: true }],
};

const listSection: Section = {
  sectionId: 'lines', kind: 'lines', caption: 'Lines', totalRowCount: 42,
  rows: [
    { bookmark: 'B1', cells: { 'No.': 'I1', Quantity: '1', Description: 'a' } },
    { bookmark: 'B2', cells: { 'No.': 'I2', Quantity: '2', Description: 'b' } },
    { bookmark: 'B3', cells: { 'No.': 'I3', Quantity: '3', Description: 'c' } },
  ],
};

describe('toSectionSummary', () => {
  it('keeps identity + totalRowCount, drops fields/rows/actions', () => {
    expect(toSectionSummary(cardSection)).toEqual({ sectionId: 'header', kind: 'header', caption: 'Sales Quote' });
    expect(toSectionSummary(listSection)).toEqual({ sectionId: 'lines', kind: 'lines', caption: 'Lines', totalRowCount: 42 });
  });
});

describe('filterFieldsByGroup', () => {
  it('keeps only fields in the named group (case-insensitive)', () => {
    const r = filterFieldsByGroup(cardSection, 'bill-to');
    expect(r.fields).toHaveLength(1);
    expect(r.fields![0].value).toBe('BILL');
  });
});

describe('filterColumns', () => {
  it('keeps card fields by caption OR controlPath', () => {
    const r = filterColumns(cardSection, ['server:c[2]/c[0]']);
    expect(r.fields).toHaveLength(1);
    expect(r.fields![0].group).toBe('Bill-to');
  });
  it('keeps only requested cell keys in rows', () => {
    const r = filterColumns(listSection, ['No.', 'Quantity']);
    expect(Object.keys(r.rows![0].cells)).toEqual(['No.', 'Quantity']);
  });
});

describe('sliceRows', () => {
  it('slices already-loaded rows', () => {
    const r = sliceRows(listSection, { offset: 1, limit: 1 });
    expect(r.rows!.map(x => x.bookmark)).toEqual(['B2']);
  });
  it('is a no-op for card sections', () => {
    expect(sliceRows(cardSection, { offset: 0, limit: 1 })).toBe(cardSection);
  });
});
