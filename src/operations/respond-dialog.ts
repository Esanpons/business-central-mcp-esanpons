import { ok, err, isOk, type Result } from '../core/result.js';
import { ProtocolError } from '../core/errors.js';
import type { BCSession } from '../session/bc-session.js';
import type { PageContextRepository } from '../protocol/page-context-repo.js';
import type { DataService, FieldWriteResult } from '../services/data-service.js';
import type { BCEvent } from '../protocol/types.js';
import { SystemAction } from '../protocol/types.js';
import { actions as treeActions } from '../protocol/form-views.js';
import {
  detectChangedSections, detectDialogs, detectFiles, detectMessages, detectValidationErrors, withDialogSections,
  type DialogInfo, type FileInfo, type MessageInfo, type ValidationErrorInfo,
} from '../protocol/mutation-result.js';
import { resyncPageRepeaters, reportableResyncEvents } from '../services/repeater-sync.js';
import { stripFieldEvents } from './write-data.js';
import type { Logger } from '../core/logger.js';

export interface RespondDialogInput {
  pageContextId: string;
  dialogFormId: string;
  response: 'ok' | 'cancel' | 'yes' | 'no' | 'abort' | 'close';
  /** Values to write into the dialog BEFORE answering it. */
  fields?: Record<string, string | number | boolean>;
}

export interface RespondDialogOutput {
  /** False when BC reported an error after the answer (see `errors`): the dialog WAS answered, the operation behind it failed. */
  success: boolean;
  /**
   * Errors BC attached to the page after the answer instead of raising an error
   * dialog — a failed OnDelete, a posting check ("The date Allow Document Deletion
   * Before must be set..."). Absent when there were none.
   */
  errors?: ValidationErrorInfo[];
  changedSections: string[];
  /**
   * The dialog(s) BC put up IN RESPONSE to this answer — the next question of a
   * chain ("Se va a crear..." -> "¿Quieres verlos?"), an error the answer ran into.
   * Answer them in turn; the chain is over when this is empty.
   */
  dialogsOpened: DialogInfo[];
  requiresDialogResponse: boolean;
  openedPages: Array<{ pageContextId: string; caption: string }>;
  /** What BC told the user once the dialog was answered (an AL `Message()`). Absent when BC said nothing. */
  messages?: MessageInfo[];
  /** Per-field outcome of the `fields` written before answering. Absent when no fields were sent. */
  fieldResults?: FieldWriteResult[];
  /** Present when the answer opened pages: read them before trusting `success` (an Error Messages page is a failure). */
  note?: string;
  /** Files BC produced (a report printed from a request page). Absent when none. */
  files?: FileInfo[];
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
    /**
     * Registers the pages an answer makes BC open (ActionService.adoptOpenedPages).
     * Posting confirmed through a dialog opens the posted document, or — when it
     * fails with several errors — the "Mensajes de error" page, as a brand-new
     * ownerless FormCreated. Without this nothing gave it a pageContextId, so it was
     * never reported and a FAILED posting came back as a clean `success: true`
     * (bc-saas F-56 2nd case, F-65).
     */
    private readonly adoptOpenedPages?: (events: readonly BCEvent[], sourceFormId: string | undefined) => Promise<string[]>,
    /** Loads the rows of a chained dialog's grids (PageService.loadDialogContent). */
    private readonly loadDialogContent?: (pageContextId: string, events: readonly BCEvent[]) => Promise<void>,
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
      const newDialogs = detectDialogs(closeResult.value);
      this.forgetAnswered(input, newDialogs);

