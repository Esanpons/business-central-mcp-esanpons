// tests/protocol/section-dto.test.ts
import { describe, it, expect } from 'vitest';
import type { Section, SectionField, SectionAction, SectionRow } from '../../src/protocol/section-dto.js';
import { buildSection } from '../../src/protocol/section-dto.js';
import { buildFormTree } from '../../src/protocol/form-tree-builder.js';
import type { PageContext } from '../../src/protocol/page-context.js';
import type { FormState } from '../../src/protocol/form-state.js';
import type { SectionDescriptor } from '../../src/protocol/section-resolver.js';

function makeFormState(formId: string, raw: unknown): FormState {
  return { formId, root: buildFormTree(raw), rows: new Map() };
}

function makeCtx(opts: {
  forms: Map<string, FormState>;
  sections: Map<string, SectionDescriptor>;
  rootFormId: string;
}): PageContext {
  return {
    pageContextId: 'pc:1',
    rootFormId: opts.rootFormId,
    pageType: 'Card',
    caption: 'Test Page',
    forms: opts.forms,
    sections: opts.sections,
    dialogs: [],
    ownedFormIds: [opts.rootFormId],
    isModal: false,
    wizardState: null,
  };
}

describe('Section DTO shape', () => {
  it('exposes the documented top-level fields', () => {
    const s: Section = {
      sectionId: 'header',
      kind: 'header',
      caption: 'Customer',
      fields: [],
      actions: [],
    };
    expect(s.sectionId).toBe('header');
    expect(s.kind).toBe('header');
  });

  it('SectionField carries name, value, editable, type', () => {
    const f: SectionField = { name: 'No.', value: '10000', editable: false, type: 'sc' };
    expect(f.name).toBe('No.');
  });

  it('SectionAction carries name, systemAction, enabled', () => {
    const a: SectionAction = { name: 'Post', systemAction: 0, enabled: true };
    expect(a.systemAction).toBe(0);
  });

  it('SectionRow carries bookmark and cells', () => {
    const r: SectionRow = { bookmark: 'BMK1', cells: { 'No.': '10000' } };
    expect(r.bookmark).toBe('BMK1');
  });
});

describe('buildSection', () => {
  it('builds a header section with visible captioned fields', () => {
    const root = {
      t: 'lf', ServerId: 'root', PageType: 0, Caption: 'Customer',
      Children: [
        { t: 'sc', Caption: 'No.', StringValue: '10000', Visible: true, Editable: false },
        { t: 'sc', Caption: 'Name', StringValue: 'Contoso', Visible: true, Editable: true },
        { t: 'sc', Caption: 'Hidden', StringValue: 'x', Visible: false, Editable: false },
      ],
    };
    const ctx = makeCtx({
      rootFormId: 'root',
      forms: new Map([['root', makeFormState('root', root)]]),
      sections: new Map<string, SectionDescriptor>([['header', {
        sectionId: 'header', kind: 'header', caption: 'Customer',
        formId: 'root', valid: true,
      }]]),
    });
    const section = buildSection(ctx, 'header');
    expect(section).not.toBeNull();
    expect(section!.kind).toBe('header');
    expect(section!.fields).toHaveLength(2);
    expect(section!.fields![0]).toMatchObject({ name: 'No.', value: '10000', editable: false });
    expect(section!.rows).toBeUndefined();
  });

  it('builds a lines section with rows but no fields', () => {
    const child = {
      t: 'lf', ServerId: 'child', PageType: 1, Caption: 'Lines',
      Children: [{
        t: 'rc',
        Columns: [
          { t: 'rcc', Caption: 'No.', ColumnBinder: { Name: 'c1', Path: '37.1' } },
          { t: 'rcc', Caption: 'Quantity', ColumnBinder: { Name: 'c2', Path: '37.5' } },
        ],
      }],
    };
    const childForm = makeFormState('child', child);
    childForm.rows.set('server:c[0]', [
      { bookmark: 'BMK1', cells: { 'No.': 'ITEM1', 'Quantity': '5' } },
    ]);

    const ctx = makeCtx({
      rootFormId: 'root',
      forms: new Map<string, FormState>([
        ['root', makeFormState('root', { t: 'lf', ServerId: 'root', PageType: 5, Children: [] })],
        ['child', childForm],
      ]),
      sections: new Map<string, SectionDescriptor>([
        ['header', { sectionId: 'header', kind: 'header', caption: 'Sales Order', formId: 'root', valid: true }],
        ['lines', {
          sectionId: 'lines', kind: 'lines', caption: 'Lines',
          formId: 'child', repeaterControlPath: 'server:c[0]', valid: true,
        }],
      ]),
    });
    const section = buildSection(ctx, 'lines');
    expect(section!.kind).toBe('lines');
    expect(section!.rows).toEqual([
      { bookmark: 'BMK1', cells: { 'No.': 'ITEM1', 'Quantity': '5' } },
    ]);
    expect(section!.fields).toBeUndefined();
  });

  it('returns null for an invalid sectionId', () => {
    const ctx = makeCtx({
      rootFormId: 'root',
      forms: new Map([['root', makeFormState('root', { t: 'lf', ServerId: 'root', PageType: 0, Children: [] })]]),
      sections: new Map(),
    });
    expect(buildSection(ctx, 'nonexistent')).toBeNull();
  });

  it('emits actions only on the header section', () => {
    const root = {
      t: 'lf', ServerId: 'root', PageType: 0, Caption: 'Customer',
      Children: [
        { t: 'ac', Caption: 'New', SystemAction: 10, Enabled: true, Visible: true },
        { t: 'ac', Caption: 'Delete', SystemAction: 20, Enabled: true, Visible: true },
      ],
    };
    const ctx = makeCtx({
      rootFormId: 'root',
      forms: new Map([['root', makeFormState('root', root)]]),
      sections: new Map([['header', {
        sectionId: 'header', kind: 'header', caption: 'Customer', formId: 'root', valid: true,
      }]]),
    });
    const section = buildSection(ctx, 'header');
    expect(section!.actions).toHaveLength(2);
    expect(section!.actions![0].name).toBe('New');
  });
});
