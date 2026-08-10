// src/protocol/wizard-classify.ts
//
// Classify a BC ActionNode as one of the wizard navigation roles
// (back/next/finish/cancel). Centralised here so MCP-boundary adapters
// (open-page, navigate, wizard-navigate, section-dto, action-service)
// share one implementation.

import type { ActionNode } from './form-node.js';
import { SystemAction } from './types.js';

export type WizardNav = 'back' | 'next' | 'finish' | 'cancel';

export function classifyWizardNav(a: ActionNode): WizardNav | undefined {
  const id = a.iconIdentifier;
  if (id) {
    if (/PreviousRecord/i.test(id)) return 'back';
    if (/NextRecord|Action_Start/i.test(id)) return 'next';
    if (/Approve/i.test(id)) return 'finish';
  }
  // CloseOk (350) is a COMMIT terminator ("close as OK") — decompiled
  // `Microsoft.Dynamics.Framework.UI.Client.SystemAction.cs`. Classifying it as
  // 'cancel' meant that on a wizard whose CloseOk action happens to come first in
  // document order, asking to CANCEL confirmed the wizard instead. It is a finish.
  if (a.systemAction === SystemAction.CloseOk) return 'finish';
  // Cancel shape: SystemAction.Cancel (310), SystemAction.Abort (320).
  if (a.systemAction === SystemAction.Cancel
      || a.systemAction === SystemAction.Abort) return 'cancel';
  return undefined;
}

/**
 * Pick the action to invoke for a requested wizard role. Document order is NOT
 * authoritative for the destructive/irreversible roles, so for 'cancel' the true
 * abort actions (SystemAction.Cancel / Abort) win over anything else that merely
 * classifies as cancel; for 'finish' an explicit terminator wins over an
 * icon-derived guess. Returns undefined when no action carries the role.
 */
export function pickWizardNavAction<T extends ActionNode>(actions: readonly T[], nav: WizardNav): T | undefined {
  const candidates = actions.filter(a => classifyWizardNav(a) === nav);
  if (candidates.length === 0) return undefined;
  if (nav === 'cancel') {
    // Cancel before Abort: both abandon the wizard, but Abort is BC's harder
    // "tear the modal down" variant and is the second choice.
    const hard = candidates.find(a => a.systemAction === SystemAction.Cancel)
      ?? candidates.find(a => a.systemAction === SystemAction.Abort);
    if (hard) return hard;
  }
  if (nav === 'finish') {
    const hard = candidates.find(a => a.systemAction === SystemAction.CloseOk || a.systemAction === SystemAction.Ok);
    if (hard) return hard;
  }
  return candidates[0];
}
