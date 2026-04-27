import { describe, it, expect } from 'vitest';
import { isEffectivelyVisible } from '../../src/protocol/visibility.js';

describe('isEffectivelyVisible', () => {
  const groupAllVisible = new Map<string, boolean>([
    ['server:c[3]', true],
    ['server:c[3]/c[0]', true],
  ]);

  const groupParentHidden = new Map<string, boolean>([
    ['server:c[3]', false],
    ['server:c[3]/c[0]', true],
  ]);

  it('returns false when the control itself is hidden', () => {
    const c = { visible: false, ancestorGroupPaths: [] };
    expect(isEffectivelyVisible(c, groupAllVisible)).toBe(false);
  });

  it('returns true when control is visible and has no ancestors', () => {
    const c = { visible: true, ancestorGroupPaths: [] };
    expect(isEffectivelyVisible(c, groupAllVisible)).toBe(true);
  });

  it('returns true when every ancestor in the map is visible', () => {
    const c = { visible: true, ancestorGroupPaths: ['server:c[3]', 'server:c[3]/c[0]'] };
    expect(isEffectivelyVisible(c, groupAllVisible)).toBe(true);
  });

  it('returns false when ANY ancestor is recorded as hidden', () => {
    const c = { visible: true, ancestorGroupPaths: ['server:c[3]', 'server:c[3]/c[0]'] };
    expect(isEffectivelyVisible(c, groupParentHidden)).toBe(false);
  });

  it('treats untracked ancestor paths as visible (default-true)', () => {
    const c = { visible: true, ancestorGroupPaths: ['server:c[42]'] };
    expect(isEffectivelyVisible(c, new Map())).toBe(true);
  });

  describe('with wizardState', () => {
    const stepGroups = new Map<string, boolean>([
      ['server:c[3]', true],   // active step
      ['server:c[4]', false],  // inactive step
    ]);
    const ws = { stepPaths: ['server:c[3]', 'server:c[4]'], currentStepIndex: 0 };

    it('treats descendants of the active step as visible regardless of own Visible flag', () => {
      // BC publishes inner controls of inactive steps as Visible:false; when
      // the step activates, BC does not re-publish. Active step subtree must
      // override individual Visible:false flags.
      const c = {
        visible: false,
        ancestorGroupPaths: ['server:c[3]', 'server:c[3]/c[0]'],
      };
      expect(isEffectivelyVisible(c, stepGroups, ws)).toBe(true);
    });

    it('hides descendants of an inactive step', () => {
      const c = {
        visible: true,
        ancestorGroupPaths: ['server:c[4]', 'server:c[4]/c[0]'],
      };
      expect(isEffectivelyVisible(c, stepGroups, ws)).toBe(false);
    });

    it('respects outer (non-step) ancestor visibility before crossing into the step', () => {
      const wrapped = new Map<string, boolean>([
        ['server:c[0]', false],   // outer container hidden
        ['server:c[0]/c[1]', true], // step inside it
      ]);
      const wsInner = { stepPaths: ['server:c[0]/c[1]'], currentStepIndex: 0 };
      const c = {
        visible: true,
        ancestorGroupPaths: ['server:c[0]', 'server:c[0]/c[1]'],
      };
      // The outer container is hidden — must short-circuit to false even though
      // the inner step is "active".
      expect(isEffectivelyVisible(c, wrapped, wsInner)).toBe(false);
    });

    it('falls through to control.visible when no wizardState', () => {
      const c = { visible: false, ancestorGroupPaths: ['server:c[3]'] };
      expect(isEffectivelyVisible(c, stepGroups, null)).toBe(false);
    });
  });
});
