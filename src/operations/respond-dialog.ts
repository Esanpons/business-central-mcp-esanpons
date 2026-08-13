import { ok, err, isOk, type Result } from '../core/result.js';
import { ProtocolError } from '../core/errors.js';
import type { BCSession } from '../session/bc-session.js';
import type { PageContextRepository } from '../protocol/page-context-repo.js';
import { SystemAction } from '../protocol/types.js';
import { detectChangedSections, detectDialogs } from '../protocol/mutation-result.js';
import { resyncPageRepeaters } from '../services/repeater-sync.js';
import type { Logger } from '../core/logger.js';

export interface RespondDialogInput {
  pageContextId: string;
  dialogFormId: string;
  response: 'ok' | 'cancel' | 'yes' | 'no' | 'abort' | 'close';
}

export interface RespondDialogOutput {
  success: boolean;
  changedSections: string[];
  dialogsOpened: Array<{ formId: string; message?: string; fields?: import('../protocol/types.js').ControlField[] }>;
  requiresDialogResponse: boolean;
  openedPages: Array<{ pageContextId: string; caption: string }>;
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
  ) {}

  async execute(input: RespondDialogInput): Promise<Result<RespondDialogOutput, ProtocolError>> {
    const ctx = this.repo.get(input.pageContextId);
    if (!ctx) return err(this.repo.notFoundError(input.pageContextId));

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
    });
  }
}
