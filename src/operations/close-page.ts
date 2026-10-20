import { mapResult, type Result } from '../core/result.js';
import type { ProtocolError } from '../core/errors.js';
import type { PageService } from '../services/page-service.js';
import { detectDialogs, detectMessages, type DialogInfo, type MessageInfo } from '../protocol/mutation-result.js';

export interface ClosePageInput {
  pageContextId: string;
  /** Discard unsaved changes (answer BC's "discard these changes?" with Yes) so the close completes. */
  discardChanges?: boolean;
}

export interface ClosePageOutput {
  /**
   * Whether the page is actually CLOSED. False when a dialog intercepted the close:
   * the interaction completed, but the page is still open and the context is still
   * alive waiting for an answer. Reporting `true` there told callers the resource
   * was freed when it was not.
   */
  success: boolean;
  /** Dialogs still OPEN after the close (never one this call already answered). */
  dialogsOpened: DialogInfo[];
  requiresDialogResponse: boolean;
  /** What BC told the user while the page closed. Absent when BC said nothing. */
  messages?: MessageInfo[];
  /** Still-valid pageContextId to use with bc_respond_dialog when a dialog is pending. */
  pageContextId?: string;
  hint?: string;
}

export class ClosePageOperation {
  constructor(private readonly pageService: PageService) {}

  async execute(input: ClosePageInput): Promise<Result<ClosePageOutput, ProtocolError>> {
    const result = await this.pageService.closePage(input.pageContextId, { discardChanges: input.discardChanges });
    return mapResult(result, (r) => {
      // Only the dialogs that are STILL open. One closePage answered itself
      // (discardChanges) is gone, and so is the page context: reporting it made the
      // close look failed and sent callers to answer it on a context that no longer
      // existed ("Page context not found", bc-saas F-47 b).
      const dialogsOpened = detectDialogs(r.pendingDialogs);
      const requiresDialogResponse = dialogsOpened.length > 0;
      const messages = detectMessages(r.events);
      const first = dialogsOpened[0];
      return {
        success: !requiresDialogResponse,
        dialogsOpened,
        requiresDialogResponse,
        ...(messages.length > 0 ? { messages } : {}),
        // When a dialog is pending, the page context is deliberately kept alive so it
        // can be answered — surface it plus a remediation hint.
        ...(first ? {
          pageContextId: input.pageContextId,
          hint: first.kind === 'confirm'
            ? `BC asks before closing: answer with bc_respond_dialog { pageContextId: "${input.pageContextId}", dialogFormId: "${first.formId}", response: "yes" | "no" } `
              + '("yes" to "discard these changes?" discards them and closes; "no" keeps the page open with its changes), '
              + 'or re-call bc_close_page with discardChanges: true to discard.'
            : `A dialog is open over the page: answer it with bc_respond_dialog { pageContextId: "${input.pageContextId}", dialogFormId: "${first.formId}", response } and close again.`,
        } : {}),
      };
    });
  }
}
