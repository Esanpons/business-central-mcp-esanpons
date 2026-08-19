import { ok, err, isErr, type Result } from '../core/result.js';
import { ProtocolError } from '../core/errors.js';
import type { BCSession } from '../session/bc-session.js';
import type { PageContextRepository } from '../protocol/page-context-repo.js';
import type { BCEvent, RepeaterRow, ControlField, TabGroup, SaveValueInteraction, SetCurrentRowInteraction, ScrollRepeaterInteraction, InvokeActionInteraction } from '../protocol/types.js';
import { SystemAction } from '../protocol/types.js';
import type { Logger } from '../core/logger.js';
import { resolveSection } from '../protocol/section-resolver.js';
import { fields as treeFields, tabs as treeTabs } from '../protocol/form-views.js';
import { findByControlPath, findFieldByGroupCaption, nearestGroupCaption } from '../protocol/form-tree-walk.js';
import { isFieldNode, type FieldNode, type FormNode, type RepeaterNode } from '../protocol/form-node.js';
import { fieldNodeToControlField } from '../protocol/mcp-adapters.js';
import { mapRowCellKeys, repeaterColumnsToDto } from '../protocol/row-mapping.js';
import { extractValidationMessage } from '../protocol/mutation-result.js';

/**
 * The last `StringValue` BC echoed for a control in this response, or undefined if
 * it echoed none. This is the authoritative post-write value: BC always echoes the
 * validated/formatted result of a SaveValue (see "SaveValue Echo Behavior"), whereas
 * the projected tree can miss it on some page shapes.
 */
function lastEchoedStringValue(events: readonly BCEvent[], controlPath: string): string | undefined {
  let found: string | undefined;
  for (const e of events) {
    if (e.type !== 'PropertyChanged' || e.controlPath !== controlPath) continue;
    const changes = e.changes as Record<string, unknown>;
    const raw = changes['StringValue'] ?? changes['stringValue'];
    if (typeof raw === 'string') found = raw;
  }
  return found;
}

export interface FieldWriteResult {
  fieldName: string;
  controlPath: string;
  /** True when the SaveValue interaction completed without a protocol error. Does NOT mean the value stuck -- check `changed`. */
  success: boolean;
  /** The value the caller asked to write. */
  requested?: string;
  /**
   * True when the field value actually moved after the write (BC may reformat,
   * so the final value can differ from `requested` yet still be a real change).
   * False means the write was a no-op: BC rejected/reverted it, the control was
   * not editable, or the field ALREADY held the requested value (`reason:
   * 'already set'` — not a failure). Undefined means UNVERIFIED: neither BC's
   * echo nor the projection said anything, so nothing is known either way
   * (`reason: 'unverified'`). Header and line-cell writes are judged the same way.
   */
  changed?: boolean;
  /**
   * Why `changed` is not a plain `true`.
   *  - `already set`        the field held this value before the write; nothing to do
   *  - `not editable`       BC published Editable=false and the value did not move
   *  - `validation reverted` BC accepted the interaction and put the old value back
   *  - `unverified`         no echo and no projected value: effect unknown, re-read to confirm
   *  - `control not found`  the field key resolved to nothing
   *  - `validation error`   BC REJECTED the value and said why — see `validationMessage`
   */
  reason?: 'already set' | 'not editable' | 'validation reverted' | 'unverified' | 'control not found' | 'validation error';
  /**
   * BC's own explanation when it refused the value, taken from the
   * `ValidationResults` it echoes on the control (e.g. "Sale must be equal to
   * 'Yes' in Item: No.=0000001"). This is the single most useful thing a caller
   * can be told about a failed write, and it used to be discarded entirely.
   */
  validationMessage?: string;
  newValue?: string;
  error?: string;
  /** On a group-targeting miss: the group captions that DO exist on the page (so the caller can retry). */
  availableGroups?: string[];
  /** On a group-targeting miss: a remediation hint (use a real group, or the exact controlPath). */
  hint?: string;
  events?: BCEvent[];
}

export interface WriteFieldsResult {
  results: FieldWriteResult[];
  events: BCEvent[];
}

export class DataService {
  constructor(
    private readonly session: BCSession,
    private readonly repo: PageContextRepository,
    private readonly logger: Logger,
    private readonly redactValues: boolean = false,
  ) {}

  /** Mask a business value in logs when LOG_REDACT_VALUES is enabled. */
  private redact(value: unknown): string {
    return this.redactValues ? '<redacted>' : String(value);
  }

