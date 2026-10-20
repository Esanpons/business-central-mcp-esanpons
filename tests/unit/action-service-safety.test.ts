// tests/unit/action-service-safety.test.ts
//
// Three ways ActionService used to do something OTHER than what was asked, and
// report success for it: guessing a control path, re-using a stale one after the
// tree moved, and advancing a wizard that BC had actually blocked.

import { describe, it, expect, vi } from 'vitest';
import { ActionService } from '../../src/services/action-service.js';
import { PageContextRepository } from '../../src/protocol/page-context-repo.js';
import { ok } from '../../src/core/result.js';
import type { BCEvent } from '../../src/protocol/types.js';

interface Sent { type: string; controlPath?: string; systemAction?: number }

function makeService(repo: PageContextRepository, sent: Sent[], respond: (i: Sent) => BCEvent[] = () => []) {
  const session = {
    invoke: async (interaction: Sent) => {
      sent.push({ type: interaction.type, controlPath: interaction.controlPath, systemAction: interaction.systemAction });
      return ok(respond(interaction));
    },
    removeOpenForm: vi.fn(),
  } as never;
  const logger = { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() } as never;
  return new ActionService(session, repo, logger);
}

const formCreated = (formId: string, tree: unknown): BCEvent =>
  ({ type: 'FormCreated', formId, controlTree: tree } as BCEvent);

describe('executeSystemAction with no matching action', () => {
  it('errors with the available system actions instead of invoking server:c[0]', async () => {
    const repo = new PageContextRepository();
    repo.create('pc:1', 'f1');
    repo.applyToPage('pc:1', [formCreated('f1', {
      t: 'lf', ServerId: 'f1', PageType: 0, Caption: 'Customer Card',
      Children: [{ t: 'ac', Caption: 'New', SystemAction: 10, Enabled: true, Visible: true }],
    })]);
    const sent: Sent[] = [];
    const svc = makeService(repo, sent);

    const r = await svc.executeSystemAction('pc:1', 30 /* Refresh */);
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.error.message).toMatch(/No action with systemAction=30/);
    expect((r.error.context as { availableSystemActions: Array<{ systemAction: number }> }).availableSystemActions)
      .toEqual([{ name: 'New', systemAction: 10, enabled: true }]);
    expect(sent).toHaveLength(0);   // nothing was invoked
  });
});

describe('row-scoped action whose path moves after positioning', () => {
  const listTree = (withAction: boolean) => ({
    t: 'lf', ServerId: 'f1', PageType: 1, Caption: 'Approvals',
    Children: [
      { t: 'rc', Columns: [{ t: 'rcc', Caption: 'No.', ColumnBinder: { Name: 'c1' } }] },
      ...(withAction ? [{ t: 'ac', Caption: 'Approve', SystemAction: 0, Enabled: true, Visible: true }] : []),
    ],
  });

  it('errors instead of invoking the pre-positioning control path', async () => {
    const repo = new PageContextRepository();
    repo.create('pc:1', 'f1');
    repo.applyToPage('pc:1', [formCreated('f1', listTree(true))]);
    repo.applyToPage('pc:1', [{
      type: 'DataLoaded', formId: 'f1', controlPath: 'server:c[0]', currentRowOnly: false,
      rows: [{ DataRowInserted: [0, { bookmark: 'b1', cells: { c1: '10000' } }] }],
    } as BCEvent]);

    const sent: Sent[] = [];
    // BC rearranges the action bar after the row selection: the action is gone.
    const svc = makeService(repo, sent, (i) =>
      i.type === 'SetCurrentRow' ? [formCreated('f1', listTree(false))] : []);

    const r = await svc.executeAction('pc:1', 'Approve', undefined, { rowIndex: 0 });
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.error.message).toMatch(/disappeared after selecting the row/);
    expect(sent.map(s => s.type)).toEqual(['SetCurrentRow']);   // no InvokeAction followed
  });

  it('invokes the RE-RESOLVED path when the action survives', async () => {
    const repo = new PageContextRepository();
    repo.create('pc:1', 'f1');
    repo.applyToPage('pc:1', [formCreated('f1', listTree(true))]);
    repo.applyToPage('pc:1', [{
      type: 'DataLoaded', formId: 'f1', controlPath: 'server:c[0]', currentRowOnly: false,
      rows: [{ DataRowInserted: [0, { bookmark: 'b1', cells: { c1: '10000' } }] }],
    } as BCEvent]);

    const sent: Sent[] = [];
    const svc = makeService(repo, sent);
    const r = await svc.executeAction('pc:1', 'Approve', undefined, { rowIndex: 0 });
    expect(r.ok).toBe(true);
    expect(sent.map(s => s.type)).toEqual(['SetCurrentRow', 'InvokeAction']);
    expect(sent[1]!.controlPath).toBe('server:c[1]');
  });
});

