// tests/protocol/section-dto.test.ts
import { describe, it, expect } from 'vitest';
import type { Section, SectionField, SectionAction, SectionRow } from '../../src/protocol/section-dto.js';
import { buildSection, buildAllSections } from '../../src/protocol/section-dto.js';
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
    const f: SectionField = { name: 'No.', controlPath: 'server:c[0]', value: '10000', editable: false, type: 'sc' };
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

  it('rows section remaps columnBinderName keys to captions', () => {
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
      { bookmark: 'BMK1', cells: { c1: 'ITEM1', c2: '5' } },
    ]);
    const ctx = makeCtx({
      rootFormId: 'root',
      forms: new Map<string, FormState>([
        ['root', makeFormState('root', { t: 'lf', ServerId: 'root', PageType: 5, Children: [] })],
        ['child', childForm],
      ]),
      sections: new Map<string, SectionDescriptor>([
        ['header', { sectionId: 'header', kind: 'header', caption: 'X', formId: 'root', valid: true }],
        ['lines', { sectionId: 'lines', kind: 'lines', caption: 'Lines', formId: 'child', repeaterControlPath: 'server:c[0]', valid: true }],
      ]),
    });
    const section = buildSection(ctx, 'lines');
    expect(section!.rows![0].cells).toEqual({ 'No.': 'ITEM1', 'Quantity': '5' });
  });

  it('returns null for an invalid (valid:false) section', () => {
    const ctx = makeCtx({
      rootFormId: 'root',
      forms: new Map([['root', makeFormState('root', { t: 'lf', ServerId: 'root', PageType: 0, Children: [] })]]),
      sections: new Map([['stale', {
        sectionId: 'stale', kind: 'subpage', caption: 'Old', formId: 'gone', valid: false,
      }]]),
    });
    expect(buildSection(ctx, 'stale')).toBeNull();
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

describe('buildSection duplicate-caption disambiguation (P1/P8 regression)', () => {
  // A Sales-Quote-shaped header: Sell-to / Bill-to / Ship-to groups that each
  // repeat the captions "Name" and "Address". This is exactly the BC744 case
  // where bc_write_data wrote to the wrong "Name". Every field must carry a
  // distinct controlPath and the group caption that disambiguates it.
  const salesQuoteHeader = {
    t: 'lf', ServerId: 'root', PageType: 9, Caption: 'Sales Quote',
    Children: [
      { t: 'gc', Caption: 'General', Children: [
        { t: 'sc', Caption: 'No.', StringValue: 'SQ001', Visible: true, Editable: false },
      ] },
      { t: 'gc', Caption: 'Sell-to', Children: [
        { t: 'sc', Caption: 'Name', StringValue: 'FUKUI MURATA MANUFACTURING', Visible: true, Editable: true },
        { t: 'sc', Caption: 'Address', StringValue: 'Sell St 1', Visible: true, Editable: true },
      ] },
      { t: 'gc', Caption: 'Bill-to', Children: [
        { t: 'sc', Caption: 'Name', StringValue: 'SAN-EI TECH LTD', Visible: true, Editable: true },
        { t: 'sc', Caption: 'Address', StringValue: 'Bill Ave 9', Visible: true, Editable: true },
      ] },
      { t: 'gc', Caption: 'Ship-to', Children: [
        { t: 'sc', Caption: 'Name', StringValue: 'Some Where', Visible: true, Editable: true },
      ] },
    ],
  };

  function salesQuoteCtx(): PageContext {
    return makeCtx({
      rootFormId: 'root',
      forms: new Map([['root', makeFormState('root', salesQuoteHeader)]]),
      sections: new Map<string, SectionDescriptor>([['header', {
        sectionId: 'header', kind: 'header', caption: 'Sales Quote', formId: 'root', valid: true,
      }]]),
    });
  }

  it('exposes a distinct controlPath + group for each duplicate caption', () => {
    const section = buildSection(salesQuoteCtx(), 'header')!;
    const names = section.fields!.filter(f => f.name === 'Name');
    expect(names).toHaveLength(3);

    // controlPaths are all distinct
    const paths = names.map(f => f.controlPath);
    expect(new Set(paths).size).toBe(3);

    // each Name is tagged with the group that disambiguates it
    expect(names.map(f => f.group).sort()).toEqual(['Bill-to', 'Sell-to', 'Ship-to']);

    const billName = names.find(f => f.group === 'Bill-to')!;
    expect(billName.value).toBe('SAN-EI TECH LTD');
    expect(billName.controlPath).toMatch(/^server:/);
  });

  it('tags non-duplicate fields with their group too, and ungrouped fields omit group', () => {
    const section = buildSection(salesQuoteCtx(), 'header')!;
    const no = section.fields!.find(f => f.name === 'No.')!;
    expect(no.group).toBe('General');
    expect(no.controlPath).toBeTruthy();
  });
});

describe('buildSection editable tri-state (P2 regression)', () => {
  it('reports "unknown" when BC emitted no Editable flag, false/true otherwise', () => {
    const root = {
      t: 'lf', ServerId: 'root', PageType: 9, Caption: 'Sales Quote',
      Children: [
        { t: 'sc', Caption: 'No.', StringValue: 'SQ001', Visible: true, Editable: false },
        { t: 'sc', Caption: 'Sell-to Customer Name', StringValue: 'X', Visible: true, Editable: true },
        // page-variable option control: no Editable on the wire -> "unknown",
        // NOT false (it is in fact writable and fires OnValidate).
        { t: 'sec', Caption: 'Ship-to', StringValue: 'Default', Visible: true },
      ],
    };
    const ctx = makeCtx({
      rootFormId: 'root',
      forms: new Map([['root', makeFormState('root', root)]]),
      sections: new Map<string, SectionDescriptor>([['header', {
        sectionId: 'header', kind: 'header', caption: 'Sales Quote', formId: 'root', valid: true,
      }]]),
    });
    const section = buildSection(ctx, 'header')!;
    const byName = (n: string) => section.fields!.find(f => f.name === n)!;
    expect(byName('No.').editable).toBe(false);
    expect(byName('Sell-to Customer Name').editable).toBe(true);
    expect(byName('Ship-to').editable).toBe('unknown');
  });
});

describe('buildSection cues projection', () => {
  it('subpage section with stackgc populates Section.cues', () => {
    const childTree = {
      t: 'lf', ServerId: 'cardPart', PageType: 3, Caption: 'Activities',
      Children: [{
        t: 'stackgc', Caption: 'Ongoing Sales', DesignName: 'OngoingSales',
        Children: [{
          t: 'gc', MappingHint: 'STACKGROUP',
          Children: [
            { t: 'stackc', Caption: 'Sales Quotes', StringValue: '5', HasAction: true, ColumnBinder: { Name: 'a' }, Synopsis: 'Quotes pending' },
            { t: 'stackc', Caption: 'Sales Orders', StringValue: '12', HasAction: true, ColumnBinder: { Name: 'b' } },
          ],
        }],
      }],
    };
    const childForm = makeFormState('cardPart', childTree);
    const ctx = makeCtx({
      rootFormId: 'root',
      forms: new Map([
        ['root', makeFormState('root', { t: 'lf', ServerId: 'root', PageType: 2, Children: [] })],
        ['cardPart', childForm],
      ]),
      sections: new Map<string, SectionDescriptor>([
        ['header', { sectionId: 'header', kind: 'header', caption: 'Role Center', formId: 'root', valid: true }],
        ['subpage:Activities', {
          sectionId: 'subpage:Activities', kind: 'subpage',
          caption: 'Activities', formId: 'cardPart', valid: true,
        }],
      ]),
    });
    const section = buildSection(ctx, 'subpage:Activities');
    expect(section).not.toBeNull();
    expect(section!.cues).toBeDefined();
    expect(section!.cues).toHaveLength(2);
    expect(section!.cues![0]).toMatchObject({
      name: 'Sales Quotes', value: '5', groupCaption: 'Ongoing Sales',
      synopsis: 'Quotes pending', hasAction: true,
    });
    expect(section!.cues![1]).toMatchObject({
      name: 'Sales Orders', value: '12', groupCaption: 'Ongoing Sales', hasAction: true,
    });
    expect(section!.cues![1].synopsis).toBeUndefined();
  });

  it('header section without cuegroups omits cues', () => {
    const ctx = makeCtx({
      rootFormId: 'root',
      forms: new Map([['root', makeFormState('root', { t: 'lf', ServerId: 'root', PageType: 0, Children: [{ t: 'sc', Caption: 'Name', StringValue: 'X', Visible: true }] })]]),
      sections: new Map([['header', { sectionId: 'header', kind: 'header', caption: 'X', formId: 'root', valid: true }]]),
    });
    const section = buildSection(ctx, 'header');
    expect(section!.cues).toBeUndefined();
  });
});

describe('buildAllSections', () => {
  it('emits sections in canonical order: header, lines, subpages, factboxes', () => {
    const rootForm = makeFormState('root', { t: 'lf', ServerId: 'root', PageType: 5, Children: [] });
    const subForm = makeFormState('sub', { t: 'lf', ServerId: 'sub', PageType: 4, Children: [] });
    const fbForm = makeFormState('fb', { t: 'lf', ServerId: 'fb', PageType: 3, Children: [] });

    const ctx = makeCtx({
      rootFormId: 'root',
      forms: new Map([['root', rootForm], ['sub', subForm], ['fb', fbForm]]),
      sections: new Map<string, SectionDescriptor>([
        // Insertion order intentionally scrambled; output order must be canonical
        ['factbox:Customer FactBox', { sectionId: 'factbox:Customer FactBox', kind: 'factbox', caption: 'FactBox', formId: 'fb', valid: true }],
        ['lines', { sectionId: 'lines', kind: 'lines', caption: 'Lines', formId: 'sub', valid: true }],
        ['header', { sectionId: 'header', kind: 'header', caption: 'Sales Order', formId: 'root', valid: true }],
      ]),
    });

    const sections = buildAllSections(ctx);
    expect(sections.map(s => s.kind)).toEqual(['header', 'lines', 'factbox']);
  });

  it('skips invalid sections', () => {
    const ctx = makeCtx({
      rootFormId: 'root',
      forms: new Map([['root', makeFormState('root', { t: 'lf', ServerId: 'root', PageType: 0, Children: [] })]]),
      sections: new Map<string, SectionDescriptor>([
        ['header', { sectionId: 'header', kind: 'header', caption: 'Customer', formId: 'root', valid: true }],
        ['stale', { sectionId: 'stale', kind: 'subpage', caption: 'Old', formId: 'gone', valid: false }],
      ]),
    });
    const sections = buildAllSections(ctx);
    expect(sections.map(s => s.sectionId)).toEqual(['header']);
  });
});