  /**
   * A row cell as text, matched on the column CAPTION case-insensitively.
   *
   * `FormState.rows` holds the cells exactly as they came off the wire — keyed by
   * the column's binder name (`1165569367_c2`), never by its caption; only
   * `readRows` remaps them for output. So a caption lookup against a raw row
   * matched nothing, and because a miss used to return `''` the caller could not
   * tell "no such column" from "the cell is empty" — every line write was measured
   * as `'' -> ''` and reported `changed:false, reason:"validation reverted"` even
   * when it had plainly worked (bc-saas F-2). Hence: remap through the repeater's
   * columns first, and return undefined when the column is not there at all.
   */
  private cellText(row: RepeaterRow, column: string, repeater?: RepeaterNode): string | undefined {
    const mapped = repeater ? mapRowCellKeys([row], repeaterColumnsToDto(repeater))[0] : row;
    const cells = (mapped ?? row).cells as Record<string, unknown>;
    const key = Object.keys(cells).find(k => k.toLowerCase() === column.toLowerCase());
    if (key === undefined) return undefined;
    const v = cells[key];
    return v === null || v === undefined ? '' : String(v);
  }

  /**
   * Re-read one cell from the CURRENT projection, so a line write can be verified
   * instead of assumed. The bookmark is tried first and the row position second:
   * committing a placeholder line gives it a brand-new bookmark, so bookmark-only
   * lookup would report "unverified" on exactly the writes that did the most.
   */
  private readRowCell(
    pageContextId: string,
    sectionId: string | undefined,
    bookmark: string,
    rowIndex: number | undefined,
    column: string,
  ): string | undefined {
    const ctx = this.repo.get(pageContextId);
    if (!ctx) return undefined;
    const resolved = resolveSection(ctx, sectionId);
    if ('error' in resolved) return undefined;
    const rows = resolved.rows;
    const row = rows.find(r => r.bookmark === bookmark) ?? (rowIndex !== undefined ? rows[rowIndex] : undefined);
    return row ? this.cellText(row, column, resolved.repeater ?? undefined) : undefined;
  }

  readRows(pageContextId: string, sectionId?: string): Result<RepeaterRow[], ProtocolError> {
    const ctx = this.repo.get(pageContextId);
    if (!ctx) return err(this.repo.notFoundError(pageContextId));
    const resolved = resolveSection(ctx, sectionId);
    if ('error' in resolved) return err(new ProtocolError(resolved.error, { availableSections: resolved.availableSections }));
    if (!resolved.repeater) return ok([]);
    return ok(mapRowCellKeys([...resolved.rows], repeaterColumnsToDto(resolved.repeater)));
  }

  getRepeaterTotalRowCount(pageContextId: string, sectionId?: string): number | null {
    const ctx = this.repo.get(pageContextId);
    if (!ctx) return null;
    const resolved = resolveSection(ctx, sectionId);
    if ('error' in resolved) return null;
    return resolved.repeater?.properties.totalRowCount ?? null;
  }

  getTabs(pageContextId: string, sectionId?: string): Result<TabGroup[] | undefined, ProtocolError> {
    const ctx = this.repo.get(pageContextId);
    if (!ctx) return err(this.repo.notFoundError(pageContextId));
    const resolved = resolveSection(ctx, sectionId, 'header');
    if ('error' in resolved) return err(new ProtocolError(resolved.error, { availableSections: resolved.availableSections }));
    const ts = treeTabs(resolved.form.root);
    if (ts.length === 0) return ok(undefined);
    return ok(ts.map(t => ({
      caption: t.caption,
      fields: t.fields.map(f => fieldNodeToControlField(resolved.form.root, f)),
    })));
  }

  /**
   * Scroll a repeater to load additional rows beyond the current viewport.
   * BC uses ContinuousScrolling: delta > 0 loads next rows, delta < 0 loads previous.
   * Returns all rows after scrolling (including newly loaded ones).
   */
  async scrollRepeater(pageContextId: string, delta: number, sectionId?: string): Promise<Result<RepeaterRow[], ProtocolError>> {
    const ctx = this.repo.get(pageContextId);
    if (!ctx) return err(this.repo.notFoundError(pageContextId));
    const resolved = resolveSection(ctx, sectionId);
    if ('error' in resolved) return err(new ProtocolError(resolved.error, { availableSections: resolved.availableSections }));
    if (!resolved.repeater) return ok([]);

    const interaction: ScrollRepeaterInteraction = {
      type: 'ScrollRepeater',
      formId: resolved.form.formId,
      controlPath: resolved.repeater.controlPath,
      delta,
    };

    const result = await this.session.invoke(
      interaction,
      (event) => event.type === 'InvokeCompleted' || event.type === 'DataLoaded',
    );

    if (isErr(result)) return result;
    this.repo.applyToPage(pageContextId, result.value);

    // Return all rows after scroll (newly loaded rows merged by form-state)
    return this.readRows(pageContextId, sectionId);
  }

