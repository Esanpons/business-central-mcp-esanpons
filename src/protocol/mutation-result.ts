// src/protocol/mutation-result.ts
import type { BCEvent, DialogOpenedEvent, ControlField, MessageToShowEvent } from './types.js';
import type { PageContext } from './page-context.js';
import { buildFormTree } from './form-tree-builder.js';
import { fields as treeFields } from './form-views.js';
import { fieldNodeToControlField } from './mcp-adapters.js';

/**
 * What kind of modal BC put up. Read from the dialog's own control tree, never from
 * its (localised) caption.
 *
 * Measured live on devel1 (BC27, 2026-10-03), every one of them a `DialogToShow`:
 *  - `error`     `t: 'lmd'`, `MappingHint: 'ErrorDialog'`, `DialogType: 3`, `ExceptionType: 1`
 *                (an AL `Error()` after an action: "No hay Customer dentro del filtro...")
 *  - `confirm`   `t: 'lmd'`, `MappingHint: 'ConfirmDialog'`, `DialogType: 5`, `ExceptionType: 0`
 *                (an AL `Confirm()`, and BC's own "¿Desea descartar estos cambios?")
 *  - `selection` `t: 'lf'`, `MappingHint: 'SelectionMenuDialog'` (an AL `StrMenu`, or the
 *                "Elegir" picker a lookup field opens)
 *  - `page`      `t: 'lf'` with no message hint: a page run modally (RunModal, a request
 *                page, a modal list such as "Edit Dimension Set Entries")
 *  - `message`   any other `t: 'lmd'`
 */
export type DialogKind = 'error' | 'confirm' | 'message' | 'selection' | 'page';

export function classifyDialog(controlTree: unknown): DialogKind {
  const raw = (controlTree && typeof controlTree === 'object') ? controlTree as Record<string, unknown> : {};
  const hint = typeof raw.MappingHint === 'string' ? raw.MappingHint : '';
  if (raw.t === 'lmd') {
    if (hint === 'ErrorDialog' || raw.DialogType === 3 || (typeof raw.ExceptionType === 'number' && raw.ExceptionType !== 0)) return 'error';
    if (hint === 'ConfirmDialog' || raw.DialogType === 5) return 'confirm';
    return 'message';
  }
  if (hint === 'SelectionMenuDialog') return 'selection';
  return 'page';
}

/** One modal BC opened, as reported to the MCP caller. */
export interface DialogInfo {
  formId: string;
  /**
   * The text the user would read. For a message box (error / confirm / message) that
   * is BC's `Message` — the question, or the error itself. It used to be the CAPTION,
   * which for those boxes is only the title "Error" / "Confirmar": the one thing that
   * said WHY an action failed never reached the caller (bc-saas F-44).
   */
  message?: string;
  /** The dialog's title ("Confirmar", "Error", a page caption) when it differs from `message`. */
  caption?: string;
  kind: DialogKind;
  fields?: ControlField[];
  /**
   * The sectionIds to read/write this dialog through: `dialog` (its own fields, or its
   * own grid) plus one per subform it hosts (`dialog:Lines`). Absent when the dialog is
   * not tracked as a section (a message box answered in the same call).
   */
  sections?: string[];
}

/** Attach to each dialog the sectionIds it can be read through (see DialogInfo.sections). */
export function withDialogSections(ctx: PageContext | undefined, dialogs: DialogInfo[]): DialogInfo[] {
  if (!ctx) return dialogs;
  return dialogs.map(d => {
    const ids = [...ctx.sections.values()]
      .filter(s => s.valid && ((s.kind === 'dialog' && s.formId === d.formId) || s.ownerDialogFormId === d.formId))
      .map(s => s.sectionId);
    return ids.length > 0 ? { ...d, sections: ids } : d;
  });
}

/**
 * A non-modal message BC raised: an AL `Message()` after an action. Verified live on
 * devel1: "Document 2001777 has been archived." arrives as a `MessageToShow` event in
 * the response to the confirm that preceded it — NOT as a dialog, and with nothing to
 * answer. The decoder always produced these; nothing ever handed them to the caller,
 * so "El DeCA ... queda publicado." and every other result message of an action was
 * silently lost (bc-saas F-44).
 */
export interface MessageInfo {
  text: string;
  type: MessageToShowEvent['messageType'];
}

/**
 * A file BC produced and handed to the client (a rendered report). It is the only
 * evidence over the WebSocket that a report actually RAN: BC answers "Imprimir" on a
 * request page with a `UriToShow` for `DynamicFileHandler.axd?...&fname=<file>`
 * (measured live on devel1, 2026-10-04). The URI is relative to the BC web client
 * and bound to this session; to keep a copy use bc_download_report.
 */
