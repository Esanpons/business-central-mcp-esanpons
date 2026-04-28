// src/protocol/cue-detection.ts
//
// Thin discriminator helpers for cuegroup wire types. The actual node-type
// tags (stackgc / stackc) are the discriminators -- the type guards in
// form-node.ts already do the work. This module exists so callers don't
// have to remember whether to import the predicate from form-node or
// elsewhere, and as a future extension point if BC ever adds non-stackgc
// cue group variants.

import {
  isStackGroupNode,
  isCueFieldNode as isCueFieldNodeRaw,
  type FormNode,
  type CueFieldNode,
  type StackGroupNode,
} from './form-node.js';

/** True when `node` is a cuegroup container. */
export function isCueGroupNode(node: FormNode): node is StackGroupNode {
  return isStackGroupNode(node);
}

/** True when `node` is a cue tile. */
export function isCueFieldNode(node: FormNode): node is CueFieldNode {
  return isCueFieldNodeRaw(node);
}

/**
 * Returns the controlPath that bc_execute_action should target to drill
 * down on this cue. Today this is the cue field's own controlPath;
 * SystemAction 120 (DrillDown) on the field invokes its DefaultAction.
 *
 * Reference: decompiled InvokeActionInteraction.GetContextActionToExecute
 * which uses DefaultAction on the resolved control.
 */
export function cueDrillDownPath(field: CueFieldNode): string {
  return field.controlPath;
}