  readField(pageContextId: string, fieldName: string, sectionId?: string): Result<ControlField | undefined, ProtocolError> {
    const ctx = this.repo.get(pageContextId);
    if (!ctx) return err(this.repo.notFoundError(pageContextId));
    const resolved = resolveSection(ctx, sectionId, 'header');
    if ('error' in resolved) return err(new ProtocolError(resolved.error, { availableSections: resolved.availableSections }));
    const node = this.resolveFieldNode(resolved.form.root, fieldName);
    return ok(node ? fieldNodeToControlField(resolved.form.root, node) : undefined);
  }

  getFields(pageContextId: string, sectionId?: string): Result<ControlField[], ProtocolError> {
    const ctx = this.repo.get(pageContextId);
    if (!ctx) return err(this.repo.notFoundError(pageContextId));
    const resolved = resolveSection(ctx, sectionId, 'header');
    if ('error' in resolved) return err(new ProtocolError(resolved.error, { availableSections: resolved.availableSections }));
    return ok(treeFields(resolved.form.root).map(f => fieldNodeToControlField(resolved.form.root, f)));
  }

  async writeField(
    pageContextId: string,
    fieldName: string,
    value: string,
    options?: { sectionId?: string; bookmark?: string; rowIndex?: number; group?: string; targetCurrentRow?: boolean },
  ): Promise<Result<FieldWriteResult, ProtocolError>> {
    const ctx = this.repo.get(pageContextId);
    if (!ctx) return err(this.repo.notFoundError(pageContextId));
    const resolved = resolveSection(ctx, options?.sectionId, 'header');
    if ('error' in resolved) return err(new ProtocolError(resolved.error, { availableSections: resolved.availableSections }));

    const { form } = resolved;

    // Line cell write: when targeting a specific row in a repeater section
    if (resolved.repeater && (options?.bookmark !== undefined || options?.rowIndex !== undefined || options?.targetCurrentRow)) {
      // Line interactions use the CHILD form's formId (the subpage form).
      // BC sends DataLoaded with root formId but SetCurrentRow/SaveValue use child formId.
      // Verified: SetCurrentRow with root formId -> InvalidBookmarkException;
      //           SetCurrentRow with child formId -> SUCCESS.
      return this.writeLineCell(pageContextId, form.formId, resolved.repeater, [...resolved.rows], fieldName, value, options, resolved.section.sectionId);
    }

    // Header/card field write
    const fieldNode = this.resolveFieldNode(form.root, fieldName, options?.group);
    if (!fieldNode) {
      const ctxInfo: Record<string, unknown> = {
        pageContextId,
        availableFields: treeFields(form.root).map(f => f.properties.caption ?? f.controlPath).filter(Boolean),
      };
      if (options?.group) {
        // The group either does not exist or has no field with this caption.
        // Surface the real group labels (BC may use auto-names like "Control41")
        // and steer the caller to the unambiguous controlPath form.
        ctxInfo.availableGroups = [...new Set(
          treeFields(form.root).map(f => nearestGroupCaption(form.root, f.controlPath)).filter(Boolean),
        )];
        ctxInfo.hint = `No field "${fieldName}" found in group "${options.group}". Use one of availableGroups, or pass the exact controlPath as the field key (from bc_open_page / bc_read_data).`;
      }
      // Is it in an OPEN DIALOG? BC gates plenty of actions behind a dialog with its
      // own fields, and those live in a different form — a different section — so a
      // write aimed at the page could never find them. That produced the least
      // helpful answer this tool can give: "Field not found: server:c[1]/c[2]" for a
      // controlPath the caller had copied from OUR OWN response two calls earlier
      // (bc-saas F-4). Say where it is instead.
      if (!options?.sectionId) {
        const inDialog = this.findFieldInDialogs(ctx, fieldName, options?.group);
        if (inDialog) {
          return err(new ProtocolError(
            `"${fieldName}" is not on the page — it belongs to the dialog currently open over it `
            + `("${inDialog.caption}"). Target it with section: "${inDialog.sectionId}".`,
            {
              ...ctxInfo,
              dialogSection: inDialog.sectionId,
              dialogFormId: inDialog.formId,
              hint: `bc_write_data { pageContextId, section: "${inDialog.sectionId}", fields: { "${fieldName}": ... } }`,
            },
          ));
        }
      }
      const where = options?.group ? `${fieldName} (group "${options.group}")` : fieldName;
      return err(new ProtocolError(`Field not found: ${where}`, ctxInfo));
    }

    // The caption may have resolved to a cell TEMPLATE inside the repeater (the
    // row-cell prototypes are ordinary FieldNodes in the subpage form's tree).
    // SaveValue against a template writes to whatever row BC currently has
    // selected — an arbitrary row, reported as a success. Demand a row.
    if (resolved.repeater && fieldNode.controlPath.startsWith(`${resolved.repeater.controlPath}/`)) {
      return err(new ProtocolError(
        `"${fieldName}" is a line column of section '${resolved.section.sectionId}', not a header field. ` +
        `A line write must name the row: pass bookmark (from bc_read_data) or rowIndex. ` +
        `Without one, BC would write to whichever row happens to be selected.`,
        {
          pageContextId,
          section: resolved.section.sectionId,
          rowCount: resolved.rows.length,
          hint: 'bc_write_data { pageContextId, section, bookmark | rowIndex, fields }',
        },
      ));
    }

    // Snapshot the pre-write value and editability so we can report whether the
    // write actually stuck (P6: bc_write_data must not claim success on no-ops).
    const prevValue = fieldNode.properties.stringValue;
    const editableBefore = fieldNode.properties.editable;

    const interaction: SaveValueInteraction = {
      type: 'SaveValue',
      formId: form.formId,
      controlPath: fieldNode.controlPath,
      newValue: value,
    };

    this.logger.debug('data', `writeField: ${fieldName} = ${this.redact(value)}`, { pageContextId, controlPath: fieldNode.controlPath });

    const result = await this.session.invoke(
      interaction,
      (event) => event.type === 'InvokeCompleted' || event.type === 'PropertyChanged',
    );

    if (isErr(result)) return result;
    const events = result.value;
    this.repo.applyToPage(pageContextId, events);

    // Ground truth is what BC echoed on the wire for THIS control. The projected
    // tree is a second opinion: on some pages (a document opened with mode=Create,
    // and pages whose groups use `Editable = <expression>`) the echo arrives but the
    // projection still reads empty, which made a write that BC had accepted — the
    // order was created, the customer resolved — report `changed:false, reason:
    // "validation reverted"`. Verified live on devel1 (SO20000027 / customer 2000001).
    const echoed = lastEchoedStringValue(events, fieldNode.controlPath);
    const updatedCtx = this.repo.get(pageContextId);
    const updatedForm = updatedCtx?.forms.get(form.formId);
    const updatedNode = updatedForm ? findByControlPath(updatedForm.root, fieldNode.controlPath) : undefined;
    const projected = updatedNode && isFieldNode(updatedNode) ? updatedNode.properties.stringValue : undefined;
    // NOTE: no `?? value` fallback. Defaulting to the REQUESTED value made `changed`
    // true whenever the caller asked for something different from the previous value,
    // with zero evidence from BC that anything happened.
    const observed = echoed ?? projected;

    // P6: did the value actually move? BC may reformat (e.g. customer no -> name),
    // so we compare against the PRE-write value, not against `value`.
    const norm = (s?: string) => (s ?? '').trim();

    // BC's own reason for refusing the value, when it gave one. Checked before the
    // heuristics below because "BC said the item is not for sale" beats any guess
    // this code can make from comparing strings.
    const validationMessage = extractValidationMessage(events, fieldNode.controlPath);

    let changed: boolean | undefined;
    let reason: FieldWriteResult['reason'] | undefined;
    if (validationMessage && norm(observed ?? '') !== norm(value)) {
      // A validation result AND the value did not become what was asked for.
      changed = false;
      reason = 'validation error';
    } else if (norm(value) === norm(prevValue)) {
      // Idempotent write: the field already held this value. Reporting it as
      // "validation reverted" sent agents into retry loops over a state that was
      // already correct.
      changed = false;
      reason = 'already set';
    } else if (observed === undefined) {
      // Neither BC's echo nor the projection confirmed anything: unknown, not "yes".
      changed = undefined;
      reason = 'unverified';
    } else {
      changed = norm(observed) !== norm(prevValue);
      if (!changed) reason = editableBefore === false ? 'not editable' : 'validation reverted';
    }

    const newValue = observed ?? (reason === 'already set' ? prevValue : undefined);

    return ok({
      fieldName,
      controlPath: fieldNode.controlPath,
      success: true,
      requested: value,
      ...(changed !== undefined ? { changed } : {}),
      ...(reason ? { reason } : {}),
      ...(validationMessage ? { validationMessage } : {}),
      ...(newValue !== undefined ? { newValue } : {}),
      events,
    });
  }

