import { err, mapResult, type Result } from '../core/result.js';
import { ProtocolError } from '../core/errors.js';
import type { ActionService, ActionResult } from '../services/action-service.js';
import type { PageContextRepository } from '../protocol/page-context-repo.js';
import type { ControlField } from '../protocol/types.js';
import { resolveSection } from '../protocol/section-resolver.js';
import { detectChangedSections, detectDialogs } from '../protocol/mutation-result.js';
import { isEffectivelyVisible } from '../protocol/visibility.js';
import { fields as treeFields, groupVisibility as treeGroupVisibility } from '../protocol/form-views.js';

export interface ExecuteActionInput {
  pageContextId: string;
  action?: string;
  cue?: string;
  section?: string;
  rowIndex?: number;
  bookmark?: string;
  /**
   * N3: suppress the full `updatedFields` dump. Document actions ("Editar",
   * "New") otherwise drag 100+ header fields into the response. With quiet,
   * only success / changedSections / openedPages / dialog info come back; pull
   * the fields you need afterwards with bc_read_data (acotat).
   */
  quiet?: boolean;
}

export interface ExecuteActionOutput {
  success: boolean;
  dialog?: { formId: string; message?: string; fields?: ControlField[] };
  updatedFields?: Array<{ name: string; value?: string }>;
  changedSections: string[];
  openedPages: Array<{ pageContextId: string; caption: string }>;
  dialogsOpened: Array<{ formId: string; message?: string; fields?: ControlField[] }>;
  requiresDialogResponse: boolean;
}

export class ExecuteActionOperation {
  constructor(
    private readonly actionService: ActionService,
    private readonly repo: PageContextRepository,
  ) {}

  async execute(input: ExecuteActionInput): Promise<Result<ExecuteActionOutput, ProtocolError>> {
    if (input.cue) {
      if (!input.section) {
        return err(new ProtocolError('cue requires a section (e.g. "subpage:Activities")'));
      }
      const result = await this.actionService.executeOnCue(input.pageContextId, input.section, input.cue);
      return mapResult(result, (ar) => this.buildOutput(input.pageContextId, ar, input.quiet ?? false));
    }
    if (!input.action) {
      return err(new ProtocolError('Provide exactly one of: action, cue'));
    }
    const result = await this.actionService.executeAction(input.pageContextId, input.action, input.section);
    return mapResult(result, (ar) => this.buildOutput(input.pageContextId, ar, input.quiet ?? false));
  }

  private buildOutput(pageContextId: string, ar: ActionResult, quiet: boolean): ExecuteActionOutput {
    let updatedFields: Array<{ name: string; value?: string }> | undefined;
    if (!quiet && ar.updatedState) {
      const resolved = resolveSection(ar.updatedState, 'header');
      if (!('error' in resolved)) {
        const root = resolved.form.root;
        const groupVis = treeGroupVisibility(root);
        updatedFields = treeFields(root)
          .filter(f => f.properties.caption && isEffectivelyVisible(root, f.controlPath, groupVis, ar.updatedState!.wizardState))
          .map(f => ({ name: f.properties.caption!, value: f.properties.stringValue }));
      }
    }

    const ctx = this.repo.get(pageContextId);
    const changedSections = ctx ? detectChangedSections(ctx, ar.events) : [];
    const dialogsOpened = detectDialogs(ar.events);

    // Detect opened pages from FormCreated events (excluding the source page's forms)
    const openedPages: Array<{ pageContextId: string; caption: string }> = [];
    for (const event of ar.events) {
      if (event.type === 'FormCreated' && event.formId !== ctx?.rootFormId) {
        // New form opened -- check if repo has a page context for it
        const newCtx = this.repo.getByFormId(event.formId);
        if (newCtx && newCtx.pageContextId !== pageContextId) {
          openedPages.push({ pageContextId: newCtx.pageContextId, caption: newCtx.caption });
        }
      }
    }

    return {
      success: ar.success,
      dialog: ar.dialog ? {
        formId: ar.dialog.formId,
        message: dialogsOpened.find(d => d.formId === ar.dialog!.formId)?.message,
        fields: dialogsOpened.find(d => d.formId === ar.dialog!.formId)?.fields,
      } : undefined,
      updatedFields,
      changedSections,
      openedPages,
      dialogsOpened,
      requiresDialogResponse: dialogsOpened.length > 0,
    };
  }
}
