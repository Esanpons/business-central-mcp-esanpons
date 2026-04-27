import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { buildFormTree } from '../../src/protocol/form-tree-builder.js';
import { PageContextRepository } from '../../src/protocol/page-context-repo.js';
import { isEffectivelyVisible } from '../../src/protocol/visibility.js';
import type { BCEvent } from '../../src/protocol/types.js';
import {
  fields as treeFields, groupVisibility as treeGroupVisibility,
} from '../../src/protocol/form-views.js';
import { ancestorGroupPaths } from '../../src/protocol/form-tree-walk.js';
import { isGroupNode, isLogicalFormNode } from '../../src/protocol/form-node.js';

function loadWizardTree(): unknown {
  return JSON.parse(readFileSync('tests/recordings/cdo-wizard-page6175295-tree.json', 'utf8'));
}

describe('buildFormTree — dynamic step detection', () => {
  const tree = buildFormTree(loadWizardTree());

  it('records groupVisibility for every gc encountered', () => {
    // The Continia wizard has 11 top-level gcs (toolbar, banners, steps, action bar)
    const gv = treeGroupVisibility(tree);
    expect(gv.size).toBeGreaterThanOrEqual(7);
  });

  it('flags top-level gcs with ExpressionProperties.Visible as dynamic steps (hasVisibleExpression)', () => {
    if (!isLogicalFormNode(tree)) throw new Error('expected lf');
    const dynamicSteps = tree.children.filter(
      n => isGroupNode(n) && n.properties.hasVisibleExpression && /^Step/i.test(n.properties.designName ?? ''),
    );
    expect(dynamicSteps.length).toBeGreaterThanOrEqual(7);
    // Welcome step is initially visible; Step0..StepFinish hidden
    const initiallyVisible = dynamicSteps.filter(n => (n.properties.visible ?? true) === true);
    expect(initiallyVisible.length).toBe(1);
  });

  it('attaches ancestorGroupPaths to fields nested in step gcs', () => {
    const fieldInsideStep = treeFields(tree).find(f =>
      ancestorGroupPaths(tree, f.controlPath).some(p => p.startsWith('server:c[')),
    );
    expect(fieldInsideStep).toBeDefined();
    expect(ancestorGroupPaths(tree, fieldInsideStep!.controlPath).length).toBeGreaterThan(0);
  });

  it('does not flag toolbar/actionbar gcs as dynamic steps', () => {
    // Top-level children include MappingHint=TOOLBAR (idx 0) and ACTIONBAR (idx 10).
    // Neither has ExpressionProperties.Visible → must NOT appear in dynamicSteps.
    if (!isLogicalFormNode(tree)) throw new Error('expected lf');
    const stepPaths = tree.children
      .filter(n => isGroupNode(n) && n.properties.hasVisibleExpression && /^Step/i.test(n.properties.designName ?? ''))
      .map(n => n.controlPath);
    expect(stepPaths).not.toContain('server:c[0]');  // TOOLBAR
    expect(stepPaths).not.toContain('server:c[10]'); // ACTIONBAR
  });
});

