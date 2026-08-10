// tests/protocol/wizard-classify.test.ts
//
// Mis-classifying a wizard terminator is destructive: "cancel" that actually
// COMMITS is worse than no cancel at all.

import { describe, it, expect } from 'vitest';
import { classifyWizardNav, pickWizardNavAction } from '../../src/protocol/wizard-classify.js';
import type { ActionNode } from '../../src/protocol/form-node.js';
import { SystemAction } from '../../src/protocol/types.js';

function action(opts: { caption: string; systemAction?: number; icon?: string; path?: string }): ActionNode {
  return {
    type: 'ac',
    controlPath: opts.path ?? `server:a[${opts.caption}]`,
    properties: { caption: opts.caption, enabled: true },
    systemAction: opts.systemAction ?? 0,
    ...(opts.icon ? { iconIdentifier: opts.icon } : {}),
    children: [],
    isLineScoped: false,
  };
}

describe('classifyWizardNav', () => {
  it('classifies back/next/finish from the icon resource', () => {
    expect(classifyWizardNav(action({ caption: 'Back', icon: 'PreviousRecord' }))).toBe('back');
    expect(classifyWizardNav(action({ caption: 'Next', icon: 'NextRecord' }))).toBe('next');
    expect(classifyWizardNav(action({ caption: 'Finish', icon: 'Approve' }))).toBe('finish');
  });

  it('classifies Cancel and Abort as cancel', () => {
    expect(classifyWizardNav(action({ caption: 'Cancel', systemAction: SystemAction.Cancel }))).toBe('cancel');
    expect(classifyWizardNav(action({ caption: 'Abort', systemAction: SystemAction.Abort }))).toBe('cancel');
  });

  it('classifies CloseOk as FINISH — it commits, it does not cancel', () => {
    expect(classifyWizardNav(action({ caption: 'Close', systemAction: SystemAction.CloseOk }))).toBe('finish');
  });

  it('leaves ordinary actions unclassified', () => {
    expect(classifyWizardNav(action({ caption: 'Post' }))).toBeUndefined();
  });
});

describe('pickWizardNavAction', () => {
  it('prefers a real Cancel over anything else that classifies as cancel', () => {
    const actions = [
      action({ caption: 'Abort', systemAction: SystemAction.Abort, path: 'server:a[0]' }),
      action({ caption: 'Cancel', systemAction: SystemAction.Cancel, path: 'server:a[1]' }),
    ];
    expect(pickWizardNavAction(actions, 'cancel')!.properties.caption).toBe('Cancel');
  });

  it('never returns a commit terminator for cancel, whatever the document order', () => {
    // The regression: CloseOk classified as 'cancel' and came first, so cancelling
    // the wizard confirmed it.
    const actions = [
      action({ caption: 'Close', systemAction: SystemAction.CloseOk, path: 'server:a[0]' }),
      action({ caption: 'Cancel', systemAction: SystemAction.Cancel, path: 'server:a[1]' }),
    ];
    const picked = pickWizardNavAction(actions, 'cancel')!;
    expect(picked.systemAction).toBe(SystemAction.Cancel);
    expect(pickWizardNavAction(actions, 'finish')!.systemAction).toBe(SystemAction.CloseOk);
  });

  it('returns undefined when no action carries the role', () => {
    expect(pickWizardNavAction([action({ caption: 'Post' })], 'cancel')).toBeUndefined();
  });
});