  /**
   * Create a NEW row in a repeater section and leave BC's cursor on it, so the
   * caller's field writes land in that row.
   *
   * This is the missing half of line editing. Everything else needed a row that was
   * already there (`bookmark` / `rowIndex`), so a document you had just created --
   * whose lines are empty by definition -- could not be given its first line at all:
   * the write fell through to the header path and answered "Field not found:
   * Cantidad" for a line column, which reads like a BC fault and was reported as one
   * (bc-saas F-39). The list page's own New action is what the web client uses; on a
   * repeater it resolves through the current-row viewport, `{repeater}/cr/c[0]`.
   *
   * An empty repeater has no current row, and BC accepts New anyway: it appends a
   * blank line and selects it. That is exactly the state a first-line write needs.
   */
  async createLine(
    pageContextId: string,
    sectionId?: string,
  ): Promise<Result<{ events: BCEvent[]; rowCountBefore: number; rowCountAfter: number }, ProtocolError>> {
    const ctx = this.repo.get(pageContextId);
    if (!ctx) return err(this.repo.notFoundError(pageContextId));
    const resolved = resolveSection(ctx, sectionId);
    if ('error' in resolved) return err(new ProtocolError(resolved.error, { availableSections: resolved.availableSections }));
    if (!resolved.repeater) {
      return err(new ProtocolError(
        `Section '${resolved.section.sectionId}' has no repeater, so it has no lines to create. `
        + `newLine only applies to a list-shape section: a document's "lines", or a list-bodied subpage.`,
        { availableSections: Array.from(ctx.sections.keys()) },
      ));
    }

    const rowCountBefore = resolved.rows.length;
    const interaction: InvokeActionInteraction = {
      type: 'InvokeAction',
      formId: resolved.form.formId,
      controlPath: `${resolved.repeater.controlPath}/cr/c[0]`,
      systemAction: SystemAction.New,
    };
    this.logger.info(`createLine: New on ${resolved.repeater.controlPath} (section '${resolved.section.sectionId}', formId=${resolved.form.formId})`);
    const result = await this.session.invoke(
      interaction,
      (event) => event.type === 'InvokeCompleted' || event.type === 'DataLoaded' || event.type === 'DialogOpened',
    );
    if (isErr(result)) return result;
    this.repo.applyToPage(pageContextId, result.value);

    const after = this.repo.get(pageContextId);
    const reAfter = after ? resolveSection(after, sectionId) : undefined;
    const rowCountAfter = reAfter && !('error' in reAfter) ? reAfter.rows.length : rowCountBefore;
    return ok({ events: result.value, rowCountBefore, rowCountAfter });
  }

