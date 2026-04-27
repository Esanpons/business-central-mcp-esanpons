import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { buildFormTree } from '../../src/protocol/form-tree-builder.js';
import { actions as treeActions, groupVisibility as treeGroupVisibility } from '../../src/protocol/form-views.js';
import { isLogicalFormNode, isGroupNode } from '../../src/protocol/form-node.js';

function loadTree(filename: string): unknown {
  return JSON.parse(readFileSync(`tests/recordings/${filename}`, 'utf8'));
}

/** Wizard nav classification — mirrors the logic in page-service.ts buildWizardState. */
function classifyWizardNav(action: { iconIdentifier?: string; systemAction: number }): 'back' | 'next' | 'finish' | 'cancel' | undefined {
  const id = action.iconIdentifier ?? '';
  if (/PreviousRecord/i.test(id)) return 'back';
  if (/NextRecord|Action_Start/i.test(id)) return 'next';
  if (/Approve/i.test(id)) return 'finish';
  const sys = action.systemAction;
  if (sys === 310 || sys === 320 || sys === 350) return 'cancel';
  return undefined;
}

describe('buildFormTree — PageType enum', () => {
  it.each([
    [0, 'Card'],
    [1, 'List'],
    [2, 'RoleCenter'],
    [3, 'CardPart'],
    [4, 'ListPart'],
    [5, 'Document'],
    [6, 'Worksheet'],
    [7, 'ListPlus'],
    [8, 'ConfirmationDialog'],
    [9, 'NavigatePage'],
    [10, 'StandardDialog'],
    [11, 'API'],
    [12, 'HeadlinePart'],
    [22, 'UserControlHost'],
  ])('maps wire PageType %d to %s', (wire, name) => {
    const tree = buildFormTree({ t: 'lf', PageType: wire, Children: [] });
    expect(isLogicalFormNode(tree) && tree.pageType).toBe(name);
  });

  it('returns Unknown for missing or out-of-range PageType', () => {
    const t1 = buildFormTree({ t: 'lf', Children: [] });
    const t2 = buildFormTree({ t: 'lf', PageType: 999, Children: [] });
    expect(isLogicalFormNode(t1) && t1.pageType).toBe('Unknown');
    expect(isLogicalFormNode(t2) && t2.pageType).toBe('Unknown');
  });
});

describe('buildFormTree — wizard nav detection', () => {
  it('classifies icon paths into back/next/finish', () => {
    const tree = buildFormTree({
      t: 'lf',
      PageType: 9,
      Children: [
        { t: 'ac', Caption: 'Back', Icon: { Identifier: 'Actions/PreviousRecord/16.png' } },
        { t: 'ac', Caption: 'Next', Icon: { Identifier: 'Actions/NextRecord/16.png' } },
        { t: 'ac', Caption: 'Finish', Icon: { Identifier: 'Actions/Approve/16.png' } },
        { t: 'ac', Caption: 'Cancel', SystemAction: 320 },
      ],
    });
    const acts = treeActions(tree);
    const nav = (caption: string) => classifyWizardNav({
      iconIdentifier: acts.find(a => a.properties.caption === caption)?.iconIdentifier,
      systemAction: acts.find(a => a.properties.caption === caption)?.systemAction ?? 0,
    });
    expect(nav('Back')).toBe('back');
    expect(nav('Next')).toBe('next');
    expect(nav('Finish')).toBe('finish');
    expect(nav('Cancel')).toBe('cancel');
  });

  it('classifies legacy Action_*_16x16.png icon paths', () => {
    const tree = buildFormTree({
      t: 'lf',
      PageType: 9,
      Children: [
        { t: 'ac', Caption: 'Back', Icon: { Identifier: 'Action_PreviousRecord_16x16.png' } },
        { t: 'ac', Caption: 'Next', Icon: { Identifier: 'Action_NextRecord_16x16.png' } },
        { t: 'ac', Caption: 'Finish', Icon: { Identifier: 'Action_Approve_16x16.png' } },
      ],
    });
    const acts = treeActions(tree);
    const nav = (caption: string) => classifyWizardNav({
      iconIdentifier: acts.find(a => a.properties.caption === caption)?.iconIdentifier,
      systemAction: acts.find(a => a.properties.caption === caption)?.systemAction ?? 0,
    });
    expect(nav('Back')).toBe('back');
    expect(nav('Next')).toBe('next');
    expect(nav('Finish')).toBe('finish');
  });

  it('treats SystemAction Cancel(310) / Abort(320) / Close(350) as cancel', () => {
    const tree = buildFormTree({
      t: 'lf',
      PageType: 10,
      Children: [
        { t: 'ac', Caption: 'Cancel', SystemAction: 310 },
        { t: 'ac', Caption: 'Abort', SystemAction: 320 },
        { t: 'ac', Caption: 'Close', SystemAction: 350 },
      ],
    });
    const acts = treeActions(tree);
    expect(acts.every(a => classifyWizardNav({ iconIdentifier: a.iconIdentifier, systemAction: a.systemAction }) === 'cancel')).toBe(true);
  });

  it('exposes the raw icon identifier for non-nav icons too', () => {
    const tree = buildFormTree({
      t: 'lf',
      PageType: 9,
      Children: [
        { t: 'ac', Caption: 'Refresh', Icon: { Identifier: 'Actions/Refresh/16.png' } },
      ],
    });
    const acts = treeActions(tree);
    const a = acts[0]!;
    expect(a.iconIdentifier).toBe('Actions/Refresh/16.png');
    expect(classifyWizardNav({ iconIdentifier: a.iconIdentifier, systemAction: a.systemAction })).toBeUndefined();
  });
});

