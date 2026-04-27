import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { parseControlTree } from '../../src/protocol/control-tree-parser.js';
import { PageContextRepository } from '../../src/protocol/page-context-repo.js';
import { isEffectivelyVisible } from '../../src/protocol/visibility.js';
import type { BCEvent } from '../../src/protocol/types.js';

function loadWizardTree(): unknown {
  return JSON.parse(readFileSync('tests/recordings/cdo-wizard-page6175295-tree.json', 'utf8'));
}

describe('parseControlTree — dynamic step detection', () => {
  const parsed = parseControlTree(loadWizardTree());

  it('records groupVisibility for every gc encountered', () => {
    // The Continia wizard has 11 top-level gcs (toolbar, banners, steps, action bar)
    expect(parsed.groupVisibility.size).toBeGreaterThanOrEqual(7);
  });

  it('flags top-level gcs with ExpressionProperties.Visible as dynamic steps', () => {
    expect(parsed.dynamicSteps.length).toBeGreaterThanOrEqual(7);
    // Welcome step is initially visible; Step0..StepFinish hidden
    const initiallyVisible = parsed.dynamicSteps.filter(s => s.initiallyVisible);
    expect(initiallyVisible.length).toBe(1);
  });

  it('attaches ancestorGroupPaths to fields nested in step gcs', () => {
    const fieldInsideStep = parsed.fields.find(f =>
      f.ancestorGroupPaths.some(p => p.startsWith('server:c[')),
    );
    expect(fieldInsideStep).toBeDefined();
    expect(fieldInsideStep!.ancestorGroupPaths.length).toBeGreaterThan(0);
  });

  it('does not flag toolbar/actionbar gcs as dynamic steps', () => {
    // Top-level children include MappingHint=TOOLBAR (idx 0) and ACTIONBAR (idx 10).
    // Neither has ExpressionProperties.Visible → must NOT appear in dynamicSteps.
    const stepPaths = parsed.dynamicSteps.map(s => s.controlPath);
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
    let root = ctx.forms.get('F1')!;

    // Initially: c[3] visible, c[4]/c[5] hidden
    const welcomeField = root.controlTree.find(f => f.caption === 'WelcomeField')!;
    const step0Field = root.controlTree.find(f => f.caption === 'Step0Field')!;
    const step1Field = root.controlTree.find(f => f.caption === 'Step1Field')!;
    expect(isEffectivelyVisible(welcomeField, root.groupVisibility)).toBe(true);
    expect(isEffectivelyVisible(step0Field, root.groupVisibility)).toBe(false);
    expect(isEffectivelyVisible(step1Field, root.groupVisibility)).toBe(false);

    // Advance to step 1 (Step0 group)
    repo.advanceWizardStep(pcId, 1);
    ctx = repo.get(pcId)!;
    root = ctx.forms.get('F1')!;
    expect(isEffectivelyVisible(welcomeField, root.groupVisibility)).toBe(false);
    expect(isEffectivelyVisible(step0Field, root.groupVisibility)).toBe(true);
    expect(isEffectivelyVisible(step1Field, root.groupVisibility)).toBe(false);
    expect(ctx.wizardState!.currentStepIndex).toBe(1);

    // Advance to step 2 (Step1 group)
    repo.advanceWizardStep(pcId, 2);
    ctx = repo.get(pcId)!;
    root = ctx.forms.get('F1')!;
    expect(isEffectivelyVisible(welcomeField, root.groupVisibility)).toBe(false);
    expect(isEffectivelyVisible(step0Field, root.groupVisibility)).toBe(false);
    expect(isEffectivelyVisible(step1Field, root.groupVisibility)).toBe(true);
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
    // Direct construction of FormProjection state with a known gc path
    const { FormProjection } = await import('../../src/protocol/form-state.js');
    const p = new FormProjection();
    let form = p.createInitial('F1');
    form = { ...form, groupVisibility: new Map([['server:c[3]', true]]) };

    const updated = p.apply(form, {
      type: 'PropertyChanged',
      formId: 'F1',
      controlPath: 'server:c[3]',
      changes: { Visible: false },
    } as BCEvent);

    expect(updated.groupVisibility.get('server:c[3]')).toBe(false);
  });

  it('leaves groupVisibility untouched when controlPath is not tracked', async () => {
    const { FormProjection } = await import('../../src/protocol/form-state.js');
    const p = new FormProjection();
    let form = p.createInitial('F1');
    form = { ...form, groupVisibility: new Map([['server:c[3]', true]]) };

    const updated = p.apply(form, {
      type: 'PropertyChanged',
      formId: 'F1',
      controlPath: 'server:c[42]',  // not in groupVisibility
      changes: { Visible: false },
    } as BCEvent);

    expect(updated.groupVisibility.get('server:c[3]')).toBe(true);
    expect(updated.groupVisibility.has('server:c[42]')).toBe(false);
  });
});
