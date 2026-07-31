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
  /** Reactive control tree — replaced (with structural sharing) by FormProjection.apply via the tree mutator.
   * Source of truth for fields/actions/tabs/repeaters/groupVisibility (computed via form-views.ts). */
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

    const { upserts, removedBookmarks } = this.extractRowChanges(event.rows);
    const removed = new Set(removedBookmarks);

    let newRows: readonly RepeaterRow[];
    if (event.currentRowOnly) {
      // Incremental update: patch existing rows by bookmark, drop any explicitly
      // removed, and APPEND rows whose bookmark is new (e.g. a line just created
      // via New). The previous code only patched existing rows and silently
      // discarded inserts/removals, so a freshly inserted row vanished until a
      // full refresh.
      const existing = form.rows.get(event.controlPath) ?? [];
      const existingBookmarks = new Set(existing.map(r => r.bookmark));
      const merged = existing
        .filter(r => !removed.has(r.bookmark))
        .map(r => upserts.find(x => x.bookmark === r.bookmark) ?? r);
      for (const x of upserts) {
        if (!existingBookmarks.has(x.bookmark) && !removed.has(x.bookmark)) merged.push(x);
      }
      newRows = merged;
    } else {
      // Full refresh: the upserts are the new row set, minus any explicit removal.
      newRows = removed.size > 0 ? upserts.filter(r => !removed.has(r.bookmark)) : upserts;
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

  /**
   * Split a DataLoaded RowChanges array into upserted rows (Inserted/Updated) and
   * the bookmarks of removed rows.
   *
   * DataRowRemoved handling is BEST-EFFORT: BC's exact removal payload shape is
   * not verified against decompiled source here, so it is parsed defensively — a
   * shape mismatch yields no removals (never a wrong removal). The row index
   * (rowData[0]) is not used for ordering; new rows are appended, which is correct
   * for the common append-at-end insert.
   */
  private extractRowChanges(rawRows: unknown[]): { upserts: RepeaterRow[]; removedBookmarks: string[] } {
    const upserts: RepeaterRow[] = [];
    const removedBookmarks: string[] = [];
    for (const raw of rawRows) {
      if (!raw || typeof raw !== 'object') continue;
      const r = raw as Record<string, unknown>;
      const upsert = (r['DataRowInserted'] ?? r['DataRowUpdated']) as unknown[] | undefined;
      if (Array.isArray(upsert) && upsert.length >= 2) {
        const payload = upsert[1] as Record<string, unknown>;
        upserts.push({
          bookmark: (payload['bookmark'] ?? payload['Bookmark'] ?? '') as string,
          cells: (payload['cells'] ?? payload['Cells'] ?? {}) as Record<string, unknown>,
        });
        continue;
      }
      const removed = r['DataRowRemoved'] as unknown[] | undefined;
      if (Array.isArray(removed)) {
        const payload = removed[1] as Record<string, unknown> | undefined;
        const bm = (payload?.['bookmark'] ?? payload?.['Bookmark']
          ?? (typeof removed[0] === 'string' ? removed[0] : undefined)) as string | undefined;
        if (bm) removedBookmarks.push(bm);
      }
    }
    return { upserts, removedBookmarks };
  }
}
