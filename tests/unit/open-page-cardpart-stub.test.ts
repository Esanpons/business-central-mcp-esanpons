// tests/unit/open-page-cardpart-stub.test.ts
import { describe, it, expect } from 'vitest';
import { OpenPageOperation } from '../../src/operations/open-page.js';
import { CardPartStubError } from '../../src/core/errors.js';
import { ok } from '../../src/core/result.js';
import { buildFormTree } from '../../src/protocol/form-tree-builder.js';

function makeFakeCtx(pageType: string, treeChildren: unknown[]) {
  const root = buildFormTree({
    t: 'lf', ServerId: 'root',
    PageType: { Card: 0, List: 1, RoleCenter: 2, CardPart: 3, ListPart: 4 }[pageType] ?? 0,
    Caption: 'Test', Children: treeChildren,
  });
  return {
    pageContextId: 'pc:1',
    pageType,
    caption: 'Test',
    isModal: false,
    sections: new Map([['header', {
      sectionId: 'header', kind: 'header', caption: 'Test', formId: 'root', valid: true,
    }]]),
    forms: new Map([['root', { formId: 'root', root, rows: new Map() }]]),
    dialogs: [],
    ownedFormIds: ['root'],
    wizardState: null,
    rootFormId: 'root',
  };
}

describe('OpenPageOperation CardPart-stub detection', () => {
  it('returns CardPartStubError when pageType is CardPart and root has no captioned fields', async () => {
    const stubCtx = makeFakeCtx('CardPart', []);
    const fakePageService: any = { openPage: async () => ok(stubCtx) };
    const op = new OpenPageOperation(fakePageService);

    const result = await op.execute({ pageId: '6175308' });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error).toBeInstanceOf(CardPartStubError);
      expect(result.error.message).toMatch(/CardPart/);
      expect(result.error.message).toMatch(/host/i);
    }
  });

  it('returns success for a non-CardPart page even if root has no fields', async () => {
    const ctx = makeFakeCtx('Card', []);
    const fakePageService: any = { openPage: async () => ok(ctx) };
    const op = new OpenPageOperation(fakePageService);

    const result = await op.execute({ pageId: '21' });
    expect(result.ok).toBe(true);
  });

  it('returns success for a CardPart that has populated content (e.g. cue tiles)', async () => {
    // CardPart with a stackgc -> stackc child (the BC28 norm)
    const ctx = makeFakeCtx('CardPart', [{
      t: 'stackgc', Caption: 'Group',
      Children: [{
        t: 'gc', MappingHint: 'STACKGROUP',
        Children: [{ t: 'stackc', Caption: 'Cue1', StringValue: '5' }],
      }],
    }]);
    const fakePageService: any = { openPage: async () => ok(ctx) };
    const op = new OpenPageOperation(fakePageService);

    const result = await op.execute({ pageId: '1310' });
    expect(result.ok).toBe(true);
  });

  it('CardPartStubError context includes pageId and hostHint', async () => {
    const stubCtx = makeFakeCtx('CardPart', []);
    const fakePageService: any = { openPage: async () => ok(stubCtx) };
    const op = new OpenPageOperation(fakePageService);

    const result = await op.execute({ pageId: '99999' });
    expect(result.ok).toBe(false);
    if (!result.ok && result.error instanceof CardPartStubError) {
      expect(result.error.context).toMatchObject({ pageId: '99999' });
      expect(result.error.context!.hostHint).toMatch(/host/i);
    }
  });
});
