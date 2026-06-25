// tests/unit/execute-action-quiet.test.ts
//
// N3: bc_execute_action quiet mode must suppress the full updatedFields dump
// (document actions otherwise drag 100+ header fields into the response).

import { describe, it, expect } from 'vitest';
import { ExecuteActionOperation } from '../../src/operations/execute-action.js';
import type { ActionService, ActionResult } from '../../src/services/action-service.js';
import type { PageContextRepository } from '../../src/protocol/page-context-repo.js';
import type { PageContext } from '../../src/protocol/page-context.js';
import type { FormState } from '../../src/protocol/form-state.js';
import type { SectionDescriptor } from '../../src/protocol/section-resolver.js';
import { buildFormTree } from '../../src/protocol/form-tree-builder.js';
import { ok } from '../../src/core/result.js';

function updatedState(): PageContext {
  const root: FormState = {
    formId: 'root',
    root: buildFormTree({
      t: 'lf', ServerId: 'root', PageType: 9, Caption: 'Sales Quote',
      Children: [
        { t: 'sc', Caption: 'No.', StringValue: 'SQ1', Visible: true },
        { t: 'sc', Caption: 'Name', StringValue: 'Contoso', Visible: true },
      ],
    }),
    rows: new Map(),
  };
  return {
    pageContextId: 'pc:1', rootFormId: 'root', pageType: 'Document', caption: 'Sales Quote',
    forms: new Map([['root', root]]),
    sections: new Map<string, SectionDescriptor>([['header', { sectionId: 'header', kind: 'header', caption: 'Sales Quote', formId: 'root', valid: true }]]),
    dialogs: [], ownedFormIds: ['root'], isModal: false, wizardState: null,
  } as PageContext;
}

function op(): ExecuteActionOperation {
  const ar: ActionResult = { success: true, events: [], updatedState: updatedState() };
  const fakeAction = { executeAction: async () => ok(ar) } as unknown as ActionService;
  const fakeRepo = { get: () => undefined, getByFormId: () => undefined } as unknown as PageContextRepository;
  return new ExecuteActionOperation(fakeAction, fakeRepo);
}

describe('ExecuteActionOperation quiet (N3)', () => {
  it('includes updatedFields by default', async () => {
    const r = await op().execute({ pageContextId: 'pc:1', action: 'Editar' });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.value.updatedFields).toBeDefined();
    expect(r.value.updatedFields!.length).toBeGreaterThan(0);
  });

  it('suppresses updatedFields when quiet:true', async () => {
    const r = await op().execute({ pageContextId: 'pc:1', action: 'Editar', quiet: true });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.value.updatedFields).toBeUndefined();
    expect(r.value.success).toBe(true);
  });
});
