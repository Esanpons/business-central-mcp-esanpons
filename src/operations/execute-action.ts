import { err, mapResult, type Result } from '../core/result.js';
import { ProtocolError } from '../core/errors.js';
import type { ActionService, ActionResult } from '../services/action-service.js';
import type { PageContextRepository } from '../protocol/page-context-repo.js';
import type { ControlField } from '../protocol/types.js';
import { resolveSection } from '../protocol/section-resolver.js';
import {
  detectChangedSections, detectDialogs, detectFiles, detectMessages, detectValidationErrors, withDialogSections,
  type DialogInfo, type FileInfo, type MessageInfo, type ValidationErrorInfo,
} from '../protocol/mutation-result.js';
import { visibleCaptionedFields } from '../protocol/section-dto.js';

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
  /** False when BC reported an error for the action as ValidationResults (see `errors`). */
  success: boolean;
  /** Errors BC attached to the page instead of raising an error dialog (bc-saas F-56). Absent when none. */
  errors?: ValidationErrorInfo[];
  dialog?: { formId: string; message?: string; kind?: DialogInfo['kind']; fields?: ControlField[] };
  updatedFields?: Array<{ name: string; value?: string }>;
  changedSections: string[];
  openedPages: Array<{ pageContextId: string; caption: string }>;
  dialogsOpened: DialogInfo[];
  requiresDialogResponse: boolean;
  /**
   * What BC told the user as a result of the action: an AL `Message()` such as "El
   * DeCA ... queda publicado." Not a dialog (there is nothing to answer), which is why
   * it used to be dropped entirely (bc-saas F-44). Absent when BC said nothing.
   */
  messages?: MessageInfo[];
  /** Files BC produced for the client (a report run without a request page). Absent when none. */
  files?: FileInfo[];
  /**
   * For a bookmark-targeted Delete: whether the row is REALLY gone, checked against
   * the repeater re-read from the server. `false` means BC completed the action and
   * kept the row — see `note`. Absent when the action was not such a delete, or when
   * a dialog is still pending.
   */
  deleted?: boolean;
  /** Why an action completed without doing what its name says. */
  note?: string;
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
    const result = await this.actionService.executeAction(input.pageContextId, input.action, input.section, {
      bookmark: input.bookmark,
      rowIndex: input.rowIndex,
    });
    return mapResult(result, (ar) => this.buildOutput(input.pageContextId, ar, input.quiet ?? false));
  }

  private buildOutput(pageContextId: string, ar: ActionResult, quiet: boolean): ExecuteActionOutput {
    let updatedFields: Array<{ name: string; value?: string }> | undefined;
    if (!quiet && ar.updatedState) {
      const resolved = resolveSection(ar.updatedState, 'header');
      if (!('error' in resolved)) {
        updatedFields = visibleCaptionedFields(resolved.form.root, ar.updatedState.wizardState)
          .map(f => ({ name: f.properties.caption!, value: f.properties.stringValue }));
      }
    }

    const ctx = this.repo.get(pageContextId);
    const changedSections = ctx ? detectChangedSections(ctx, ar.events) : [];
    const dialogsOpened = withDialogSections(ctx, detectDialogs(ar.events));
    const messages = detectMessages(ar.events);
    const files = detectFiles(ar.events);
    const errors = detectValidationErrors(ar.events);

    // Detect opened pages from FormCreated events (excluding the source page's forms).
    // One entry per PAGE: its subforms/FactBoxes resolve to the same context.
    const openedPages: Array<{ pageContextId: string; caption: string }> = [];
    for (const event of ar.events) {
      if (event.type === 'FormCreated' && event.formId !== ctx?.rootFormId) {
        // New form opened -- check if repo has a page context for it
        const newCtx = this.repo.getByFormId(event.formId);
        if (newCtx && newCtx.pageContextId !== pageContextId && !openedPages.some(p => p.pageContextId === newCtx.pageContextId)) {
          openedPages.push({ pageContextId: newCtx.pageContextId, caption: newCtx.caption });
        }
      }
    }

    const primary = ar.dialog ? dialogsOpened.find(d => d.formId === ar.dialog!.formId) : undefined;
    return {
      success: ar.success && errors.length === 0,
      ...(errors.length > 0 ? { errors } : {}),
      dialog: ar.dialog ? {
        formId: ar.dialog.formId,
        message: primary?.message,
        kind: primary?.kind,
        fields: primary?.fields,
      } : undefined,
      updatedFields,
      changedSections,
      openedPages,
      dialogsOpened,
      requiresDialogResponse: dialogsOpened.length > 0,
      ...(messages.length > 0 ? { messages } : {}),
      ...(files.length > 0 ? { files } : {}),
      ...(ar.deleted !== undefined ? { deleted: ar.deleted } : {}),
      ...(ar.note ? { note: ar.note } : {}),
    };
  }
}
