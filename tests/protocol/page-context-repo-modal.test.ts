import { describe, it, expect } from 'vitest';
import { PageContextRepository } from '../../src/protocol/page-context-repo.js';
import type { BCEvent } from '../../src/protocol/types.js';
import {
  actions as treeActions,
} from '../../src/protocol/form-views.js';

describe('PageContextRepository — modal-rooted pages', () => {
  const wizardTree = {
    t: 'lf',
    Caption: 'Sample Wizard',
    PageType: 9, // NavigatePage
    Children: [
      { t: 'gc', Caption: 'Step0', Children: [
        { t: 'sc', Caption: 'Step0Field', Editable: true, Visible: true, ColumnBinder: { Name: 'b1' } },
      ] },
      { t: 'gc', MappingHint: 'ACTIONBAR', Children: [
        { t: 'ac', Caption: 'Back', Icon: { Identifier: 'Actions/PreviousRecord/16.png' } },
        { t: 'ac', Caption: 'Next', Icon: { Identifier: 'Actions/NextRecord/16.png' } },
        { t: 'ac', Caption: 'Finish', Icon: { Identifier: 'Actions/Approve/16.png' } },
        { t: 'ac', Caption: 'Cancel', SystemAction: 320 },
      ] },
    ],
  };

  it('treats DialogOpened with formId === rootFormId as the page root layout', () => {
    const repo = new PageContextRepository();
    repo.create('pc1', 'F1', { isModal: true });

    const event: BCEvent = {
      type: 'DialogOpened',
      formId: 'F1',
      ownerFormId: 'roleCenterForm',
      controlTree: wizardTree,
    };
    repo.applyEvents([event]);

    const ctx = repo.get('pc1')!;
    expect(ctx.isModal).toBe(true);
    expect(ctx.pageType).toBe('NavigatePage');
    expect(ctx.caption).toBe('Sample Wizard');

    const rootForm = ctx.forms.get('F1')!;
    const actionNodes = treeActions(rootForm.root);
    // classifyWizardNav logic mirrors form-state.ts actionNodeToActionInfo
    const navs = actionNodes.map(a => {
      const id = a.iconIdentifier;
      if (id) {
        if (/PreviousRecord/i.test(id)) return 'back';
        if (/NextRecord|Action_Start/i.test(id)) return 'next';
        if (/Approve/i.test(id)) return 'finish';
      }
      if (a.systemAction === 310 || a.systemAction === 320 || a.systemAction === 350) return 'cancel';
      return undefined;
    }).filter(Boolean);
    expect(navs).toEqual(expect.arrayContaining(['back', 'next', 'finish', 'cancel']));
  });

  it('treats DialogOpened with a different formId as a child dialog (not root)', () => {
    const repo = new PageContextRepository();
    // Open a regular page first
    repo.create('pc1', 'rootForm');
    repo.applyEvents([{
      type: 'FormCreated',
      formId: 'rootForm',
      isReload: false,
      controlTree: { t: 'lf', Caption: 'Customer Card', PageType: 0, Children: [] },
    } as BCEvent]);

    // Now a confirmation dialog appears with a *different* formId
    repo.applyEvents([{
      type: 'DialogOpened',
      formId: 'dialogForm',
      ownerFormId: 'rootForm',
      controlTree: { t: 'lf', Caption: 'Confirm', PageType: 8, Children: [] },
    } as BCEvent]);

    const ctx = repo.get('pc1')!;
    expect(ctx.isModal).toBe(false);
    expect(ctx.pageType).toBe('Card');
    expect(ctx.dialogs.length).toBe(1);
    expect(ctx.dialogs[0]!.formId).toBe('dialogForm');
    // Root form is unchanged — no actions
    expect(treeActions(ctx.forms.get('rootForm')!.root)).toHaveLength(0);
  });

  it('isModal defaults to false when create() is called without options', () => {
    const repo = new PageContextRepository();
    repo.create('pc1', 'F1');
    expect(repo.get('pc1')!.isModal).toBe(false);
  });
});
