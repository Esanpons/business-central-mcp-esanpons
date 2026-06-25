// tests/unit/open-page-not-materialized.test.ts
//
// N1 regression: when BC returns an Unknown page with no sections (or opens a
// dialog instead of a standalone page), bc_open_page must surface an explicit
// reason instead of an empty, mysterious shell.

import { describe, it, expect } from 'vitest';
import { OpenPageOperation } from '../../src/operations/open-page.js';
import type { PageService } from '../../src/services/page-service.js';
import type { PageContext } from '../../src/protocol/page-context.js';
import { ok } from '../../src/core/result.js';
import { PageNotMaterializedError } from '../../src/core/errors.js';

function ctxStub(over: Partial<PageContext>): PageContext {
  return {
    pageContextId: 'pc:1',
    rootFormId: 'root',
    pageType: 'Unknown',
    caption: '208',
    forms: new Map(),
    sections: new Map(),
    dialogs: [],
    ownedFormIds: ['root'],
    isModal: false,
    wizardState: null,
    ...over,
  } as PageContext;
}

function opReturning(ctx: PageContext): OpenPageOperation {
  const fake = { openPage: async () => ok(ctx) } as unknown as PageService;
  return new OpenPageOperation(fake);
}

describe('OpenPageOperation N1 (page not materialized)', () => {
  it('errors with PAGE_NOT_MATERIALIZED when Unknown + no sections (non-modal)', async () => {
    const r = await opReturning(ctxStub({ pageType: 'Unknown', isModal: false })).execute({ pageId: '9300' });
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.error).toBeInstanceOf(PageNotMaterializedError);
    expect(r.error.code).toBe('PAGE_NOT_MATERIALIZED');
    expect(r.error.context).toMatchObject({ pageId: '9300', pageType: 'Unknown', isModal: false });
  });

  it('mentions dialog handling when the Unknown page is modal', async () => {
    const r = await opReturning(ctxStub({ pageType: 'Unknown', isModal: true })).execute({ pageId: '9300' });
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect((r.error.context as { reason: string }).reason).toMatch(/dialog|modal/i);
  });
});