  async writeFields(
    pageContextId: string,
    fields: Record<string, string>,
    options?: { sectionId?: string; bookmark?: string; rowIndex?: number; group?: string; newLine?: boolean; targetCurrentRow?: boolean },
  ): Promise<Result<WriteFieldsResult, ProtocolError>> {
    const results: FieldWriteResult[] = [];
    const allEvents: BCEvent[] = [];
    let effectiveOptions = options;

    // newLine: append a blank row and target it. The row is created ONCE, before any
    // field is written, and every field then goes to that row.
    if (options?.newLine) {
      if (options.bookmark !== undefined || options.rowIndex !== undefined) {
        return err(new ProtocolError(
          'newLine cannot be combined with bookmark or rowIndex: one asks for a NEW row, the others name an existing one. '
          + 'Drop newLine to edit an existing line, or drop bookmark/rowIndex to create one.',
        ));
      }
      const created = await this.createLine(pageContextId, options.sectionId);
      if (isErr(created)) return created;
      allEvents.push(...created.value.events);
      // BC selects the row it just appended, and the new row is the last one. Target
      // it by POSITION, not by bookmark: an uncommitted line carries a placeholder
      // bookmark (`DraftRecord…`) that BC re-keys the moment the line commits.
      const ctxAfter = this.repo.get(pageContextId);
      const re = ctxAfter ? resolveSection(ctxAfter, options.sectionId) : undefined;
      if (!re || 'error' in re || !re.repeater) {
        return err(new ProtocolError('The lines section became unavailable after creating the row; nothing was written.'));
      }
      if (re.rows.length === 0) {
        return err(new ProtocolError(
          'Business Central accepted the New action but the section still reports no rows, so there is no line to write into. '
          + 'Check that the document is editable (its header may need a customer/vendor first) and that the page is not read-only.',
          { section: re.section.sectionId, rowCountBefore: created.value.rowCountBefore },
        ));
      }
      // Write into the row BC ITSELF selected, without naming a position.
      //
      // Do NOT try to work out which row that is. A document's lines repeater comes
      // padded with blank placeholder rows (15 on a fresh BC28 sales order) and the
      // appended line is neither the last nor the first blank one: measured live, it
      // landed at index 14 of 15. BC already has its cursor on the right row after
      // New, and `{repeater}/cr/c[N]` -- the current-row viewport -- means exactly
      // "whatever row is selected", so the write needs no index at all.
      effectiveOptions = { ...options, newLine: false, targetCurrentRow: true };
    }
    // On a NEW line, write the identifying columns before the quantitative ones.
    //
    // BC re-runs the line's validation when Type/No. lands, and that recalculation
    // RESETS quantities: measured live, a line written in caller order came out with
    // the item resolved (description, unit, price) but Quantity back to 0 -- reported
    // as changed:true, because it really did change before BC undid it. Anything not
    // named here keeps the caller's order, which is what a document header needs.
    const NEW_LINE_ORDER = ['tipo', 'type', 'nº', 'n.º', 'no.', 'number', 'código', 'code'];
    const rank = (caption: string): number => {
      const c = caption.trim().toLowerCase();
      const i = NEW_LINE_ORDER.findIndex(k => c === k);
      return i >= 0 ? i : NEW_LINE_ORDER.length;
    };
    const entries = Object.entries(fields);
    const ordered = options?.newLine
      ? entries.map((e, i) => ({ e, i })).sort((a, b) => (rank(a.e[0]) - rank(b.e[0])) || (a.i - b.i)).map(x => x.e)
      : entries;

    for (const [name, value] of ordered) {
      const result = await this.writeField(pageContextId, name, value, effectiveOptions);
      if (isErr(result)) {
        const notFound = /not found/i.test(result.error.message);
        // Preserve the diagnostic context (availableGroups / hint) that
        // writeField attaches on a group-targeting miss -- without this the
        // per-field result would carry only the bare message.
        const errCtx = result.error.context as { availableGroups?: unknown; hint?: unknown } | undefined;
        const availableGroups = Array.isArray(errCtx?.availableGroups)
          ? (errCtx!.availableGroups as string[]) : undefined;
        const hint = typeof errCtx?.hint === 'string' ? errCtx.hint : undefined;
        results.push({
          fieldName: name,
          controlPath: '',
          success: false,
          requested: value,
          changed: false,
          ...(notFound ? { reason: 'control not found' as const } : {}),
          error: result.error.message,
          ...(availableGroups ? { availableGroups } : {}),
          ...(hint ? { hint } : {}),
        });
      } else {
        results.push(result.value);
        if (result.value.events) allEvents.push(...result.value.events);
      }
    }

    // On a new line, re-assert the values BC undid while resolving the item.
    //
    // Writing Type/No. makes BC re-run the line's validation, and that recalculation
    // RESETS the quantitative columns -- measured live on BC28: Quantity was written
    // (BC echoed "2", changed:true) and came back 0 once the item resolved, so the
    // line ended up with the right product and no quantity. Ordering alone cannot fix
    // it: the reset happens after the last write, whatever the order. So: re-read the
    // row, and write again only the fields that do not hold what was asked for. One
    // extra pass, and only for fields that actually drifted.
    if (options?.newLine && results.some(r => r.success)) {
      for (let i = 0; i < results.length; i++) {
        const r = results[i]!;
        if (!r.success || r.requested === undefined) continue;
        const current = this.readCurrentRowCell(pageContextId, options.sectionId, r.fieldName);
        const norm = (v?: string): string => (v ?? '').trim();
        // Only chase a real drift: undefined means we could not read it back (say
        // nothing), and an equal value means BC kept it.
        if (current === undefined || norm(current) === norm(r.requested)) continue;
        // BC reformats legitimately (a code becomes a name, 2 becomes "2,00"), so a
        // numeric comparison decides for numbers before we call it a drift.
        const asNum = (v: string): number => Number(v.replace(/s/g, '').replace(/.(?=d{3})/g, '').replace(',', '.'));
        const a = asNum(current); const b = asNum(r.requested);
        if (Number.isFinite(a) && Number.isFinite(b) && a === b) continue;
        const retry = await this.writeField(pageContextId, r.fieldName, r.requested, effectiveOptions);
        if (isErr(retry)) continue;
        results[i] = { ...retry.value, hint: 'Re-written after Business Central reset it while resolving the line.' };
        if (retry.value.events) allEvents.push(...retry.value.events);
      }
    }

    return ok({ results, events: allEvents });
  }

