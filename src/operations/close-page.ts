import { mapResult, type Result } from '../core/result.js';
import type { ProtocolError } from '../core/errors.js';
import type { PageService } from '../services/page-service.js';
import { detectDialogs } from '../protocol/mutation-result.js';

export interface ClosePageInput {
  pageContextId: string;
  /** Auto-discard unsaved changes (answer any "save changes?" dialog with No) so the close completes. */
  discardChanges?: boolean;
}

export interface ClosePageOutput {
  success: boolean;
  dialogsOpened: Array<{ formId: string; message?: string; fields?: import('../protocol/types.js').ControlField[] }>;
  requiresDialogResponse: boolean;
  /** Still-valid pageContextId to use with bc_respond_dialog when a save-changes dialog is pending. */
  pageContextId?: string;
  hint?: string;
}

export class ClosePageOperation {
  constructor(private readonly pageService: PageService) {}

  async execute(input: ClosePageInput): Promise<Result<ClosePageOutput, ProtocolError>> {
    const result = await this.pageService.closePage(input.pageContextId, { discardChanges: input.discardChanges });
    return mapResult(result, (r) => {
      const dialogsOpened = detectDialogs(r.events);
      const requiresDialogResponse = dialogsOpened.length > 0;
      return {
        success: true,
        dialogsOpened,
        requiresDialogResponse,
        // When a save-changes dialog is pending, the page context is deliberately
        // kept alive so it can be answered — surface it plus a remediation hint.
        ...(requiresDialogResponse ? {
          pageContextId: input.pageContextId,
          hint: `Unsaved changes: answer the dialog with bc_respond_dialog { pageContextId: "${input.pageContextId}", dialogFormId: "${dialogsOpened[0]!.formId}", response: "no" | "yes" }, or re-call bc_close_page with discardChanges: true to discard.`,
        } : {}),
      };
    });
  }
}
