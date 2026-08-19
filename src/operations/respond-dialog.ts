import { ok, err, isOk, type Result } from '../core/result.js';
import { ProtocolError } from '../core/errors.js';
import type { BCSession } from '../session/bc-session.js';
import type { PageContextRepository } from '../protocol/page-context-repo.js';
import type { DataService, FieldWriteResult } from '../services/data-service.js';
import { SystemAction } from '../protocol/types.js';
import { detectChangedSections, detectDialogs } from '../protocol/mutation-result.js';
import { resyncPageRepeaters } from '../services/repeater-sync.js';
import type { Logger } from '../core/logger.js';

export interface RespondDialogInput {
  pageContextId: string;
  dialogFormId: string;
  response: 'ok' | 'cancel' | 'yes' | 'no' | 'abort' | 'close';
  /** Values to write into the dialog BEFORE answering it. */
  fields?: Record<string, string | number | boolean>;
}

export interface RespondDialogOutput {
  success: boolean;
  changedSections: string[];
  dialogsOpened: Array<{ formId: string; message?: string; fields?: import('../protocol/types.js').ControlField[] }>;
  requiresDialogResponse: boolean;
  openedPages: Array<{ pageContextId: string; caption: string }>;
  /** Per-field outcome of the `fields` written before answering. Absent when no fields were sent. */
  fieldResults?: FieldWriteResult[];
}

const RESPONSE_MAP: Record<string, number> = {
  ok: SystemAction.Ok,
  cancel: SystemAction.Cancel,
  yes: SystemAction.Yes,
  no: SystemAction.No,
  abort: SystemAction.Abort,
};

export class RespondDialogOperation {
  constructor(
    private readonly session: BCSession,
    private readonly repo: PageContextRepository,
    private readonly logger?: Logger,
    /**
     * Writes the `fields` a dialog carries. This is the SAME service bc_write_data
     * uses, deliberately: a dialog is a section like any other, so its values must be
     * written by the one code path that verifies them (echo, validation messages,
     * `changed`) instead of a second, laxer one living here.
     */
    private readonly dataService?: DataService,
  ) {}

  async execute(input: RespondDialogInput): Promise<Result<RespondDialogOutput, ProtocolError>> {
    const ctx = this.repo.get(input.pageContextId);
    if (!ctx) return err(this.repo.notFoundError(input.pageContextId));

    // Fill the dialog BEFORE answering it. This used to be impossible: the schema had
    // no `fields` at all, so a caller that sent them had them silently stripped and BC
    // ran the dialog on its DEFAULT values while the result said success:true. On a
    // "Copy document lines" dialog that copied the wrong document and put ~50 wrong
    // lines into an order (bc-saas F-39 §5). Executing something other than what was
    // asked, and reporting success, is worse than failing.
    let fieldResults: FieldWriteResult[] | undefined;
    if (input.fields && Object.keys(input.fields).length > 0) {
      const filled = await this.fillDialog(input);
      if (!isOk(filled)) return filled;
      fieldResults = filled.value;
    }

    // "close" uses CloseForm instead of InvokeAction
    if (input.response === 'close') {
      const closeResult = await this.session.invoke(
        { type: 'CloseForm' as const, formId: input.dialogFormId },
        (event) => event.type === 'InvokeCompleted',
      );
      if (!isOk(closeResult)) return closeResult;

      // Apply the close events to the page context so the closed dialog form is
      // pruned and section validity is recomputed. Without this, detectChangedSections
      // runs against pre-close state and the context keeps tracking the dead form.
      this.repo.applyToPage(input.pageContextId, closeResult.value);
      this.repo.removeDialog(input.pageContextId, input.dialogFormId);

      const updatedCtx = this.repo.get(input.pageContextId);
      const changedSections = updatedCtx ? detectChangedSections(updatedCtx, closeResult.value) : [];
      const newDialogs = detectDialogs(closeResult.value);
      return ok({
        success: true,
        changedSections,
        dialogsOpened: newDialogs,
        requiresDialogResponse: newDialogs.length > 0,
        openedPages: [],
        ...(fieldResults ? { fieldResults } : {}),
      });
    }

    const systemAction = RESPONSE_MAP[input.response];
    if (systemAction === undefined) {
      return err(new ProtocolError(`Invalid dialog response: ${input.response}. Use: ok, cancel, yes, no, abort, close`));
    }

    const result = await this.session.invoke(
      {
        type: 'InvokeAction' as const,
        formId: input.dialogFormId,
        controlPath: 'server:c[0]',
        systemAction,
      },
      (event) => event.type === 'InvokeCompleted' || event.type === 'FormCreated' || event.type === 'DialogOpened',
    );

    if (!isOk(result)) return result;

    const events = result.value;
    this.repo.applyToPage(input.pageContextId, events);

    const newDialogs = detectDialogs(events);

    // The answered dialog is gone even though BC never says so — no FormClosed comes
    // back for a dismissed dialog (verified live on devel1). Prune it, unless BC just
    // re-published a dialog with the SAME formId, which would mean it is still there.
    if (!newDialogs.some(d => d.formId === input.dialogFormId)) {
      this.repo.removeDialog(input.pageContextId, input.dialogFormId);
    }

    // The answer may have committed a destructive change without BC saying which row
    // it removed: confirming a line delete deletes the record server-side and sends
    // nothing that identifies it, so the projection keeps listing a row that no
    // longer exists (verified live on SaaS — a freshly opened context did not list
    // it). Re-read the repeaters once the dialog chain is actually finished.
    if (newDialogs.length === 0) {
      await resyncPageRepeaters(this.session, this.repo, input.pageContextId, this.logger);
    }

    const updatedCtx = this.repo.get(input.pageContextId);
    const changedSections = updatedCtx ? detectChangedSections(updatedCtx, events) : [];

    // Check for new pages opened (e.g., posting creates a Posted Invoice)
    const openedPages: Array<{ pageContextId: string; caption: string }> = [];
    for (const event of events) {
      if (event.type === 'FormCreated' && event.formId !== ctx.rootFormId) {
        const newCtx = this.repo.getByFormId(event.formId);
        if (newCtx && newCtx.pageContextId !== input.pageContextId) {
          openedPages.push({ pageContextId: newCtx.pageContextId, caption: newCtx.caption });
        }
      }
    }

    return ok({
      success: true,
      changedSections,
      dialogsOpened: newDialogs,
      requiresDialogResponse: newDialogs.length > 0,
      openedPages,
      ...(fieldResults ? { fieldResults } : {}),
    });
  }