describe('buildFormTree — Continia activation wizard (page 6175295)', () => {
  const rawTree = loadTree('cdo-wizard-page6175295-tree.json');
  const tree = buildFormTree(rawTree);

  it('reports caption and NavigatePage type', () => {
    expect(isLogicalFormNode(tree) && tree.properties.caption).toBe('Set Up Document Output');
    expect(isLogicalFormNode(tree) && tree.pageType).toBe('NavigatePage');
  });

  it('extracts Back, Next, Finish wizardNav actions from the actionbar', () => {
    const acts = treeActions(tree);
    const navTypes = acts
      .map(a => classifyWizardNav({ iconIdentifier: a.iconIdentifier, systemAction: a.systemAction }))
      .filter((v): v is NonNullable<typeof v> => v !== undefined);
    expect(navTypes).toContain('back');
    expect(navTypes).toContain('next');
    expect(navTypes).toContain('finish');
    expect(navTypes).toContain('cancel');
  });

  it('records groupVisibility for every gc encountered', () => {
    const gv = treeGroupVisibility(tree);
    // The Continia wizard has 11 top-level gcs (toolbar, banners, steps, action bar)
    expect(gv.size).toBeGreaterThanOrEqual(7);
  });

  it('flags top-level gcs with ExpressionProperties.Visible as dynamic steps (hasVisibleExpression)', () => {
    if (!isLogicalFormNode(tree)) throw new Error('expected lf');
    const dynamicStepGcs = tree.children.filter(
      n => isGroupNode(n) && n.properties.hasVisibleExpression && /^Step/i.test(n.properties.designName ?? ''),
    );
    expect(dynamicStepGcs.length).toBeGreaterThanOrEqual(7);
    // Welcome step is initially visible; Step0..StepFinish hidden
    const initiallyVisible = dynamicStepGcs.filter(n => (n.properties.visible ?? true) === true);
    expect(initiallyVisible.length).toBe(1);
  });

  it('does not flag toolbar/actionbar gcs as dynamic steps', () => {
    if (!isLogicalFormNode(tree)) throw new Error('expected lf');
    const dynamicStepPaths = tree.children
      .filter(n => isGroupNode(n) && n.properties.hasVisibleExpression && /^Step/i.test(n.properties.designName ?? ''))
      .map(n => n.controlPath);
    expect(dynamicStepPaths).not.toContain('server:c[0]');  // TOOLBAR
    expect(dynamicStepPaths).not.toContain('server:c[10]'); // ACTIONBAR
  });
});