export interface FileInfo {
  /** `fname` from the URI, decoded ("Sales Invoice.pdf"). Absent when BC sent none. */
  fileName?: string;
  uri: string;
}

export function detectFiles(events: readonly BCEvent[]): FileInfo[] {
  const out: FileInfo[] = [];
  for (const e of events) {
    if (e.type !== 'UriToShow') continue;
    if (out.some(f => f.uri === e.uri)) continue;
    let fileName: string | undefined;
    const q = e.uri.indexOf('?');
    if (q >= 0) {
      try {
        fileName = new URLSearchParams(e.uri.slice(q + 1)).get('fname') ?? undefined;
      } catch { /* not a query string: no name */ }
    }
    out.push({ ...(fileName ? { fileName } : {}), uri: e.uri });
  }
  return out;
}

export function detectMessages(events: readonly BCEvent[]): MessageInfo[] {
  const out: MessageInfo[] = [];
  for (const e of events) {
    if (e.type !== 'MessageToShow') continue;
    const text = e.text.trim();
    if (!text) continue;
    // A batch merged from two invokes can carry the same message twice.
    if (out.some(m => m.text === text && m.type === e.messageType)) continue;
    out.push({ text, type: e.messageType });
  }
  return out;
}

/**
 * Shared envelope returned by all mutating operations (write-data, execute-action,
 * navigate, close-page). Surfaces which sections changed, whether dialogs opened,
 * and whether the caller must respond to a dialog before continuing.
 */
export interface MutationResult<T = void> {
  readonly success: boolean;
  readonly value?: T;
  readonly changedSections: string[];
  readonly openedPages: Array<{ pageContextId: string; caption: string }>;
  readonly dialogsOpened: DialogInfo[];
  readonly requiresDialogResponse: boolean;
}

/**
 * After a mutating invoke, check which sections received events by matching
 * event formIds to the section map. If the root formId was touched, all
 * sections are considered changed (root events cascade via cross-form routing).
 *
 * Only VALID sections are reported. A FactBox that came back empty when the page
 * opened stays in the map marked invalid, and bc_read_data refuses it with "Section
 * ... not found" — so naming it here sent callers after a section they could not
 * read (bc-saas F-43: `factbox:Datos pendientes`). Every id returned here is one
 * bc_read_data accepts.
 */
export function detectChangedSections(
  ctx: PageContext,
  events: readonly BCEvent[],
): string[] {
  const changedFormIds = new Set<string>();
  for (const event of events) {
    const formId = 'formId' in event ? (event as { formId: string }).formId : undefined;
    if (formId) changedFormIds.add(formId);
  }

  const changedSections: string[] = [];
  for (const [sectionId, section] of ctx.sections) {
    if (!section.valid) continue;
    if (changedFormIds.has(section.formId)) {
      changedSections.push(sectionId);
    }
  }

  // Root form events may cascade to lines via cross-form routing
  if (changedFormIds.has(ctx.rootFormId)) {
    for (const [sectionId, section] of ctx.sections) {
      if (!section.valid) continue;
      if (!changedSections.includes(sectionId)) {
        changedSections.push(sectionId);
      }
    }
  }

  return changedSections;
}

/**
 * BC's reason for refusing a value, taken from the `ValidationResults` array it
 * echoes on the control in a `PropertyChanged`.
 *
 * This is the difference between "the write did not stick" and "the write did not
 * stick BECAUSE item 0000001 is not a sales item". BC always sends the second; we
 * used to keep only the first, which made a perfectly explicable rejection look
 * like an unexplained no-op. Verified live on devel1 (Sales Order line, `No.`):
 * `PropertyChanged { ValidationResults: [{ Id: 18, Description: "Sale debe ser
 * igual a 'Sí' en Item: No.=0000001..." }] }`.
 *
 * @param controlPath When given, only that control's results are considered; the
 *   same batch also carries validation state for unrelated cells.
 */
export function extractValidationMessage(events: readonly BCEvent[], controlPath?: string): string | undefined {
  const messages: string[] = [];
  for (const e of events) {
    if (e.type !== 'PropertyChanged') continue;
    if (controlPath !== undefined && e.controlPath !== controlPath) continue;
    const results = (e.changes as Record<string, unknown> | undefined)?.ValidationResults;
    if (!Array.isArray(results)) continue;
    for (const r of results) {
      const desc = (r as Record<string, unknown> | undefined)?.Description;
      if (typeof desc === 'string' && desc.trim() !== '') messages.push(desc.trim());
    }
  }
  return messages.length > 0 ? [...new Set(messages)].join(' ') : undefined;
}