describe('PageContextRepository.advanceWizardStep', () => {
  function buildWizardPage(): { repo: PageContextRepository; pcId: string } {
    const repo = new PageContextRepository();
    const pcId = 'pc1';
    repo.create(pcId, 'F1', {
      isModal: true,
      wizardState: {
        stepPaths: ['server:c[3]', 'server:c[4]', 'server:c[5]'],
        currentStepIndex: 0,
      },
    });
    // Apply a synthetic root control tree with two fields, one in step 0 (welcome)
    // and one in step 1 (Step0 in the wizard).
    const tree = {
      t: 'lf', Caption: 'Wiz', PageType: 9,
      Children: [
        { t: 'gc', Children: [], MappingHint: 'TOOLBAR' },                                                   // c[0]
        { t: 'gc', Caption: 'banner', Children: [] },                                                         // c[1]
        { t: 'gc', Caption: 'banner2', Children: [] },                                                        // c[2]
        { t: 'gc', Caption: 'Welcome', ExpressionProperties: { Visible: true }, Children: [                   // c[3]
          { t: 'sc', Caption: 'WelcomeField', Visible: true, ColumnBinder: { Name: 'b1' } },
        ] },
        { t: 'gc', Caption: 'Step0', Visible: false, ExpressionProperties: { Visible: true }, Children: [   // c[4]
          { t: 'sc', Caption: 'Step0Field', Visible: true, ColumnBinder: { Name: 'b2' } },
        ] },
        { t: 'gc', Caption: 'Step1', Visible: false, ExpressionProperties: { Visible: true }, Children: [   // c[5]
          { t: 'sc', Caption: 'Step1Field', Visible: true, ColumnBinder: { Name: 'b3' } },
        ] },
      ],
    };
    repo.applyEvents([{
      type: 'DialogOpened', formId: 'F1', ownerFormId: 'role', controlTree: tree,
    } as BCEvent]);
    return { repo, pcId };
  }

  it('advances groupVisibility so only the new step is visible', () => {
    const { repo, pcId } = buildWizardPage();
    let ctx = repo.get(pcId)!;
    let rootForm = ctx.forms.get('F1')!;

    // Initially: c[3] visible, c[4]/c[5] hidden
    const welcomeField = treeFields(rootForm.root).find(f => f.properties.caption === 'WelcomeField')!;
    const step0Field = treeFields(rootForm.root).find(f => f.properties.caption === 'Step0Field')!;
    const step1Field = treeFields(rootForm.root).find(f => f.properties.caption === 'Step1Field')!;
    expect(isEffectivelyVisible(rootForm.root, welcomeField.controlPath, treeGroupVisibility(rootForm.root))).toBe(true);
    expect(isEffectivelyVisible(rootForm.root, step0Field.controlPath, treeGroupVisibility(rootForm.root))).toBe(false);
    expect(isEffectivelyVisible(rootForm.root, step1Field.controlPath, treeGroupVisibility(rootForm.root))).toBe(false);

    // Advance to step 1 (Step0 group)
    repo.advanceWizardStep(pcId, 1);
    ctx = repo.get(pcId)!;
    rootForm = ctx.forms.get('F1')!;
    expect(isEffectivelyVisible(rootForm.root, welcomeField.controlPath, treeGroupVisibility(rootForm.root))).toBe(false);
    expect(isEffectivelyVisible(rootForm.root, step0Field.controlPath, treeGroupVisibility(rootForm.root))).toBe(true);
    expect(isEffectivelyVisible(rootForm.root, step1Field.controlPath, treeGroupVisibility(rootForm.root))).toBe(false);
    expect(ctx.wizardState!.currentStepIndex).toBe(1);

    // Advance to step 2 (Step1 group)
    repo.advanceWizardStep(pcId, 2);
    ctx = repo.get(pcId)!;
    rootForm = ctx.forms.get('F1')!;
    expect(isEffectivelyVisible(rootForm.root, welcomeField.controlPath, treeGroupVisibility(rootForm.root))).toBe(false);
    expect(isEffectivelyVisible(rootForm.root, step0Field.controlPath, treeGroupVisibility(rootForm.root))).toBe(false);
    expect(isEffectivelyVisible(rootForm.root, step1Field.controlPath, treeGroupVisibility(rootForm.root))).toBe(true);
    expect(ctx.wizardState!.currentStepIndex).toBe(2);

    // Step backwards
    repo.advanceWizardStep(pcId, 1);
    ctx = repo.get(pcId)!;
    expect(ctx.wizardState!.currentStepIndex).toBe(1);
  });

  it('clamps out-of-range indices (no-op outside [0, length))', () => {
    const { repo, pcId } = buildWizardPage();
    repo.advanceWizardStep(pcId, -1);
    expect(repo.get(pcId)!.wizardState!.currentStepIndex).toBe(0);
    repo.advanceWizardStep(pcId, 99);
    expect(repo.get(pcId)!.wizardState!.currentStepIndex).toBe(0);
  });

  it('does nothing on pages without wizardState', () => {
    const repo = new PageContextRepository();
    repo.create('pc1', 'F1');
    repo.advanceWizardStep('pc1', 1);
    expect(repo.get('pc1')!.wizardState).toBeNull();
  });
});

describe('FormProjection — gc PropertyChanged routing', () => {
  it('updates groupVisibility when PropertyChanged targets a tracked gc', async () => {
    // Build a form with a real gc in the tree so that treeGroupVisibility can
    // track it. The gc is the first child → server:c[0].
    const { FormProjection } = await import('../../src/protocol/form-state.js');
    const { buildFormTree } = await import('../../src/protocol/form-tree-builder.js');
    const { groupVisibility } = await import('../../src/protocol/form-views.js');
    const p = new FormProjection();
    const root = buildFormTree({
      t: 'lf', ServerId: 'F1', PageType: 0,
      Children: [{ t: 'gc', Caption: 'General', Visible: true, Children: [] }],
    });
    const base = p.createInitial('F1');
    const form = { ...base, root };

    const updated = p.apply(form, {
      type: 'PropertyChanged',
      formId: 'F1',
      controlPath: 'server:c[0]',  // gc is at index 0
      changes: { Visible: false },
    } as BCEvent);

    expect(groupVisibility(updated.root).get('server:c[0]')).toBe(false);
  });

  it('leaves groupVisibility untouched when controlPath is not tracked', async () => {
    // A gc at server:c[0] is tracked. An event targeting server:c[42] (not in
    // the tree) is silently dropped — the gc at c[0] retains its initial value.
    const { FormProjection } = await import('../../src/protocol/form-state.js');
    const { buildFormTree } = await import('../../src/protocol/form-tree-builder.js');
    const { groupVisibility } = await import('../../src/protocol/form-views.js');
    const p = new FormProjection();
    const root = buildFormTree({
      t: 'lf', ServerId: 'F1', PageType: 0,
      Children: [{ t: 'gc', Caption: 'General', Visible: true, Children: [] }],
    });
    const base = p.createInitial('F1');
    const form = { ...base, root };

    const updated = p.apply(form, {
      type: 'PropertyChanged',
      formId: 'F1',
      controlPath: 'server:c[42]',  // not in tree
      changes: { Visible: false },
    } as BCEvent);

    // gc at c[0] retains its initial visible:true value
    expect(groupVisibility(updated.root).get('server:c[0]')).toBe(true);
    // the unknown path is not added to groupVisibility
    expect(groupVisibility(updated.root).has('server:c[42]')).toBe(false);
  });
});
