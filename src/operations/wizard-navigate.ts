import { mapResult, type Result } from '../core/result.js';
import type { ProtocolError } from '../core/errors.js';
import type { ActionService } from '../services/action-service.js';
import type { PageContextRepository } from '../protocol/page-context-repo.js';
import { resolveSection } from '../protocol/section-resolver.js';
import { detectChangedSections, detectDialogs } from '../protocol/mutation-result.js';
import type { ControlField } from '../protocol/types.js';

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

      // After Finish/Cancel the wizard closes — the form may be gone from the
      // repo, or only carry an empty action set. We detect "closed" by checking
      // whether the rootForm still exposes any wizardNav actions.
      let caption = ctx?.caption ?? '';
      let fields: WizardNavigateOutput['fields'] = [];
      let availableNav: WizardNav[] = [];
      let closed = false;

      if (ctx) {
        const resolved = resolveSection(ctx, 'header');
        const root = 'error' in resolved ? undefined : resolved.form;
        caption = ctx.caption || caption;
        fields = (root?.controlTree ?? [])
          .filter(f => f.visible && f.caption)
          .map(f => ({ name: f.caption, value: f.stringValue, editable: f.editable }));
        availableNav = (root?.actions ?? [])
          .filter(a => a.wizardNav && a.enabled && a.visible)
          .map(a => a.wizardNav!) as WizardNav[];
        closed = (input.action === 'finish' || input.action === 'cancel') && availableNav.length === 0;
      } else {
        closed = true;
      }

      return {
        success: ar.success,
        caption,
        fields,
        availableNav,
        closed,
        changedSections,
        dialogsOpened,
      };
    });
  }
}
