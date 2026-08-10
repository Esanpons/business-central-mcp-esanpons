// tests/protocol/protocol-types.test.ts
//
// Contract tests for the shared protocol constants and the legacy PageState
// adapter in src/protocol/types.ts.

import { describe, it, expect } from 'vitest';
import { SystemAction, FilterOperation, derivePageState } from '../../src/protocol/types.js';
import type { PageContext } from '../../src/protocol/page-context.js';
import type { FormState } from '../../src/protocol/form-state.js';
import { buildFormTree } from '../../src/protocol/form-tree-builder.js';

// Finding 9 — the enum must cover every action the codebase actually sends.
// Reference: decompiled Microsoft.Dynamics.Framework.UI.Client.SystemAction.cs
// (identical on BC27 and BC28).
describe('SystemAction', () => {
  it('matches the decompiled ordinals', () => {
    expect(SystemAction).toMatchObject({
      None: 0, New: 10, Delete: 20, Refresh: 30, Edit: 40,
      EditList: 50, View: 60, ViewList: 70, OpenFullList: 80,
      AssistEdit: 100, Lookup: 110, DrillDown: 120,
      RunReport: 210, PageSearch: 220,
      Ok: 300, Cancel: 310, Abort: 320,
      LookupOk: 330, LookupCancel: 340, CloseOk: 350,
      Yes: 380, No: 390,
      ChangeCompany: 500,
    });
  });

  it('exports the three actions other modules still send as bare literals', () => {
    // src/services/search-service.ts sends 220, src/session/bc-session.ts sends 500.
    expect(SystemAction.PageSearch).toBe(220);
    expect(SystemAction.ChangeCompany).toBe(500);
    expect(SystemAction.RunReport).toBe(210);
  });
});

describe('FilterOperation', () => {
  it('matches the decompiled ordinals', () => {
    expect(FilterOperation).toEqual({ Execute: 0, AddLine: 1, RemoveLine: 2, Reset: 3 });
  });
});

// Finding 12 — derivePageState is deprecated but must not fabricate values.
describe('derivePageState', () => {
  function context(): PageContext {
    const root = buildFormTree({
      t: 'lf', ServerId: 'F1', PageType: 0, Caption: 'Customer Card',
      Children: [
        { t: 'gc', Caption: 'General', Children: [
          { t: 'sc', Caption: 'Name', Editable: true, ShowMandatory: true },
          { t: 'sc', Caption: 'Salesperson', LookupAction: { t: 'lact' } },
        ] },
      ],
    });
    const form: FormState = { formId: 'F1', root, rows: new Map() };
    return {
      pageContextId: 'session:page:21',
      rootFormId: 'F1',
      pageType: 'Card',
      caption: 'Customer Card',
      forms: new Map([['F1', form]]),
      sections: new Map(),
      dialogs: [],
      ownedFormIds: ['F1'],
      isModal: false,
      wizardState: null,
      activeFilters: [],
    };
  }

  it('reports real ancestorGroupPaths instead of an empty array', () => {
    const state = derivePageState(context());
    const name = state.controlTree.find(f => f.caption === 'Name')!;
    expect(name.ancestorGroupPaths).toEqual(['server:c[0]']);
  });

  it('carries showMandatory and isLookup through from the FieldNode', () => {
    const state = derivePageState(context());
    const name = state.controlTree.find(f => f.caption === 'Name')!;
    const sp = state.controlTree.find(f => f.caption === 'Salesperson')!;
    expect(name.showMandatory).toBe(true);
    expect(name.isLookup).toBeUndefined();
    expect(sp.isLookup).toBe(true);
    expect(sp.showMandatory).toBeUndefined();
  });

  it('reports editable as tri-state ("unknown" when BC published no flag)', () => {
    const state = derivePageState(context());
    expect(state.controlTree.find(f => f.caption === 'Name')!.editable).toBe(true);
    expect(state.controlTree.find(f => f.caption === 'Salesperson')!.editable).toBe('unknown');
  });

  it('documents its known gap: childForms captions stay empty', () => {
    const ctx = context();
    const childRoot = buildFormTree({ t: 'lf', ServerId: 'F2', PageType: 4, Caption: 'Lines', Children: [] });
    const forms = new Map(ctx.forms);
    forms.set('F2', { formId: 'F2', root: childRoot, rows: new Map() });
    const state = derivePageState({ ...ctx, forms });
    expect(state.childForms).toEqual([{ formId: 'F2', caption: '' }]);
  });
});
