export abstract class BCError extends Error {
  public readonly code: string;
  public readonly timestamp: Date;
  public readonly context?: Record<string, unknown>;
  protected constructor(message: string, code: string, context?: Record<string, unknown>) {
    super(message);
    this.name = this.constructor.name;
    this.code = code;
    this.timestamp = new Date();
    this.context = context;
    Object.setPrototypeOf(this, new.target.prototype);
  }
  public toJSON(): Record<string, unknown> {
    return { name: this.name, code: this.code, message: this.message, timestamp: this.timestamp.toISOString(), context: this.context };
  }
}
export class ConnectionError extends BCError {
  constructor(message: string, context?: Record<string, unknown>) { super(message, 'CONNECTION_ERROR', context); }
}
export class AuthenticationError extends BCError {
  constructor(message: string, context?: Record<string, unknown>) { super(message, 'AUTHENTICATION_ERROR', context); }
}
export class TimeoutError extends BCError {
  constructor(message: string, context?: Record<string, unknown>) { super(message, 'TIMEOUT_ERROR', context); }
}
export class AbortedError extends BCError {
  constructor(message: string, context?: Record<string, unknown>) { super(message, 'ABORTED_ERROR', context); }
}
export class ProtocolError extends BCError {
  constructor(message: string, context?: Record<string, unknown>, code: string = 'PROTOCOL_ERROR') { super(message, code, context); }
}
export class SessionLostError extends BCError {
  public readonly impactedPageContextIds: string[];
  public readonly reconnectFailed: boolean;
  constructor(message: string, impactedPageContextIds: string[], options?: { reconnectFailed?: boolean; context?: Record<string, unknown> }) {
    super(message, 'SESSION_LOST', options?.context);
    this.impactedPageContextIds = impactedPageContextIds;
    this.reconnectFailed = options?.reconnectFailed ?? false;
  }
}
/**
 * Thrown when bc-mcp detected a `LogicalModalityViolationException` and the
 * automatic modal-stack reconciliation could not clear it (Abort failed, or
 * the violation persisted after retry). The session is killed and recreated
 * by the SessionManager -- page contexts are invalidated, callers must re-open
 * any pages.
 */
export class ModalReconcileError extends ProtocolError {
  constructor(message: string, context?: Record<string, unknown>) {
    super(message, context, 'MODAL_RECONCILE_ERROR');
  }
}
export class ValidationError extends BCError {
  constructor(message: string, context?: Record<string, unknown>) { super(message, 'VALIDATION_ERROR', context); }
}
export class InputValidationError extends BCError {
  public readonly fieldErrors: Array<{ path: string; message: string }>;
  constructor(fieldErrors: Array<{ path: string; message: string }>) {
    super(`Input validation failed: ${fieldErrors.map(e => `${e.path}: ${e.message}`).join(', ')}`, 'INPUT_VALIDATION_ERROR');
    this.fieldErrors = fieldErrors;
  }
}
/**
 * Returned by bc_open_page when the requested page is a CardPart that BC
 * delivers as a server stub when opened standalone. Detection: pageType is
 * `CardPart` AND the root form has zero captioned fields AND zero cuegroup
 * tiles (cue-only CardParts like Activities are NOT stubs and pass through).
 * The caller should reach the part through its host form (a Role Center or
 * another page that embeds it).
 *
 * Verified-non-reproducing on stock BC28 (pages 1310, 9061, 9152 all return
 * full content). Reproduces on some vertical-app environments (Continia/CDO);
 * see docs/tools/bc_open_page.md.
 */
export class CardPartStubError extends ProtocolError {
  constructor(message: string, context: { pageId: string; hostHint: string }) {
    super(message, context, 'CARDPART_STUB');
  }
}
/**
 * Returned by bc_open_page when the requested page could not be materialized
 * into a usable page: BC returned an `Unknown` pageType, no sections, or opened
 * a dialog instead of a standalone form (N1). The `reason` in context tells the
 * caller why so they stop guessing. Common cause: the id is not a directly
 * openable standalone page (e.g. a list-part / sub-object), or opening it
 * triggered a modal dialog that must be handled with bc_respond_dialog.
 */
export class PageNotMaterializedError extends ProtocolError {
  constructor(message: string, context: { pageId: string; pageType: string; caption: string; isModal: boolean; reason: string }) {
    super(message, context, 'PAGE_NOT_MATERIALIZED');
  }
}
