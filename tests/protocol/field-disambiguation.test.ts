// tests/protocol/field-disambiguation.test.ts
//
// P1/P8 regression: fields that share a caption across groups (Sell-to /
// Bill-to / Ship-to on a Sales Quote header) must be resolvable unambiguously,
// either by their group caption or by their stable controlPath.

import { describe, it, expect } from 'vitest';
import { buildFormTree } from '../../src/protocol/form-tree-builder.js';
import { nearestGroupCaption, findFieldByGroupCaption, findByControlPath } from '../../src/protocol/form-tree-walk.js';
import { fields as treeFields } from '../../src/protocol/form-views.js';

const tree = buildFormTree({
  t: 'lf', ServerId: 'root', PageType: 9, Caption: 'Sales Quote',
  Children: [
    { t: 'gc', Caption: 'General', Children: [
      { t: 'sc', Caption: 'No.', StringValue: 'SQ001', Visible: true },
    ] },
    { t: 'gc', Caption: 'Sell-to', Children: [
      { t: 'sc', Caption: 'Name', StringValue: 'SELL CUSTOMER', Visible: true, Editable: true },
    ] },
    { t: 'gc', Caption: 'Bill-to', Children: [
      // nested layout group with no caption: nearestGroupCaption must skip it
      { t: 'gc', Children: [
        { t: 'sc', Caption: 'Name', StringValue: 'BILL CUSTOMER', Visible: true, Editable: true },
      ] },
    ] },
  ],
});

describe('nearestGroupCaption', () => {
  it('returns the innermost captioned group, skipping unnamed layout groups', () => {
    const bill = findFieldByGroupCaption(tree, 'Bill-to', 'Name')!;
    expect(bill).toBeDefined();
    expect(nearestGroupCaption(tree, bill.controlPath)).toBe('Bill-to');
  });

  it('returns undefined for a field in no captioned group', () => {
    // root-level field would have no group; here every field is grouped, so
    // assert the General case resolves to General (sanity) instead.
    const no = findFieldByGroupCaption(tree, 'General', 'No.')!;
    expect(nearestGroupCaption(tree, no.controlPath)).toBe('General');
  });
});

describe('findFieldByGroupCaption', () => {
  it('picks the Name inside the requested group, not the first match', () => {
    const sell = findFieldByGroupCaption(tree, 'Sell-to', 'Name')!;
    const bill = findFieldByGroupCaption(tree, 'Bill-to', 'Name')!;
    expect(sell.properties.stringValue).toBe('SELL CUSTOMER');
    expect(bill.properties.stringValue).toBe('BILL CUSTOMER');
    expect(sell.controlPath).not.toBe(bill.controlPath);
  });

  it('is case-insensitive on both group and caption', () => {
    const bill = findFieldByGroupCaption(tree, 'bill-to', 'name')!;
    expect(bill.properties.stringValue).toBe('BILL CUSTOMER');
  });

  it('returns undefined when the group does not exist', () => {
    expect(findFieldByGroupCaption(tree, 'Pay-to', 'Name')).toBeUndefined();
  });
});

// Mirrors the REAL devel1 Sales Quote structure (found in live testing): the
// Sell-to block is a captioned group, but the Bill-to block is an auto-named
// group ("Control41") whose human label is carried by a sibling "Bill-to"
// option selector. The group resolver must still map group:"Bill-to" to the
// Bill-to address fields — and must NOT fall back to the Sell-to ones.
const realTree = buildFormTree({
  t: 'lf', ServerId: 'root', PageType: 9, Caption: 'Sales Quote',
  Children: [
    { t: 'gc', Caption: 'Sell-to', Children: [
      { t: 'sc', Caption: 'Address', StringValue: 'SELL ADDR', Visible: true, Editable: true },
      { t: 'sc', Caption: 'Address 2', StringValue: 'SELL A2', Visible: true, Editable: true },
    ] },
    { t: 'gc', Caption: 'Shipping and Billing', Children: [
      { t: 'gc', Caption: 'Control49', Children: [
        { t: 'sec', Caption: 'Bill-to', StringValue: 'Default', Visible: true },
        { t: 'gc', Caption: 'Control41', Children: [
          { t: 'sc', Caption: 'Address', StringValue: 'BILL ADDR', Visible: true, Editable: true },
          { t: 'sc', Caption: 'Address 2', StringValue: 'BILL A2', Visible: true, Editable: true },
        ] },
      ] },
    ] },
  ],
});

describe('auto-named group + option selector idiom (devel1 Bill-to regression)', () => {
  it('derives the Bill-to label from the sibling selector, not the auto-name "Control41"', () => {
    const bill = findFieldByGroupCaption(realTree, 'Bill-to', 'Address 2')!;
    expect(bill).toBeDefined();
    expect(bill.properties.stringValue).toBe('BILL A2');
    expect(nearestGroupCaption(realTree, bill.controlPath)).toBe('Bill-to');
  });

  it('group:"Bill-to" resolves to the Bill-to field, never the Sell-to one', () => {
    const bill = findFieldByGroupCaption(realTree, 'Bill-to', 'Address')!;
    const sell = findFieldByGroupCaption(realTree, 'Sell-to', 'Address')!;
    expect(bill.properties.stringValue).toBe('BILL ADDR');
    expect(sell.properties.stringValue).toBe('SELL ADDR');
    expect(bill.controlPath).not.toBe(sell.controlPath);
  });

  it('a non-existent group returns undefined (so the caller errors instead of writing the wrong field)', () => {
    expect(findFieldByGroupCaption(realTree, 'Pay-to', 'Address 2')).toBeUndefined();
    // and the Control41 auto-name is NOT what callers must use
    expect(findFieldByGroupCaption(realTree, 'Control41', 'Address 2')).toBeUndefined();
  });

  it('only an option-selector (sec) labels an auto-named group — a plain string sibling does NOT', () => {
    // Mirrors the noise found live: an auto-named group whose sibling is an
    // ordinary string field ("Some Code") must not turn that caption into a group.
    const leakTree = buildFormTree({
      t: 'lf', ServerId: 'root', PageType: 9, Children: [
        { t: 'gc', Caption: 'Foreign Trade', Children: [
          { t: 'gc', Caption: 'Control60', Children: [
            { t: 'sc', Caption: 'Some Code', StringValue: 'X', Visible: true },
            { t: 'gc', Caption: 'Control61', Children: [
              { t: 'sc', Caption: 'Region', StringValue: 'EU', Visible: true },
            ] },
          ] },
        ] },
      ],
    });
    const region = treeFields(leakTree).find(f => f.properties.caption === 'Region')!;
    const g = nearestGroupCaption(leakTree, region.controlPath);
    expect(g).not.toBe('Some Code');     // plain string sibling NOT used
    expect(g).toBe('Foreign Trade');     // falls through to the enclosing real group
  });
});

describe('controlPath resolution', () => {
  it('a controlPath returned for one Name resolves back to that exact node', () => {
    const bill = findFieldByGroupCaption(tree, 'Bill-to', 'Name')!;
    const again = findByControlPath(tree, bill.controlPath)!;
    expect(again).toBe(bill);
    expect(again.properties.stringValue).toBe('BILL CUSTOMER');
  });
});