  /**
   * One cell of the repeater's CURRENT row, by column caption.
   *
   * Used to check whether BC kept what was just written into a line it is still
   * resolving. Reads the row BC has selected -- the only way to address a line that
   * has no stable bookmark yet.
   */
  private readCurrentRowCell(pageContextId: string, sectionId: string | undefined, column: string): string | undefined {
    const ctx = this.repo.get(pageContextId);
    if (!ctx) return undefined;
    const resolved = resolveSection(ctx, sectionId);
    if ('error' in resolved || !resolved.repeater) return undefined;
    // The row carrying data is the one just written; a fresh document's repeater is
    // otherwise all blanks.
    for (const row of resolved.rows) {
      const cells = row.cells as Record<string, unknown>;
      const hasData = Object.values(cells).some(v => v !== null && v !== undefined && v !== '' && v !== 0);
      if (!hasData) continue;
      const v = this.cellText(row, column, resolved.repeater);
      if (v !== undefined) return v;
    }
    return undefined;
  }

  private async writeLineCell(
    pageContextId: string,
    formId: string,
    repeater: RepeaterNode,
    rows: readonly RepeaterRow[],
    fieldName: string,
    value: string,
    options: { bookmark?: string; rowIndex?: number; targetCurrentRow?: boolean },
    sectionId?: string,
  ): Promise<Result<FieldWriteResult, ProtocolError>> {
    let bookmark = options.bookmark;
    let rowIndex = options.rowIndex;
    if (!bookmark && options.rowIndex !== undefined) {
      const row = rows[options.rowIndex];
      if (!row) return err(new ProtocolError(`Row index ${options.rowIndex} out of range. Loaded rows: 0-${rows.length - 1}.`));
      bookmark = row.bookmark;
    }
    if (rowIndex === undefined && bookmark !== undefined) {
      const i = rows.findIndex(r => r.bookmark === bookmark);
      if (i >= 0) rowIndex = i;
    }
    // targetCurrentRow: write into whatever row BC has selected, with no SetCurrentRow.
    // Used right after creating a line -- BC put the cursor on the row it appended, and
    // that row cannot be addressed by position (the repeater is padded with blanks and
    // the new row is not the last) nor by bookmark (an uncommitted line carries a
    // placeholder BC re-keys on commit).
    if (!bookmark && !options.targetCurrentRow) {
      return err(new ProtocolError('No bookmark or rowIndex provided for line cell write'));
    }

    // Snapshot the cell BEFORE the write so the effect can be measured afterwards.
    const beforeRow = rows.find(r => r.bookmark === bookmark) ?? (rowIndex !== undefined ? rows[rowIndex] : undefined);
    const beforeValue = beforeRow ? this.cellText(beforeRow, fieldName, repeater) : undefined;

    // Step 1: select the row -- SKIPPED when writing into BC's current row, which is
    // the case right after creating a line: there is no stable key to select it by,
    // and BC is already positioned on it.
    let selectEvents: BCEvent[] = [];
    if (bookmark !== undefined) {
      const selectInteraction: SetCurrentRowInteraction = {
        type: 'SetCurrentRow', formId, controlPath: repeater.controlPath, key: bookmark,
      };
      const selectResult = await this.session.invoke(
        selectInteraction,
        (event) => event.type === 'InvokeCompleted' || event.type === 'BookmarkChanged',
      );
      if (isErr(selectResult)) return selectResult;
      this.repo.applyToPage(pageContextId, selectResult.value);
      selectEvents = selectResult.value;
    }

    // Step 2: find column by caption
    const col = repeater.columns.find(c => (c.properties.caption ?? '').toLowerCase() === fieldName.toLowerCase());
    if (!col) {
      return err(new ProtocolError(`Column '${fieldName}' not found in repeater.`, {
        availableColumns: repeater.columns.map(c => c.properties.caption ?? '').filter(Boolean),
      }));
    }
    const match = col.controlPath.match(/co\[(\d+)\]/);
    if (!match) return err(new ProtocolError(`Cannot determine column index from ${col.controlPath}`));
    const colIndex = parseInt(match[1]!, 10);
    const cellPath = `${repeater.controlPath}/cr/c[${colIndex}]`;
    const saveInteraction: SaveValueInteraction = {
      type: 'SaveValue', formId, controlPath: cellPath, newValue: value,
    };
    this.logger.info(`writeLineCell: ${fieldName} = ${this.redact(value)} at ${cellPath} (formId=${formId})`);
    const saveResult = await this.session.invoke(
      saveInteraction,
      (event) => event.type === 'InvokeCompleted' || event.type === 'PropertyChanged',
    );
    if (isErr(saveResult)) return saveResult;
    const allEvents = [...selectEvents, ...saveResult.value];
    this.repo.applyToPage(pageContextId, saveResult.value);

    // BC reports a refused value in ValidationResults on the cell, not as an error:
    // the interaction completes normally and the old value stays. Reporting only
    // "success, effect unknown" here hid the ONE thing the caller needs (why), and
    // made a legitimate business-rule rejection look like a broken line-write path.
    const validationMessage = extractValidationMessage(saveResult.value, cellPath);
    if (validationMessage) {
      return ok({
        fieldName, controlPath: cellPath, success: true, requested: value,
        changed: false, reason: 'validation error', validationMessage, events: allEvents,
      });
    }

    // Verify the effect against what BC actually said, instead of reporting the
    // requested value back. `changed: undefined` was not a small gap: it made a
    // SUCCESSFUL line write indistinguishable from a silently ignored one, so no
    // caller (our own live battery included) could ever tell whether a line had
    // been filled in.
    //
    // GROUND TRUTH IS THE WIRE ECHO on the cell, exactly as in the header path —
    // and for the same reason, only more so here. A repeater's row projection is
    // rebuilt from DataLoaded batches, which BC sends AFTER the SaveValue response
    // this invoke waits for, so re-reading the row alone reports an empty cell for
    // a write BC has already confirmed (`changed:false, reason:"validation
    // reverted", newValue:""` on writes that had plainly worked — bc-saas F-2).
    // The echo arrives on the current-row viewport path we just wrote to, which is
    // the row selected in step 1, so it describes exactly this row.
    //
    // The projection is the fallback. The bookmark is NOT stable across the write:
    // committing a line turns a `DraftRecord*` placeholder into a real record with a
    // new bookmark (`DraftRecord6250` -> `23_JQAAAACLA...`), so a bookmark lookup can
    // miss the row entirely. When neither source says anything we say "unverified"
    // instead of guessing.
    const echoed = lastEchoedStringValue(saveResult.value, cellPath);
    const projected = bookmark !== undefined
      ? this.readRowCell(pageContextId, sectionId, bookmark, undefined, fieldName)
      : undefined;
    const observed = echoed ?? projected;
    const norm = (s?: string) => (s ?? '').trim();
    if (norm(value) === norm(beforeValue) && beforeValue !== undefined) {
      // Idempotent write: the cell already held this value. Calling that "reverted"
      // sent callers into retry loops over a state that was already correct.
      return ok({
        fieldName, controlPath: cellPath, success: true, requested: value,
        changed: false, reason: 'already set', newValue: observed ?? beforeValue, events: allEvents,
      });
    }
    if (observed === undefined) {
      return ok({
        fieldName, controlPath: cellPath, success: true, requested: value,
        reason: 'unverified', events: allEvents,
        hint: 'BC echoed nothing for the cell and re-keyed or moved the row (writing into a blank placeholder line commits it), so the effect could not be confirmed in place. Re-read the section to see the row as it now stands.',
      });
    }
    // BC may reformat what it stored (a code resolves to a description, a number is
    // localized), so "did it move" is measured against the PRE-write cell, exactly
    // like the header path — not against the requested string.
    const changed = norm(observed) !== norm(beforeValue);
    // A "reverted" verdict reached WITHOUT an echo rests on the row projection alone.
    // That is usually right (verified live on devel1: a Sales Order line and a setup
    // list both refused the write and the re-read confirmed the old value), but the
    // caller deserves to know which evidence the verdict came from, since the one
    // thing this report must never do again is assert a revert it did not observe.
    const projectionOnly = !changed && echoed === undefined;
    return ok({
      fieldName, controlPath: cellPath, success: true, requested: value,
      changed,
      ...(changed ? {} : { reason: 'validation reverted' as const }),
      ...(projectionOnly ? {
        hint: 'BC echoed nothing for this cell; the verdict comes from re-reading the row, which still holds '
          + 'the old value. If the list is not in edit mode BC silently ignores line writes — check that the '
          + 'page/section is editable, then re-read to confirm.',
      } : {}),
      newValue: observed,
      events: allEvents,
    });
  }

