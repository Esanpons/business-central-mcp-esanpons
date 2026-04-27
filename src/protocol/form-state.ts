// src/protocol/form-state.ts
import type {
  RepeaterRow, ControlContainerType,
  BCEvent, DataLoadedEvent, PropertyChangedEvent, BookmarkChangedEvent,
} from './types.js';
import type { FormNode } from './form-node.js';
import type { NodeProperties } from './form-node.js';
import { buildFormTree } from './form-tree-builder.js';
import { applyPropertyChange } from './form-tree-mutator.js';
import { repeaters as treeRepeaters } from './form-views.js';

export interface FormState {
  readonly formId: string;
  readonly parentFormId?: string;
  /** Reactive control tree — mutated by FormProjection.apply via tree mutator.
   * Source of truth for fields/actions/tabs/repeaters/groupVisibility (computed
   * via form-views.ts). */
  readonly root: FormNode;
  /** Repeater rows keyed by repeater controlPath. */
  readonly rows: ReadonlyMap<string, readonly RepeaterRow[]>;
  readonly containerType?: ControlContainerType;
}

export class FormProjection {
  /** Creates an empty FormState for the given formId. */
  createInitial(formId: string, parentFormId?: string): FormState {
    const root = buildFormTree({ t: 'lf', ServerId: formId, Children: [], PageType: -1 });
    return {
      formId,
      parentFormId,
      root,
      rows: new Map(),
    };
  }

  /** Applies a single BCEvent to the given FormState, returning an updated copy. */
  apply(form: FormState, event: BCEvent): FormState {
    switch (event.type) {
      case 'DataLoaded':
        return this.applyDataLoaded(form, event);
      case 'PropertyChanged':
        return this.applyPropertyChanged(form, event);
      case 'BookmarkChanged':
        return this.applyBookmarkChanged(form, event);
      default:
        return form;
    }
  }

  private applyDataLoaded(form: FormState, event: DataLoadedEvent): FormState {
    // Look up the RepeaterNode in the tree; if absent, this is a no-op.
    const repeaterNode = treeRepeaters(form.root).get(event.controlPath);
    if (!repeaterNode) return form;

    const extractedRows = this.extractRows(event.rows);

    let newRows: readonly RepeaterRow[];
    if (event.currentRowOnly) {
      const existing = form.rows.get(event.controlPath) ?? [];
      newRows = existing.map(r => extractedRows.find(x => x.bookmark === r.bookmark) ?? r);
    } else {
      newRows = extractedRows;
    }

    const newRowsMap = new Map(form.rows);
    newRowsMap.set(event.controlPath, newRows);
    return { ...form, rows: newRowsMap };
  }

  private applyPropertyChanged(form: FormState, event: PropertyChangedEvent): FormState {
    const changes = event.changes as Record<string, unknown>;

    // Translate BC's wire property names (PascalCase) → NodeProperties (camelCase)
    const nodeChanges: NodeProperties = {};
    if ('Visible' in changes && typeof changes.Visible === 'boolean') (nodeChanges as Record<string, unknown>).visible = changes.Visible;
    if ('Editable' in changes && typeof changes.Editable === 'boolean') (nodeChanges as Record<string, unknown>).editable = changes.Editable;
    if ('Enabled' in changes && typeof changes.Enabled === 'boolean') (nodeChanges as Record<string, unknown>).enabled = changes.Enabled;
    if ('Caption' in changes && typeof changes.Caption === 'string') (nodeChanges as Record<string, unknown>).caption = changes.Caption;
    if ('StringValue' in changes) (nodeChanges as Record<string, unknown>).stringValue = changes.StringValue == null ? undefined : String(changes.StringValue);
    if ('ObjectValue' in changes) (nodeChanges as Record<string, unknown>).objectValue = changes.ObjectValue;
    if ('TotalRowCount' in changes && typeof changes.TotalRowCount === 'number') (nodeChanges as Record<string, unknown>).totalRowCount = changes.TotalRowCount;
    if ('Bookmark' in changes && typeof changes.Bookmark === 'string') (nodeChanges as Record<string, unknown>).bookmark = changes.Bookmark;
    if ('HasFiltersApplied' in changes && typeof changes.HasFiltersApplied === 'boolean') (nodeChanges as Record<string, unknown>).hasFiltersApplied = changes.HasFiltersApplied;

    const newRoot = applyPropertyChange(form.root, event.controlPath, nodeChanges);
    if (newRoot === form.root) return form;
    return { ...form, root: newRoot };
  }

  private applyBookmarkChanged(form: FormState, event: BookmarkChangedEvent): FormState {
    // Bookmark lives on the repeater's NodeProperties — route through the mutator.
    const newRoot = applyPropertyChange(form.root, event.controlPath, { bookmark: event.bookmark });
    if (newRoot === form.root) return form;
    return { ...form, root: newRoot };
  }

  private extractRows(rawRows: unknown[]): RepeaterRow[] {
    const rows: RepeaterRow[] = [];
    for (const raw of rawRows) {
      if (!raw || typeof raw !== 'object') continue;
      const r = raw as Record<string, unknown>;
      const rowData = (r['DataRowInserted'] ?? r['DataRowUpdated']) as unknown[] | undefined;
      if (Array.isArray(rowData) && rowData.length >= 2) {
        const payload = rowData[1] as Record<string, unknown>;
        rows.push({
          bookmark: (payload['bookmark'] ?? payload['Bookmark'] ?? '') as string,
          cells: (payload['cells'] ?? payload['Cells'] ?? {}) as Record<string, unknown>,
        });
      }
    }
    return rows;
  }
}