  /**
   * Write `fields` into the dialog and REFUSE to answer it unless every one of them
   * actually took.
   *
   * Two rules, both learned the hard way:
   *  - The dialog is addressed by its FORM ID, never by the section name. The first
   *    open dialog is called `dialog`, a second concurrent one `dialog#2`, so a
   *    hardcoded name would fill the wrong one.
   *  - A field that did not change ABORTS the whole call. The dialog stays open,
   *    untouched and still answerable, and the caller gets the per-field reasons. The
   *    alternative -- answer anyway and report the failures alongside -- is what made
   *    the original bug destructive: BC executes with its defaults, and by the time
   *    anyone reads `fieldResults` the ~50 wrong lines are already in the document.
   */
  private async fillDialog(input: RespondDialogInput): Promise<Result<FieldWriteResult[], ProtocolError>> {
    if (input.response === 'cancel' || input.response === 'abort' || input.response === 'close') {
      return err(new ProtocolError(
        `fields cannot be combined with response "${input.response}": a dialog being dismissed does not take values. `
        + 'Use response "ok" or "yes" to fill and confirm it, or drop fields to dismiss it.',
      ));
    }
    if (!this.dataService) {
      return err(new ProtocolError(
        'This server build cannot write dialog fields (no DataService wired into bc_respond_dialog). '
        + 'Write them with bc_write_data { section: "dialog", fields } and then answer with bc_respond_dialog.',
      ));
    }

    const ctx = this.repo.get(input.pageContextId);
    const section = ctx?.sections
      ? [...ctx.sections.values()].find(s => s.kind === 'dialog' && s.formId === input.dialogFormId && s.valid)
      : undefined;
    if (!section) {
      const known = ctx?.sections ? [...ctx.sections.values()].filter(s => s.kind === 'dialog').map(s => s.sectionId) : [];
      return err(new ProtocolError(
        `No open dialog section for dialogFormId "${input.dialogFormId}" on this page, so its fields cannot be written. `
        + (known.length > 0
          ? `Open dialog sections: ${known.join(', ')}. Check the dialogFormId against the dialogsOpened array.`
          : 'The page has no open dialog at all — check the dialogFormId against the dialogsOpened array of the call that raised it.'),
      ));
    }

    const values: Record<string, string> = {};
    for (const [k, v] of Object.entries(input.fields ?? {})) values[k] = String(v);

    const written = await this.dataService.writeFields(input.pageContextId, values, { sectionId: section.sectionId });
    if (!isOk(written)) return written;

    const results = written.value.results;
    // `changed === undefined` is UNVERIFIED, not failed: BC echoed nothing and the
    // projection said nothing. Treating it as a failure would block dialogs that work,
    // so it passes with its reason visible in fieldResults.
    const rejected = results.filter(r => !r.success || r.changed === false);
    if (rejected.length > 0) {
      const detail = rejected
        .map(r => `"${r.fieldName}": ${r.error ?? r.validationMessage ?? r.reason ?? 'did not change'}`)
        .join('; ');
      return err(new ProtocolError(
        `The dialog was NOT answered because ${rejected.length} of ${results.length} field(s) did not take: ${detail}. `
        + 'The dialog is still open and unchanged — BC was not allowed to run it on its default values. '
        + 'Fix the field names/values (bc_read_data { section: "' + section.sectionId + '" } lists what it accepts) and call again.',
        { dialogFormId: input.dialogFormId, dialogSection: section.sectionId, fieldResults: results },
      ));
    }

    this.logger?.info(`Filled ${results.length} field(s) on dialog ${input.dialogFormId} before answering "${input.response}"`);
    return ok(results);
  }
}
