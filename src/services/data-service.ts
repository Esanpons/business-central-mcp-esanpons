import { ok, err, isErr, type Result } from '../core/result.js';
import { ProtocolError } from '../core/errors.js';
import type { BCSession } from '../session/bc-session.js';
import type { PageContextRepository } from '../protocol/page-context-repo.js';
import type { BCEvent, RepeaterRow, ControlField, TabGroup, SaveValueInteraction, SetCurrentRowInteraction, ScrollRepeaterInteraction } from '../protocol/types.js';
import type { Logger } from '../core/logger.js';
import { resolveSection } from '../protocol/section-resolver.js';
import { fields as treeFields, tabs as treeTabs } from '../protocol/form-views.js';
import { findByControlPath, findFieldByGroupCaption, nearestGroupCaption } from '../protocol/form-tree-walk.js';
import { isFieldNode, type FieldNode, type FormNode, type RepeaterNode } from '../protocol/form-node.js';
import { fieldNodeToControlField } from '../protocol/mcp-adapters.js';
import { mapRowCellKeys } from '../protocol/row-mapping.js';

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
   * False means the write was a no-op: BC rejected/reverted it or the control
   * was not editable. Undefined when not determinable (e.g. line-cell writes).
   */
  changed?: boolean;
  /** Why a no-op happened (only set when `changed === false`, or on a not-found error). */
  reason?: 'not editable' | 'validation reverted' | 'control not found';
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
  ) {}

  readRows(pageContextId: string, sectionId?: string): Result<RepeaterRow[], ProtocolError> {
    const ctx = this.repo.get(pageContextId);
    if (!ctx) return err(new ProtocolError(`Page context not found: ${pageContextId}`));
    const resolved = resolveSection(ctx, sectionId);
    if ('error' in resolved) return err(new ProtocolError(resolved.error, { availableSections: resolved.availableSections }));
    if (!resolved.repeater) return ok([]);
    const cols = resolved.repeater.columns.map(c => ({
      controlPath: c.controlPath,
      caption: c.properties.caption ?? '',
      type: 'rcc' as const,
      columnBinderName: c.columnBinder?.name,
      columnBinderPath: c.columnBinder?.path,
    }));
    return ok(mapRowCellKeys([...resolved.rows], cols));
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
    if (!ctx) return err(new ProtocolError(`Page context not found: ${pageContextId}`));
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
    if (!ctx) return err(new ProtocolError(`Page context not found: ${pageContextId}`));
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
    if (!ctx) return err(new ProtocolError(`Page context not found: ${pageContextId}`));
    const resolved = resolveSection(ctx, sectionId, 'header');
    if ('error' in resolved) return err(new ProtocolError(resolved.error, { availableSections: resolved.availableSections }));
    const node = this.resolveFieldNode(resolved.form.root, fieldName);
    return ok(node ? fieldNodeToControlField(resolved.form.root, node) : undefined);
  }

  getFields(pageContextId: string, sectionId?: string): Result<ControlField[], ProtocolError> {
    const ctx = this.repo.get(pageContextId);
    if (!ctx) return err(new ProtocolError(`Page context not found: ${pageContextId}`));
    const resolved = resolveSection(ctx, sectionId, 'header');
    if ('error' in resolved) return err(new ProtocolError(resolved.error, { availableSections: resolved.availableSections }));
    return ok(treeFields(resolved.form.root).map(f => fieldNodeToControlField(resolved.form.root, f)));
  }

  async writeField(
    pageContextId: string,
    fieldName: string,
    value: string,
    options?: { sectionId?: string; bookmark?: string; rowIndex?: number; group?: string },
  ): Promise<Result<FieldWriteResult, ProtocolError>> {
    const ctx = this.repo.get(pageContextId);
    if (!ctx) return err(new ProtocolError(`Page context not found: ${pageContextId}`));
    const resolved = resolveSection(ctx, options?.sectionId, 'header');
    if ('error' in resolved) return err(new ProtocolError(resolved.error, { availableSections: resolved.availableSections }));

    const { form } = resolved;

    // Line cell write: when targeting a specific row in a repeater section
    if (resolved.repeater && (options?.bookmark !== undefined || options?.rowIndex !== undefined)) {
      // Line interactions use the CHILD form's formId (the subpage form).
      // BC sends DataLoaded with root formId but SetCurrentRow/SaveValue use child formId.
      // Verified: SetCurrentRow with root formId -> InvalidBookmarkException;
      //           SetCurrentRow with child formId -> SUCCESS.
      return this.writeLineCell(pageContextId, form.formId, resolved.repeater, [...resolved.rows], fieldName, value, options);
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
      const where = options?.group ? `${fieldName} (group "${options.group}")` : fieldName;
      return err(new ProtocolError(`Field not found: ${where}`, ctxInfo));
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

    this.logger.debug('data', `writeField: ${fieldName} = ${value}`, { pageContextId, controlPath: fieldNode.controlPath });

    const result = await this.session.invoke(
      interaction,
      (event) => event.type === 'InvokeCompleted' || event.type === 'PropertyChanged',
    );

    if (isErr(result)) return result;
    const events = result.value;
    this.repo.applyToPage(pageContextId, events);

    const updatedCtx = this.repo.get(pageContextId);
    const updatedForm = updatedCtx?.forms.get(form.formId);
    const updatedNode = updatedForm ? findByControlPath(updatedForm.root, fieldNode.controlPath) : undefined;
    const newValue = updatedNode && isFieldNode(updatedNode) ? (updatedNode.properties.stringValue ?? value) : value;

    // P6: did the value actually move? BC may reformat (e.g. customer no -> name),
    // so we compare against the PRE-write value, not against `value`.
    const norm = (s?: string) => (s ?? '').trim();
    const changed = norm(newValue) !== norm(prevValue);
    let reason: FieldWriteResult['reason'] | undefined;
    if (!changed) {
      reason = editableBefore === false ? 'not editable' : 'validation reverted';
    }

    return ok({
      fieldName,
      controlPath: fieldNode.controlPath,
      success: true,
      requested: value,
      changed,
      ...(reason ? { reason } : {}),
      newValue,
      events,
    });
  }

  async writeFields(
    pageContextId: string,
    fields: Record<string, string>,
    options?: { sectionId?: string; bookmark?: string; rowIndex?: number; group?: string },
  ): Promise<Result<WriteFieldsResult, ProtocolError>> {
    const results: FieldWriteResult[] = [];
    const allEvents: BCEvent[] = [];
    for (const [name, value] of Object.entries(fields)) {
      const result = await this.writeField(pageContextId, name, value, options);
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
    return ok({ results, events: allEvents });
  }

  private async writeLineCell(
    pageContextId: string,
    formId: string,
    repeater: RepeaterNode,
    rows: readonly RepeaterRow[],
    fieldName: string,
    value: string,
    options: { bookmark?: string; rowIndex?: number },
  ): Promise<Result<FieldWriteResult, ProtocolError>> {
    let bookmark = options.bookmark;
    if (!bookmark && options.rowIndex !== undefined) {
      const row = rows[options.rowIndex];
      if (!row) return err(new ProtocolError(`Row index ${options.rowIndex} out of range. Loaded rows: 0-${rows.length - 1}.`));
      bookmark = row.bookmark;
    }
    if (!bookmark) return err(new ProtocolError('No bookmark or rowIndex provided for line cell write'));

    // Step 1: select the row
    const selectInteraction: SetCurrentRowInteraction = {
      type: 'SetCurrentRow', formId, controlPath: repeater.controlPath, key: bookmark,
    };
    const selectResult = await this.session.invoke(
      selectInteraction,
      (event) => event.type === 'InvokeCompleted' || event.type === 'BookmarkChanged',
    );
    if (isErr(selectResult)) return selectResult;
    this.repo.applyToPage(pageContextId, selectResult.value);

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
    this.logger.info(`writeLineCell: ${fieldName} = ${value} at ${cellPath} (formId=${formId})`);
    const saveResult = await this.session.invoke(
      saveInteraction,
      (event) => event.type === 'InvokeCompleted' || event.type === 'PropertyChanged',
    );
    if (isErr(saveResult)) return saveResult;
    const allEvents = [...selectResult.value, ...saveResult.value];
    this.repo.applyToPage(pageContextId, saveResult.value);
    // Line-cell writes echo the requested value back; `changed` is left undefined
    // (we do not re-read the cell here, so effect cannot be confirmed cheaply).
    return ok({ fieldName, controlPath: cellPath, success: true, requested: value, newValue: value, events: allEvents });
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

