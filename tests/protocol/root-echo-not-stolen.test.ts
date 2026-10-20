// bc-saas F-66 a: the header of a page with FactBoxes read back as it was BEFORE a write.
//
// controlPaths are form-relative, so a header field and a FactBox field share paths
// like `server:c[1]/c[1]`. The repository used to hand a ROOT PropertyChanged to any
// FactBox with a field at that path and drop it from the root. Measured live on devel1
// (BC27, 2026-10-04, page 42 in Create mode): BC echoed Customer No. / Customer Name /
// No. on the root form after the customer write, and the context kept all three empty.
import { describe, it, expect } from 'vitest';
import { PageContextRepository } from '../../src/protocol/page-context-repo.js';
import { fields } from '../../src/protocol/form-views.js';
import type { BCEvent } from '../../src/protocol/types.js';

const rootTree = {
  t: 'lf', ServerId: 'ROOT', PageType: 0, Caption: 'Sales Order',
  Children: [
    { t: 'gc', Children: [] },
    { t: 'gc', Caption: 'General', Children: [
      { t: 'sc', Caption: 'No.', ColumnBinder: { Name: 'no' } },
      { t: 'sc', Caption: 'Customer No.', ColumnBinder: { Name: 'cust' } },
    ] },
  ],
};
// A FactBox whose own field sits at the SAME relative path server:c[1]/c[1].
const factboxTree = {
  t: 'lf', ServerId: 'FB', Caption: 'Customer Details',
  Children: [
    { t: 'gc', Children: [] },
    { t: 'gc', Children: [{ t: 'sc', Caption: 'Phone', ColumnBinder: { Name: 'ph' } }, { t: 'sc', Caption: 'Customer No.', ColumnBinder: { Name: 'c2' } }] },
  ],
};

function repo(): PageContextRepository {
  const r = new PageContextRepository();
  r.create('pc', 'ROOT');
  r.applyToPage('pc', [{ type: 'FormCreated', formId: 'ROOT', controlTree: rootTree } as BCEvent]);
  r.registerDiscoveredChildForm('pc', { serverId: 'FB', caption: 'Customer Details', controlTree: factboxTree, isSubForm: false, isPart: true });
  return r;
}

const value = (r: PageContextRepository, formId: string, path: string) =>
  fields(r.get('pc')!.forms.get(formId)!.root).find(f => f.controlPath === path)?.properties.stringValue;

describe('a root echo is not stolen by a FactBox with a field at the same path', () => {
  it('keeps the header value on the root form', () => {
    const r = repo();
    r.applyToPage('pc', [{ type: 'PropertyChanged', formId: 'ROOT', controlPath: 'server:c[1]/c[1]', changes: { StringValue: '2000001' } } as BCEvent]);
    expect(value(r, 'ROOT', 'server:c[1]/c[1]')).toBe('2000001');
    expect(value(r, 'FB', 'server:c[1]/c[1]')).toBeUndefined();
  });

  it('still routes a root-addressed change the root has NO node for to the FactBox', () => {
    const r = repo();
    // The root has nothing at server:c[1]/c[5]; give the FactBox a field there.
    const fb2 = { ...factboxTree, ServerId: 'FB2', Children: [{ t: 'gc', Children: [] }, { t: 'gc', Children: [0, 1, 2, 3, 4, 5].map(i => ({ t: 'sc', Caption: `F${i}`, ColumnBinder: { Name: `f${i}` } })) }] };
    r.registerDiscoveredChildForm('pc', { serverId: 'FB2', caption: 'Stats', controlTree: fb2, isSubForm: false, isPart: true });
    r.applyToPage('pc', [{ type: 'PropertyChanged', formId: 'ROOT', controlPath: 'server:c[1]/c[5]', changes: { StringValue: '42' } } as BCEvent]);
    expect(value(r, 'FB2', 'server:c[1]/c[5]')).toBe('42');
  });

  it('a change addressed to the FactBox itself lands on the FactBox', () => {
    const r = repo();
    r.applyToPage('pc', [{ type: 'PropertyChanged', formId: 'FB', controlPath: 'server:c[1]/c[1]', changes: { StringValue: 'C-1' } } as BCEvent]);
    expect(value(r, 'FB', 'server:c[1]/c[1]')).toBe('C-1');
    expect(value(r, 'ROOT', 'server:c[1]/c[1]')).toBeUndefined();
  });
});
