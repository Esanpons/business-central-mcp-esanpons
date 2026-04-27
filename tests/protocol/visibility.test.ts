import { describe, it, expect } from 'vitest';
import { isEffectivelyVisible } from '../../src/protocol/visibility.js';
import { buildFormTree } from '../../src/protocol/form-tree-builder.js';

// Helper: build a minimal form tree with a gc at c[3] containing a sc at c[3]/c[0],
// and an outer gc at c[0] wrapping an inner gc at c[0]/c[1].
function buildSimpleTree() {
  return buildFormTree({
    t: 'lf', ServerId: 'F1', PageType: 0,
    Children: [
      // c[0]: outer gc (used for outer-hidden test)
      { t: 'gc', Caption: 'Outer', Visible: false, Children: [
        // c[0]/c[0]: inner gc (visible)
        { t: 'gc', Caption: 'Inner', Visible: true, Children: [
          // c[0]/c[0]/c[0]: field inside both
          { t: 'sc', Caption: 'InnerField', Visible: true, ColumnBinder: { Name: 'b1' } },
        ] },
      ] },
      // c[1]: gc with both ancestors visible
      { t: 'gc', Caption: 'Parent', Visible: true, Children: [
        // c[1]/c[0]: inner gc visible
        { t: 'gc', Caption: 'Child', Visible: true, Children: [
          // c[1]/c[0]/c[0]: field
          { t: 'sc', Caption: 'VisibleField', Visible: true, ColumnBinder: { Name: 'b2' } },
        ] },
      ] },
      // c[2]: gc with parent hidden
      { t: 'gc', Caption: 'HiddenParent', Visible: false, Children: [
        // c[2]/c[0]: inner gc visible
        { t: 'gc', Caption: 'HiddenChild', Visible: true, Children: [
          // c[2]/c[0]/c[0]: field
          { t: 'sc', Caption: 'HiddenByAncestor', Visible: true, ColumnBinder: { Name: 'b3' } },
        ] },
      ] },
      // c[3]: gc visible, contains field with own Visible:false
      { t: 'gc', Caption: 'General', Visible: true, Children: [
        // c[3]/c[0]: field with own hidden flag
        { t: 'sc', Caption: 'SelfHiddenField', Visible: false, ColumnBinder: { Name: 'b4' } },
        // c[3]/c[1]: field visible, no ancestor hidden
        { t: 'sc', Caption: 'NormalField', Visible: true, ColumnBinder: { Name: 'b5' } },
      ] },
      // c[4]: field directly off root (no gc ancestor)
      { t: 'sc', Caption: 'RootField', Visible: true, ColumnBinder: { Name: 'b6' } },
      // c[5]: field directly off root, self-hidden
      { t: 'sc', Caption: 'RootHiddenField', Visible: false, ColumnBinder: { Name: 'b7' } },
    ],
  });
}

