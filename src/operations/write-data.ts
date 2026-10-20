import { isOk, ok, type Result } from '../core/result.js';
import type { ProtocolError } from '../core/errors.js';
import type { DataService, FieldWriteResult } from '../services/data-service.js';
import type { PageContextRepository } from '../protocol/page-context-repo.js';
import type { BCEvent } from '../protocol/types.js';
import { detectChangedSections, detectDialogs, detectMessages, withDialogSections, type DialogInfo, type MessageInfo } from '../protocol/mutation-result.js';

export interface WriteDataInput {
  pageContextId: string;
  /** Values may arrive as string | number | boolean; coerced to text before writing. */
  fields: Record<string, string | number | boolean>;
  section?: string;
  rowIndex?: number;
  bookmark?: string;
  /**
   * Disambiguates duplicate captions on document headers (e.g. the three `Name`
   * controls in Sell-to / Bill-to / Ship-to groups). When set, each field key is
   * resolved inside the group with this caption. Ignored for keys that are an
   * exact controlPath (those are already unambiguous).
   */
  group?: string;
  /**
   * Create a NEW line in the section and write these fields into it. This is how a
   * freshly created document gets its FIRST line: its repeater is empty, so there is
   * no bookmark or rowIndex to name, and without this the write fell through to the
   * header path and reported "Field not found" for a line column (bc-saas F-39).
   */
  newLine?: boolean;
  /**
   * Trim each per-field result to the verdict: fieldName, changed, newValue, reason
   * and BC's validationMessage (plus error/hint/availableGroups on a field that
   * failed). Same intent as bc_execute_action's `quiet`.
   */
  quiet?: boolean;
  /**
   * Return BC's raw protocol events as a top-level `events` array. Off by default:
   * they are the evidence the verdict is computed FROM, not something a caller needs,
   * and one write used to drag every PropertyChanged of the form along — 30 KB for a
   * customer number, 59 KB for a new line (bc-saas F-42). Ask for them only to debug
   * the protocol.
   */
  includeEvents?: boolean;
}

export interface WriteDataOutput {
  results: FieldWriteResult[];
  allSucceeded: boolean;
  changedSections: string[];
  dialogsOpened: DialogInfo[];
  requiresDialogResponse: boolean;
  /** What BC told the user while validating the values (an AL `Message()`). Absent when BC said nothing. */
  messages?: MessageInfo[];
  /** Raw BC events, ONLY when `includeEvents: true` was asked for. */
  events?: BCEvent[];
  /**
   * newLine: the REAL bookmark of the line just created, read back from the server
   * after committing it. Use it for any further write to that line — never the
   * `DraftRecord…` placeholder, which BC re-keys on commit (bc-saas F-70).
   */
  newLineBookmark?: string;
  /** newLine: false when the re-read grid holds no new line, i.e. nothing was saved (bc-saas F-64 b). */
  newLineCreated?: boolean;
  /** Why the result is not what the per-field verdicts suggest. */
  note?: string;
}

/**
 * Per-field results without the raw events each write carries internally. Those
 * events are how DataService works out `changed`/`reason`; handed to the caller they
 * were pure bulk (bc-saas F-42).
 */
export function stripFieldEvents(results: readonly FieldWriteResult[]): FieldWriteResult[] {
  return results.map(r => {
    if (r.events === undefined) return r;
    const { events: _events, ...rest } = r;
    return rest;
  });
}

/** The verdict of one field write, nothing else (`quiet: true`). */
function quietResult(r: FieldWriteResult): FieldWriteResult {
  const failed = !r.success || (r.changed === false && r.reason !== 'already set');
  return {
    fieldName: r.fieldName,
    controlPath: r.controlPath,
    success: r.success,
    ...(r.changed !== undefined ? { changed: r.changed } : {}),
    ...(r.newValue !== undefined ? { newValue: r.newValue } : {}),
    ...(r.reason ? { reason: r.reason } : {}),
    ...(r.validationMessage ? { validationMessage: r.validationMessage } : {}),
    ...(r.error ? { error: r.error } : {}),
    // On a failure, the remediation still matters more than brevity.
    ...(failed && r.hint ? { hint: r.hint } : {}),
    ...(failed && r.availableGroups ? { availableGroups: r.availableGroups } : {}),
  };
}

export class WriteDataOperation {
  constructor(
    private readonly dataService: DataService,
    private readonly repo: PageContextRepository,
  ) {}

  async execute(input: WriteDataInput): Promise<Result<WriteDataOutput, ProtocolError>> {
    // Coerce number/boolean values to their string form; BC SaveValue is text-based.
    const fields: Record<string, string> = {};
    for (const [k, v] of Object.entries(input.fields)) {
      fields[k] = typeof v === 'string' ? v : String(v);
    }
    const result = await this.dataService.writeFields(input.pageContextId, fields, {
      sectionId: input.section,
      rowIndex: input.rowIndex,
      bookmark: input.bookmark,
      group: input.group,
      newLine: input.newLine,
    });
    if (!isOk(result)) return result;

    const { events, newLineBookmark, newLineCreated } = result.value;
    const results = stripFieldEvents(result.value.results);
    const ctx = this.repo.get(input.pageContextId);
    const changedSections = ctx ? detectChangedSections(ctx, events) : [];
    const dialogsOpened = withDialogSections(ctx, detectDialogs(events));
    const messages = detectMessages(events);
    // A newLine whose re-read grid has no new line saved nothing, whatever the
    // per-field verdicts said ("unverified" passes as success) — bc-saas F-64 b.
    const lineMissing = newLineCreated === false;

    return ok({
      results: input.quiet ? results.map(quietResult) : results,
      // A write only "succeeds" if the interaction completed AND the field ended up
      // holding what was asked. `changed === false` is a no-op (rejected/reverted/not
      // editable) and must not be reported as success (P6) — EXCEPT for
      // `reason: 'already set'`, where the field already held the requested value:
      // nothing moved because nothing needed to. `changed` undefined is
      // success-by-interaction (line cells, and writes BC did not echo).
      allSucceeded: !lineMissing && results.every(r => r.success && (r.changed !== false || r.reason === 'already set')),
      changedSections,
      dialogsOpened,
      requiresDialogResponse: dialogsOpened.length > 0,
      ...(messages.length > 0 ? { messages } : {}),
      ...(newLineBookmark ? { newLineBookmark } : {}),
      ...(newLineCreated !== undefined ? { newLineCreated } : {}),
      ...(lineMissing ? {
        note: 'No line was saved: after the write the grid, re-read from the server, holds no new line. '
          + 'A list that is not in edit mode ignores line writes without an error — open the page with mode "Edit" '
          + '(or use its "Edit List" action and write to the context that action returns) and try again.',
      } : {}),
      ...(input.includeEvents ? { events } : {}),
    });
  }
}