      const updatedCtx = this.repo.get(input.pageContextId);
      const changedSections = updatedCtx ? detectChangedSections(updatedCtx, closeResult.value) : [];
      const messages = detectMessages(closeResult.value);
      return ok({
        success: true,
        changedSections,
        dialogsOpened: newDialogs,
        requiresDialogResponse: newDialogs.length > 0,
        openedPages: [],
        ...(messages.length > 0 ? { messages } : {}),
        ...(fieldResults ? { fieldResults } : {}),
      });
    }

    const systemAction = RESPONSE_MAP[input.response];
    if (systemAction === undefined) {
      return err(new ProtocolError(`Invalid dialog response: ${input.response}. Use: ok, cancel, yes, no, abort, close`));
    }

    const button = this.resolveButton(input.pageContextId, input.dialogFormId, input.response, systemAction);
    const result = await this.session.invoke(
      {
        type: 'InvokeAction' as const,
        formId: input.dialogFormId,
        controlPath: button.controlPath,
        systemAction: button.systemAction,
      },
      (event) => event.type === 'InvokeCompleted' || event.type === 'FormCreated' || event.type === 'DialogOpened',
    );

    if (!isOk(result)) return result;

    const events: BCEvent[] = [...result.value];
    // Forget the answered dialog BEFORE applying the answer's events, so the next
    // dialog of a chain takes the plain `dialog` section id instead of `dialog#2`
    // (the answered one still held it) — the name the caller is told to use.
    this.forgetAnswered(input, detectDialogs(events));
    this.repo.applyToPage(input.pageContextId, events);
    const adopted = this.adoptOpenedPages
      ? await this.adoptOpenedPages(events, ctx.rootFormId).catch((e: unknown) => {
        this.logger?.warn(`Could not register the page(s) the answer opened: ${e instanceof Error ? e.message : String(e)}`);
        return [] as string[];
      })
      : [];

    let newDialogs = detectDialogs(events);
    if (newDialogs.length > 0 && this.loadDialogContent) {
      await this.loadDialogContent(input.pageContextId, events).catch((e: unknown) => {
        this.logger?.warn(`Loading the rows of the next dialog failed: ${e instanceof Error ? e.message : String(e)}`);
      });
    }

    // The answer may have committed a destructive change without BC saying which row
    // it removed: confirming a line delete deletes the record server-side and sends
    // nothing that identifies it, so the projection keeps listing a row that no
    // longer exists (verified live on SaaS — a freshly opened context did not list
    // it). Re-read the repeaters once the dialog chain is actually finished.
    //
    // The re-sync is itself a request to BC and can raise a dialog of its own (a
    // Refresh on a page with unsaved changes asks whether to discard them). It settles
    // those it caused; anything it could not settle is OPEN on the server and is part
    // of this answer's result. Dropping it is what left the caller with
    // `dialogsOpened: []` while BC held a modal (bc-saas F-45).
    if (newDialogs.length === 0) {
      const resync = await resyncPageRepeaters(this.session, this.repo, input.pageContextId, this.logger);
      const reported = reportableResyncEvents(resync);
      if (reported.length > 0) {
        events.push(...reported);
        newDialogs = detectDialogs(events);
      }
    }

    const updatedCtx = this.repo.get(input.pageContextId);
    const changedSections = updatedCtx ? detectChangedSections(updatedCtx, events) : [];
    const messages = detectMessages(events);
    const files = detectFiles(events);
    // A trigger that failed after the answer (OnDelete, a posting check) reports its
    // error as ValidationResults, not as a dialog (bc-saas F-56).
    const errors = detectValidationErrors(events);

    // Pages the answer opened (posting opens the posted document; a posting that fails
    // with several errors opens "Mensajes de error"). Only ownerless forms count: a
    // FormCreated with a parentFormId is a subpage/FactBox of an existing page.
    const openedPages: Array<{ pageContextId: string; caption: string }> = [];
    const seen = new Set<string>();
    const report = (pcId: string): void => {
      if (pcId === input.pageContextId || seen.has(pcId)) return;
      const opened = this.repo.get(pcId);
      if (!opened) return;
      seen.add(pcId);
      openedPages.push({ pageContextId: pcId, caption: opened.caption });
    };
    for (const pcId of adopted) report(pcId);
    for (const event of events) {
      if (event.type === 'FormCreated' && !event.parentFormId && event.formId !== ctx.rootFormId) {
        const newCtx = this.repo.getByFormId(event.formId);
        if (newCtx) report(newCtx.pageContextId);
      }
    }

    return ok({
      success: errors.length === 0,
      ...(errors.length > 0 ? { errors } : {}),
      changedSections,
      dialogsOpened: withDialogSections(updatedCtx, newDialogs),
      requiresDialogResponse: newDialogs.length > 0,
      openedPages,
      ...(messages.length > 0 ? { messages } : {}),
      ...(files.length > 0 ? { files } : {}),
      ...(fieldResults ? { fieldResults } : {}),
      ...(openedPages.length > 0 ? {
        note: `The answer opened ${openedPages.length} page(s): ${openedPages.map(p => `"${p.caption}" (${p.pageContextId})`).join(', ')}. `
          + 'Read them with bc_read_data before assuming the operation went through: when a posting fails with several errors BC opens '
          + 'the "Error Messages" page ("Mensajes de error") instead of an error dialog, and the errors are its rows.',
      } : {}),
    });
  }

  /**
   * The button that really means `response` on THIS dialog.
   *
   * A page run modally in lookup mode does not have an Ok button: it publishes its
   * own "Aceptar" with SystemAction LookupOk=330 (and "Cancelar" LookupCancel=340).
   * Measured live on devel1 (BC27, 2026-10-03) on "Posted Sales Shipment - Update"
   * (page 1350, the sibling of 1351). Those "<posted doc> - Update" pages only save
   * in `OnQueryClosePage` when `CloseAction = Action::LookupOK` (w1-28 source of
   * pages 1350/1351/...). Answering with a plain Ok=300 closed the page as OK, the
   * trigger did nothing, and the edit was thrown away while the field write had
   * reported `changed: true` (bc-saas F-47 d). So: when the dialog publishes a button
   * for the answer, press THAT one; otherwise keep the generic system action.
   *
   * A report REQUEST PAGE has no Ok either: "Imprimir" = Print 420, "Vista previa y
   * cerrar" = Preview 400, "Enviar a..." = SendTo 410. Measured live on devel1
   * (2026-10-04): Ok=300 is accepted and ignored — the page stays open on the
   * server, the report never runs, nothing after `Report.RunModal` executes (the
   * DeCA "¿Se ha entregado...?" Confirm), and since the answered dialog was untracked
   * the NEXT call died with LogicalModalityViolation on an empty modal stack
   * (bc-saas F-55, F-71). "ok" on a request page therefore presses Print, the
   * report's own main button; Preview is the fallback when Print is not offered.
   * Only VISIBLE buttons count: a request page publishes hidden copies of each.
   */
  private resolveButton(
    pageContextId: string,
    dialogFormId: string,
    response: RespondDialogInput['response'],
    fallback: number,
  ): { systemAction: number; controlPath: string } {
    const generic = { systemAction: fallback, controlPath: 'server:c[0]' };
    const candidates: Record<string, number[]> = {
      ok: [SystemAction.Ok, SystemAction.LookupOk, SystemAction.CloseOk, SystemAction.Print, SystemAction.Preview],
      cancel: [SystemAction.Cancel, SystemAction.LookupCancel],
      yes: [SystemAction.Yes],
      no: [SystemAction.No],
      abort: [SystemAction.Abort],
    };
    const wanted = candidates[response];
    const form = this.repo.get(pageContextId)?.forms?.get(dialogFormId);
    if (!wanted || !form) return generic;
    const enabled = treeActions(form.root).filter(a => a.properties.enabled !== false);
    const visible = enabled.filter(a => a.properties.visible !== false);
    // Visible buttons first; an enabled-but-hidden one only when nothing visible fits.
    for (const pool of [visible, enabled]) {
      for (const sa of wanted) {
        const action = pool.find(a => a.systemAction === sa);
        if (action) {
          if (sa !== fallback) this.logger?.info(`Dialog ${dialogFormId} answers "${response}" with its own button (systemAction ${sa}, ${action.controlPath})`);
          return { systemAction: sa, controlPath: action.controlPath };
        }
      }
    }
    return generic;
  }

  /**
   * The answered dialog is gone even though BC never says so — no FormClosed comes
   * back for a dismissed dialog (verified live on devel1, BC27: the "Archive Order?"
   * confirm, an error box and a selection menu all closed without one). Untrack it in
   * the page context AND in the session's modal stack, unless BC just re-published a
   * dialog with the SAME formId, which would mean it is still there.
   *
   * Only the page context used to be pruned. The session kept every answered dialog
   * on its modal stack forever, so `modalDepth` climbed with each answer (bc-saas
   * F-45: 1..9) and the next LogicalModalityViolation reconcile spent its attempts on
   * forms BC had long thrown away (27 "survived No/Cancel/Abort/CloseForm —
   * force-popping" lines on 2026-10-03, each one a FormNotFoundException) while the
   * dialog that really blocked the session was never on the stack at all.
   */
  private forgetAnswered(input: RespondDialogInput, newDialogs: readonly DialogInfo[]): void {
    if (newDialogs.some(d => d.formId === input.dialogFormId)) return;
    this.repo.removeDialog(input.pageContextId, input.dialogFormId);
    this.session.removeOpenForm(input.dialogFormId);
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
   *    "Did not change" excludes `reason: "already set"`: the field ALREADY held the
   *    requested value, which is exactly the state the caller asked for (bc-saas F-46).
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

    // The raw BC events of each write are internal evidence, not output: they made
    // a single answer tens of KB long (bc-saas F-42).
    const results = stripFieldEvents(written.value.results);
    // `changed === undefined` is UNVERIFIED, not failed: BC echoed nothing and the
    // projection said nothing. Treating it as a failure would block dialogs that work,
    // so it passes with its reason visible in fieldResults. `already set` is the
    // requested state already in place — not a failure either.
    const rejected = results.filter(r => !r.success || (r.changed === false && r.reason !== 'already set'));
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