describe('isEffectivelyVisible', () => {
  it('returns false when the control itself is hidden', () => {
    const root = buildSimpleTree();
    const groupVis = new Map<string, boolean>([
      ['server:c[3]', true],
    ]);
    // c[3]/c[0] has Visible:false
    expect(isEffectivelyVisible(root, 'server:c[3]/c[0]', groupVis)).toBe(false);
  });

  it('returns true when control is visible and has no gc ancestors', () => {
    const root = buildSimpleTree();
    // c[4] is directly off root, Visible:true
    expect(isEffectivelyVisible(root, 'server:c[4]', new Map())).toBe(true);
  });

  it('returns true when every ancestor gc in the map is visible', () => {
    const root = buildSimpleTree();
    const groupVis = new Map<string, boolean>([
      ['server:c[1]', true],
      ['server:c[1]/c[0]', true],
    ]);
    // c[1]/c[0]/c[0] — all ancestors visible
    expect(isEffectivelyVisible(root, 'server:c[1]/c[0]/c[0]', groupVis)).toBe(true);
  });

  it('returns false when ANY ancestor is recorded as hidden', () => {
    const root = buildSimpleTree();
    const groupVis = new Map<string, boolean>([
      ['server:c[2]', false],
      ['server:c[2]/c[0]', true],
    ]);
    // c[2]/c[0]/c[0] — outer ancestor hidden
    expect(isEffectivelyVisible(root, 'server:c[2]/c[0]/c[0]', groupVis)).toBe(false);
  });

  it('treats untracked ancestor paths as visible (default-true)', () => {
    const root = buildSimpleTree();
    // c[3]/c[1] has a gc ancestor c[3] not in the empty map — should default visible
    expect(isEffectivelyVisible(root, 'server:c[3]/c[1]', new Map())).toBe(true);
  });

  describe('with wizardState', () => {
    function buildWizardTree() {
      return buildFormTree({
        t: 'lf', ServerId: 'F1', PageType: 9,
        Children: [
          // c[0]: active step gc (step 0)
          { t: 'gc', Caption: 'Step0', Visible: true, ExpressionProperties: { Visible: true }, Children: [
            // c[0]/c[0]: field inside active step, Visible:false (BC never re-publishes on activation)
            { t: 'sc', Caption: 'ActiveStepField', Visible: false, ColumnBinder: { Name: 'b1' } },
          ] },
          // c[1]: inactive step gc
          { t: 'gc', Caption: 'Step1', Visible: false, ExpressionProperties: { Visible: true }, Children: [
            // c[1]/c[0]: field inside inactive step
            { t: 'sc', Caption: 'InactiveStepField', Visible: true, ColumnBinder: { Name: 'b2' } },
          ] },
          // c[2]: outer container hidden — wraps c[2]/c[0] which is a step
          { t: 'gc', Caption: 'OuterHidden', Visible: false, Children: [
            { t: 'gc', Caption: 'InnerStep', Visible: true, ExpressionProperties: { Visible: true }, Children: [
              { t: 'sc', Caption: 'InnerStepField', Visible: true, ColumnBinder: { Name: 'b3' } },
            ] },
          ] },
        ],
      });
    }

    const stepGroups = new Map<string, boolean>([
      ['server:c[0]', true],   // active step
      ['server:c[1]', false],  // inactive step
    ]);
    const ws = { stepPaths: ['server:c[0]', 'server:c[1]'], currentStepIndex: 0 };

    it('treats descendants of the active step as visible regardless of own Visible flag', () => {
      // BC publishes inner controls of inactive steps as Visible:false; when
      // the step activates, BC does not re-publish. Active step subtree must
      // override individual Visible:false flags.
      const root = buildWizardTree();
      expect(isEffectivelyVisible(root, 'server:c[0]/c[0]', stepGroups, ws)).toBe(true);
    });

    it('hides descendants of an inactive step', () => {
      const root = buildWizardTree();
      expect(isEffectivelyVisible(root, 'server:c[1]/c[0]', stepGroups, ws)).toBe(false);
    });

    it('respects outer (non-step) ancestor visibility before crossing into the step', () => {
      const root = buildWizardTree();
      const wrapped = new Map<string, boolean>([
        ['server:c[2]', false],        // outer container hidden
        ['server:c[2]/c[0]', true],    // step inside it
      ]);
      const wsInner = { stepPaths: ['server:c[2]/c[0]'], currentStepIndex: 0 };
      // The outer container is hidden — must short-circuit to false even though
      // the inner step is "active".
      expect(isEffectivelyVisible(root, 'server:c[2]/c[0]/c[0]', wrapped, wsInner)).toBe(false);
    });

    it('falls through to intrinsic visible when no wizardState', () => {
      const root = buildWizardTree();
      // c[0]/c[0] has Visible:false; no wizardState means no active-step override
      expect(isEffectivelyVisible(root, 'server:c[0]/c[0]', stepGroups, null)).toBe(false);
    });
  });
});
