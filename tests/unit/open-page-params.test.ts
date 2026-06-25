// tests/unit/open-page-params.test.ts
//
// P7: bc_open_page must be able to acotar its payload (summary / sections /
// columns) so big documents do not overflow the token budget.

import { describe, it, expect } from 'vitest';
import { OpenPageOperation } from '../../src/operations/open-page.js';
import type { PageService } from '../../src/services/page-service.js';
import type { PageContext } from '../../src/protocol/page-context.js';
import type { FormState } from '../../src/protocol/form-state.js';
import type { SectionDescriptor } from '../../src/protocol/section-resolver.js';
import { buildFormTree } from '../../src/protocol/form-tree-builder.js';
import { ok } from '../../src/core/result.js';

function formState(formId: string, raw: unknown): FormState {
  return { formId, root: buildFormTree(raw), rows: new Map() };
}

function docCtx(): PageContext {
  const header = formState('root', {
    t: 'lf', ServerId: 'root', PageType: 9, Caption: 'Sales Quote',
    Children: [
      { t: 'sc', Caption: 'No.', StringValue: 'SQ1', Visible: true, Editable: false },
      { t: 'sc', Caption: 'Sell-to Customer Name', StringValue: 'X', Visible: true, Editable: true },
    ],
  });
  const lines = formState('child', {
    t: 'lf', ServerId: 'child', PageType: 1, Caption: 'Lines',
    Children: [{ t: 'rc', Columns: [{ t: 'rcc', Caption: 'No.', ColumnBinder: { Name: 'c1' } }] }],
  });
  lines.rows.set('server:c[0]', [{ bookmark: 'B1', cells: { 'No.': 'I1' } }]);
  return {
    pageContextId: 'pc:1', rootFormId: 'root', pageType: 'Document', caption: 'Sales Quote',
    forms: new Map<string, FormState>([['root', header], ['child', lines]]),
    sections: new Map<string, SectionDescriptor>([
      ['header', { sectionId: 'header', kind: 'header', caption: 'Sales Quote', formId: 'root', valid: true }],
      ['lines', { sectionId: 'lines', kind: 'lines', caption: 'Lines', formId: 'child', repeaterControlPath: 'server:c[0]', valid: true }],
    ]),
    dialogs: [], ownedFormIds: ['root'], isModal: false, wizardState: null,
  } as PageContext;
}

function op(): OpenPageOperation {
  const fake = { openPage: async () => ok(docCtx()) } as unknown as PageService;
  return new OpenPageOperation(fake);
}

describe('OpenPageOperation P7 payload controls', () => {
  it('returns all sections with fields/rows by default', async () => {
    const r = await op().execute({ pageId: '41' });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.value.sections.map(s => s.sectionId)).toEqual(['header', 'lines']);
    expect(r.value.sections[0].fields).toBeDefined();
  });

  it('summary mode strips fields and rows', async () => {
    const r = await op().execute({ pageId: '41', summary: true });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    for (const s of r.value.sections) {
      expect(s.fields).toBeUndefined();
      expect(s.rows).toBeUndefined();
    }
    expect(r.value.sections.find(s => s.sectionId === 'lines')!.totalRowCount).not.toBeUndefined();
  });

  it('sections filter restricts which sections come back', async () => {
    const r = await op().execute({ pageId: '41', sections: ['header'] });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.value.sections.map(s => s.sectionId)).toEqual(['header']);
  });

  it('columns filter keeps only requested header fields', async () => {
    const r = await op().execute({ pageId: '41', sections: ['header'], columns: ['No.'] });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.value.sections[0].fields!.map(f => f.name)).toEqual(['No.']);
  });
});