  /** The open dialog section holding `fieldName`, when the page itself does not. */
  private findFieldInDialogs(
    ctx: { sections: ReadonlyMap<string, { sectionId: string; kind: string; caption: string; formId: string; valid: boolean }>; forms: ReadonlyMap<string, { root: FormNode }> },
    fieldName: string,
    group?: string,
  ): { sectionId: string; caption: string; formId: string } | undefined {
    for (const section of ctx.sections.values()) {
      if (section.kind !== 'dialog' || !section.valid) continue;
      const form = ctx.forms.get(section.formId);
      if (!form) continue;
      if (this.resolveFieldNode(form.root, fieldName, group)) {
        return { sectionId: section.sectionId, caption: section.caption, formId: section.formId };
      }
    }
    return undefined;
  }

  /**
   * Resolve a field by (in priority order): exact controlPath, group+caption,
   * or caption alone. `group` disambiguates duplicate captions (Sell-to /
   * Bill-to / Ship-to on document headers). Returns undefined when no match.
   */
  private resolveFieldNode(root: FormNode, fieldName: string, group?: string): FieldNode | undefined {
    // 1. Exact controlPath wins -- unambiguous, no group needed.
    const byPath = treeFields(root).find(f => f.controlPath === fieldName);
    if (byPath) return byPath;

    // 2. group + caption: pick the field inside the named group. IMPORTANT: when
    //    a group is given we do NOT fall back to a caption-only match — that
    //    would silently target a field in the WRONG group (e.g. writing the
    //    Bill-to value into Sell-to). A miss returns undefined so the caller
    //    gets an explicit "not found in group" error instead of a wrong write.
    if (group) {
      const node = findFieldByGroupCaption(root, group, fieldName);
      return node && isFieldNode(node) ? node : undefined;
    }

    // 3. caption alone (no group requested; first match wins).
    const lower = fieldName.toLowerCase();
    for (const f of treeFields(root)) {
      if ((f.properties.caption ?? '').toLowerCase() === lower) return f;
    }
    return undefined;
  }
}