// bc-saas F-67 c: the action's `enabled` was read on the row that happened to be
// selected, BEFORE moving to the bookmark. "Reprocesar" was refused for a row that
// had it enabled because the previously selected row did not.
describe('enabled is judged on the TARGETED row (F-67 c)', () => {
  const listTree = (enabled: boolean) => ({
    t: 'lf', ServerId: 'f1', PageType: 1, Caption: 'Documentos DeCA',
    Children: [
      { t: 'rc', Columns: [{ t: 'rcc', Caption: 'Nº', ColumnBinder: { Name: 'c1' } }] },
      { t: 'ac', Caption: 'Reprocesar', SystemAction: 0, Enabled: enabled, Visible: true },
    ],
  });
  const rows = {
    type: 'DataLoaded', formId: 'f1', controlPath: 'server:c[0]', currentRowOnly: false,
    rows: [
      { DataRowInserted: [0, { bookmark: 'b-published', cells: { c1: 'DECA-26-00363' } }] },
      { DataRowInserted: [1, { bookmark: 'b-exempt', cells: { c1: 'DECA-26-00360' } }] },
    ],
  } as BCEvent;

  function repoOnDisabledRow() {
    const repo = new PageContextRepository();
    repo.create('pc:1', 'f1');
    repo.applyToPage('pc:1', [formCreated('f1', listTree(false)), rows]);
    return repo;
  }

  it('runs the action when it is disabled on the current row but enabled on the bookmark', async () => {
    const repo = repoOnDisabledRow();
    const sent: Sent[] = [];
    // After SetCurrentRow BC re-publishes the action bar for the new row: enabled.
    const svc = makeService(repo, sent, (i) =>
      i.type === 'SetCurrentRow' ? [formCreated('f1', listTree(true))] : []);

    const r = await svc.executeAction('pc:1', 'Reprocesar', undefined, { bookmark: 'b-exempt' });
    expect(r.ok).toBe(true);
    expect(sent.map(s => s.type)).toEqual(['SetCurrentRow', 'InvokeAction']);
  });

  it('refuses, without invoking, when the targeted row has it disabled too', async () => {
    const repo = repoOnDisabledRow();
    const sent: Sent[] = [];
    const svc = makeService(repo, sent);   // the tree keeps Enabled: false

    const r = await svc.executeAction('pc:1', 'Reprocesar', undefined, { bookmark: 'b-exempt' });
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.error.message).toMatch(/disabled.*row you targeted/);
    expect(sent.map(s => s.type)).toEqual(['SetCurrentRow']);
  });

  it('still refuses straight away when no row is targeted', async () => {
    const repo = repoOnDisabledRow();
    const sent: Sent[] = [];
    const svc = makeService(repo, sent);
    const r = await svc.executeAction('pc:1', 'Reprocesar');
    expect(r.ok).toBe(false);
    expect(sent).toHaveLength(0);
  });
});

describe('wizard step mirroring', () => {
  const wizardTree = {
    t: 'lf', ServerId: 'w1', PageType: 9, Caption: 'Setup Wizard',
    Children: [
      { t: 'gc', DesignName: 'Step1', Caption: 'Welcome', Visible: true, ExpressionProperties: ['Visible'], Children: [] },
      { t: 'gc', DesignName: 'Step2', Caption: 'Details', Visible: false, ExpressionProperties: ['Visible'], Children: [] },
      { t: 'ac', Caption: 'Next', SystemAction: 0, Enabled: true, Visible: true, Icon: { Identifier: 'NextRecord' } },
    ],
  };

  function wizardRepo() {
    const repo = new PageContextRepository();
    repo.create('pc:w', 'w1', {
      wizardState: { stepPaths: ['server:c[0]', 'server:c[1]'], currentStepIndex: 0 },
    });
    repo.applyToPage('pc:w', [formCreated('w1', wizardTree)]);
    return repo;
  }

  it('advances the mirrored step on a clean Next', async () => {
    const repo = wizardRepo();
    const svc = makeService(repo, []);
    const r = await svc.executeWizardNav('pc:w', 'next');
    expect(r.ok).toBe(true);
    expect(repo.get('pc:w')!.wizardState!.currentStepIndex).toBe(1);
  });

  it('does NOT advance when BC answered with a dialog (the step did not move)', async () => {
    const repo = wizardRepo();
    const svc = makeService(repo, [], (i) => i.type === 'InvokeAction'
      ? [{ type: 'DialogOpened', formId: 'dlg', ownerFormId: 'w1', controlTree: { t: 'lf', ServerId: 'dlg', PageType: 8, Caption: 'Fill in the name', Children: [] } } as BCEvent]
      : []);

    const r = await svc.executeWizardNav('pc:w', 'next');
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.value.dialog).toBeDefined();
    expect(repo.get('pc:w')!.wizardState!.currentStepIndex).toBe(0);
  });
});