/** An error BC attached to a page or control instead of raising an error dialog. */
export interface ValidationErrorInfo {
  message: string;
  severity: string;
  formId: string;
  controlPath: string;
}

/**
 * Every Error-severity `ValidationResults` entry in `events`, on ANY form/control.
 *
 * BC reports a failed trigger this way, not with an error dialog. Measured live on
 * devel1 (BC27, 2026-10-04): confirming "¿Eliminar NCV-000396?" on a Posted Sales
 * Shipment whose deletion is not allowed comes back as
 *   PropertyChanged { formId: <the record's card form>, controlPath: "server:",
 *     changes: { ValidationResults: [{ Description: "The date Allow Document Deletion
 *     Before must be set on the page Sales & Receivables Setup before deleting sales
 *     documents.", Severity: "Error", ... }] } }
 * followed by the "La página contiene cambios no guardados..." confirm. Only field
 * writes ever read ValidationResults, so the one sentence that explained the failure
 * never reached the caller and the delete looked like it had worked (bc-saas F-56).
 * An entry with an empty Description, or a non-Error severity, is not a failure.
 */
export function detectValidationErrors(events: readonly BCEvent[]): ValidationErrorInfo[] {
  const out: ValidationErrorInfo[] = [];
  for (const e of events) {
    if (e.type !== 'PropertyChanged') continue;
    const results = (e.changes as Record<string, unknown> | undefined)?.ValidationResults;
    if (!Array.isArray(results)) continue;
    for (const r of results) {
      const rec = (r ?? {}) as Record<string, unknown>;
      const message = typeof rec.Description === 'string' ? rec.Description.trim() : '';
      const severity = typeof rec.Severity === 'string' ? rec.Severity : '';
      if (!message || severity.toLowerCase() !== 'error') continue;
      if (out.some(x => x.message === message)) continue;
      out.push({ message, severity, formId: e.formId, controlPath: e.controlPath });
    }
  }
  return out;
}

/**
 * Extract dialog information from events: what kind of modal it is, the text the
 * user would read, and — for a page run modally — its fields.
 */
export function detectDialogs(events: readonly BCEvent[]): DialogInfo[] {
  const seen = new Set<string>();
  return events
    .filter((e): e is DialogOpenedEvent => e.type === 'DialogOpened')
    // One formId, one entry: a batch merged from two invokes can carry the same
    // DialogOpened twice.
    .filter(e => (seen.has(e.formId) ? false : (seen.add(e.formId), true)))
    .map(e => {
      const raw = e.controlTree as Record<string, unknown> | undefined;
      // Caption/Message are wire values — only use them when they really are
      // non-empty strings (a cast would let an object/number through as `message`
      // and surface "[object Object]" to the caller).
      const asText = (v: unknown): string | undefined =>
        (typeof v === 'string' && v.trim() !== '') ? v : undefined;
      const kind = classifyDialog(raw);
      const isMessageBox = kind === 'error' || kind === 'confirm' || kind === 'message';
      const caption = asText(raw?.Caption);
      // A message box carries its text in `Message`; its caption is only the title.
      // Anything else (a page run modally) has no Message and is described by its caption.
      const message = isMessageBox
        ? (asText(raw?.Message) ?? caption)
        : (caption ?? asText(raw?.Message));

      // Build the dialog's FormNode tree to extract structured fields.
      // Dialog controlTree nodes may arrive as a bare object (no `t` field) or
      // as a proper `lf` LogicalForm node. Normalise to `lf` when absent so
      // buildFormTree can process children in either case. A message box has no
      // input: its only "field" is the static text that is already `message`.
      let fields: ControlField[] | undefined;
      if (!isMessageBox && raw && typeof raw.Children !== 'undefined') {
        const lfNode = raw.t === 'lf' ? raw : { ...raw, t: 'lf' };
        try {
          const root = buildFormTree(lfNode);
          const nodeFields = treeFields(root);
          if (nodeFields.length > 0) {
            fields = nodeFields.map(f => fieldNodeToControlField(root, f));
          }
        } catch {
          // Non-fatal: dialog field extraction failure should not abort the operation
        }
      }

      return {
        formId: e.formId,
        ...(message !== undefined ? { message } : {}),
        ...(caption !== undefined && caption !== message ? { caption } : {}),
        kind,
        ...(fields ? { fields } : {}),
      };
    });
}
