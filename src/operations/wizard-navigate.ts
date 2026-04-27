import { mapResult, type Result } from '../core/result.js';
import type { ProtocolError } from '../core/errors.js';
import type { ActionService } from '../services/action-service.js';
import type { PageContextRepository } from '../protocol/page-context-repo.js';
import { resolveSection } from '../protocol/section-resolver.js';
import { detectChangedSections, detectDialogs } from '../protocol/mutation-result.js';
import { isEffectivelyVisible } from '../protocol/visibility.js';
import type { ControlField } from '../protocol/types.js';
import { fields as treeFields, actions as treeActions, groupVisibility as treeGroupVisibility } from '../protocol/form-views.js';
import type { ActionNode } from '../protocol/form-node.js';

export type WizardNav = 'back' | 'next' | 'finish' | 'cancel';

export interface WizardNavigateInput {
  pageContextId: string;
  action: WizardNav;
}

export interface WizardNavigateOutput {
  success: boolean;
  /** Step caption / page caption after the navigation completes. */
  caption: string;
  /** Fields visible on the new step. */
  fields: Array<{ name: string; value?: string; editable: boolean }>;
  /** Wizard navigation actions still available (next step may not have all four). */
  availableNav: WizardNav[];
  /** True when the wizard closed (Finish or Cancel) — page should be considered done. */
  closed: boolean;
  changedSections: string[];
  dialogsOpened: Array<{ formId: string; message?: string; fields?: ControlField[] }>;
}

function classifyWizardNav(a: ActionNode): WizardNav | undefined {
  const id = a.iconIdentifier;
  if (id) {
    if (/PreviousRecord/i.test(id)) return 'back';
    if (/NextRecord|Action_Start/i.test(id)) return 'next';
    if (/Approve/i.test(id)) return 'finish';
  }
  if (a.systemAction === 310 || a.systemAction === 320 || a.systemAction === 350) return 'cancel';
  return undefined;
}

export class WizardNavigateOperation {
  constructor(
    private readonly actionService: ActionService,
    private readonly repo: PageContextRepository,
  ) {}

  async execute(input: WizardNavigateInput): Promise<Result<WizardNavigateOutput, ProtocolError>> {
    const result = await this.actionService.executeWizardNav(input.pageContextId, input.action);
    return mapResult(result, (ar) => {
      const ctx = this.repo.get(input.pageContextId);
      const dialogsOpened = detectDialogs(ar.events);
      const changedSections = ctx ? detectChangedSections(ctx, ar.events) : [];

      let caption = ctx?.caption ?? '';
      let fieldsOut: WizardNavigateOutput['fields'] = [];
      let availableNav: WizardNav[] = [];
      let closed = false;

      if (ctx) {
        const resolved = resolveSection(ctx, 'header');
        const root = 'error' in resolved ? undefined : resolved.form.root;
        const ws = ctx.wizardState;
        caption = ctx.caption || caption;
        if (root) {
          const groupVis = treeGroupVisibility(root);
          fieldsOut = treeFields(root)
            .filter(f => f.properties.caption && isEffectivelyVisible(root, f.controlPath, groupVis, ws))
            .map(f => ({
              name: f.properties.caption!,
              value: f.properties.stringValue,
              editable: f.properties.editable ?? false,
            }));
          availableNav = treeActions(root)
            .filter(a => (a.properties.enabled ?? true) && isEffectivelyVisible(root, a.controlPath, groupVis, ws))
            .map(a => classifyWizardNav(a))
            .filter((v): v is WizardNav => !!v);
        }
        closed = (input.action === 'finish' || input.action === 'cancel') && availableNav.length === 0;
      } else {
        closed = true;
      }

      return {
        success: ar.success,
        caption,
        fields: fieldsOut,
        availableNav,
        closed,
        changedSections,
        dialogsOpened,
      };
    });
  }
}
