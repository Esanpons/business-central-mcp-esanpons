// src/protocol/visibility.ts
//
// Effective-visibility derivation. A control is effectively visible when every
// ancestor group it lives inside is visible AND its own `visible` is true.
// This mirrors how BC's web client renders: a hidden gc collapses its entire
// subtree regardless of the descendants' own Visible flags.
//
// Wizard caveat — BC publishes every descendant of an inactive NavigatePage
// step as `Visible: false`, then never re-publishes when the step activates
// (the web client client-side toggles the active step's container and renders
// its subtree wholesale). We mirror that semantics: once a control's ancestor
// chain crosses into the active wizard step, in-step visibility is monolithic
// — individual `Visible: false` flags published on step-internal controls are
// ignored.
//
// Group visibility comes from two sources:
//   1. The static current value at parse time (LogicalControlSerializer.cs:81)
//   2. Mutations broadcast by the server via `PropertyChanged` events on the
//      gc's controlPath (FormProjection.apply handles those updates)
//   3. PageContextRepository.advanceWizardStep mirrors BC's client-side step
//      state machine since BC never broadcasts step transitions

import type { GroupVisibility, WizardState } from './types.js';
import type { FormNode } from './form-node.js';
import { findByControlPath, ancestorGroupPaths } from './form-tree-walk.js';

export function isEffectivelyVisible(
  root: FormNode,
  controlPath: string,
  groupVisibility: GroupVisibility,
  wizardState?: WizardState | null,
): boolean {
  const node = findByControlPath(root, controlPath);
  const intrinsic = node ? (node.properties.visible ?? true) : true;
  const paths = ancestorGroupPaths(root, controlPath);
  const activeStepPath = wizardState?.stepPaths[wizardState.currentStepIndex];

  for (const p of paths) {
    if (activeStepPath && p === activeStepPath) {
      // We crossed into the active wizard step's subtree. Outer ancestors
      // already passed (we got here). Inner ancestors and the control's own
      // Visible flag are not authoritative — BC's web client renders the
      // active step's subtree wholesale.
      return true;
    }
    // Untracked paths default to visible — only paths the parser saw as gc are
    // recorded; unknown ancestors must not fail-closed and hide everything.
    if (groupVisibility.has(p) && !groupVisibility.get(p)) return false;
  }
  return intrinsic;
}
