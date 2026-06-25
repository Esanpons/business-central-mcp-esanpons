// tests/unit/write-data-group-error.test.ts
//
// Group-targeting miss must surface a diagnostic error (availableGroups + hint)
// AND must never write to a field outside the requested group. Exercises the
// real DataService.writeFields not-found path (no session call happens before
// the miss, so a stub session is fine).

import { describe, it, expect } from 'vitest';
import { DataService } from '../../src/services/data-service.js';
import { buildFormTree } from '../../src/protocol/form-tree-builder.js';
import { createNullLogger } from '../../src/core/logger.js';
import { isOk } from '../../src/core/result.js';
import type { PageContext } from '../../src/protocol/page-context.js';
import type { FormState } from '../../src/protocol/form-state.js';
import type { SectionDescriptor } from '../../src/protocol/section-resolver.js';
import type { PageContextRepository } from '../../src/protocol/page-context-repo.js';
import type { BCSession } from '../../src/session/bc-session.js';

const tree = buildFormTree({
  t: 'lf', ServerId: 'root', PageType: 9, Caption: 'Sales Quote',
  Children: [
    { t: 'gc', Caption: 'Sell-to', Children: [
      { t: 'sc', Caption: 'Address', StringValue: 'SELL', Visible: true, Editable: true },
    ] },
    { t: 'gc', Caption: 'Shipping and Billing', Children: [
      { t: 'gc', Caption: 'Control49', Children: [
        { t: 'sec', Caption: 'Bill-to', StringValue: 'Default', Visible: true },
        { t: 'gc', Caption: 'Control41', Children: [
          { t: 'sc', Caption: 'Address', StringValue: 'BILL', Visible: true, Editable: true },
        ] },
      ] },
    ] },
  ],
});

function svc(): DataService {
  const form: FormState = { formId: 'root', root: tree, rows: new Map() };
  const ctx = {
    pageContextId: 'pc:1', rootFormId: 'root', pageType: 'Document', caption: 'Sales Quote',
    forms: new Map([['root', form]]),
    sections: new Map<string, SectionDescriptor>([
      ['header', { sectionId: 'header', kind: 'header', caption: 'Sales Quote', formId: 'root', valid: true }],
    ]),
    dialogs: [], ownedFormIds: ['root'], isModal: false, wizardState: null,
  } as PageContext;
  const repo = { get: () => ctx } as unknown as PageContextRepository;
  return new DataService({} as unknown as BCSession, repo, createNullLogger());
}

describe('writeFields group-targeting miss', () => {
  it('returns not-found with availableGroups + hint, and writes nothing', async () => {
    const r = await svc().writeFields('pc:1', { Address: 'X' }, { group: 'Inexistent' });
    expect(isOk(r)).toBe(true);
    if (!isOk(r)) return;
    const res = r.value.results[0]!;
    expect(res.success).toBe(false);
    expect(res.changed).toBe(false);
    expect(res.error).toMatch(/not found/i);
    expect(res.availableGroups).toEqual(expect.arrayContaining(['Sell-to', 'Bill-to']));
    expect(res.hint).toBeTruthy();
    // No event was produced -> nothing was written.
    expect(r.value.events).toHaveLength(0);
  });
});
