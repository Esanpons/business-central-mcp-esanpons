// src/protocol/form-state.ts
import type {
  RepeaterRow,
  BCEvent, DataLoadedEvent, PropertyChangedEvent, BookmarkChangedEvent,
} from './types.js';
import type { FormNode } from './form-node.js';
import type { NodeProperties } from './form-node.js';
import { buildFormTree } from './form-tree-builder.js';
import { applyPropertyChange } from './form-tree-mutator.js';
import { repeaters as treeRepeaters } from './form-views.js';
import { resolveChangeType } from './wire-types.js';

export interface FormState {
  readonly formId: string;
  readonly parentFormId?: string;
  /** Reactive control tree — replaced (with structural sharing) by FormProjection.apply via the tree mutator.
   * Source of truth for fields/actions/tabs/repeaters/groupVisibility (computed via form-views.ts). */
  readonly root: FormNode;
  /** Repeater rows keyed by repeater controlPath. */
  readonly rows: ReadonlyMap<string, readonly RepeaterRow[]>;
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
      //
      // An EMPTY bookmark is not an identity: BC omits the bookmark on rows it
      // has not committed yet, so several distinct rows can share ''. Matching on
      // '' would patch every existing blank row with the first blank upsert and
      // never append the rest. Blank-bookmark rows are therefore always treated
      // as unmatched — appended, never used to patch, never used to remove.
      const existing = form.rows.get(event.controlPath) ?? [];
      const existingBookmarks = new Set(existing.map(r => r.bookmark).filter(b => b !== ''));
      const merged = existing
        .filter(r => r.bookmark === '' || !removed.has(r.bookmark))
        .map(r => (r.bookmark === '' ? r : upserts.find(x => x.bookmark !== '' && x.bookmark === r.bookmark) ?? r));
      for (const x of upserts) {
        if (x.bookmark === '') { merged.push(x); continue; }
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
    // BC publishes the repeater's current-row bookmark under the DOTTED name
    // `Data.CurrentBookmark` on the repeater's own controlPath — the plain
    // `Bookmark` name never appears for this. Verified in every live capture
    // (e.g. captures/tell-me-result-2026-04-28.json: PropertyChanged on
    // `server:c[1]` with `Data.CurrentBookmark`). Without this mapping
    // RepeaterState.currentBookmark stayed null forever.
    if ('Data.CurrentBookmark' in changes && typeof changes['Data.CurrentBookmark'] === 'string') {
      (nodeChanges as Record<string, unknown>).bookmark = changes['Data.CurrentBookmark'];
    }
    if ('HasFiltersApplied' in changes && typeof changes.HasFiltersApplied === 'boolean') (nodeChanges as Record<string, unknown>).hasFiltersApplied = changes.HasFiltersApplied;
    // Option/enum fields: BC echoes the selected index as `CurrentIndex`. When an
    // echo carries only `StringValue`, the build-time optionIndex is now STALE —
    // clear it so consumers fall back to matching the new stringValue against the
    // option texts instead of reporting the pre-change option.
    if ('CurrentIndex' in changes && typeof changes.CurrentIndex === 'number') {
      (nodeChanges as Record<string, unknown>).optionIndex = changes.CurrentIndex;
    } else if ('StringValue' in changes) {
      (nodeChanges as Record<string, unknown>).optionIndex = undefined;
    }

    // Nothing this projection tracks changed (e.g. an event carrying only
    // ValidationResults / ShowMandatory / Items). Returning a NEW root here would
    // discard every memoised view (fields/actions/tabs/repeaters/groupVisibility/
    // cues) for no benefit — costly on Role Center trees, which receive a stream
    // of cosmetic events. Keep the same reference so the caches survive.
    if (Object.keys(nodeChanges).length === 0) return form;

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
      // Row changes are tagged exactly like top-level changes: `t` may be the
      // full name OR its wire abbreviation (drich/druch/drrch), and the payload
      // is stored under a key of the SAME spelling as `t`. Resolving `t` and
      // then reading BOTH the resolved and the raw key covers every tier —
      // previously an abbreviated batch matched nothing and the whole rowset
      // was silently dropped.
      const wireType = typeof r.t === 'string' ? r.t : undefined;
      const resolved = wireType ? resolveChangeType(wireType) : undefined;
      const payloadOf = (name: string): unknown[] | undefined => {
        // 1. Full-name key (BC28 /csh long form).
        if (Array.isArray(r[name])) return r[name] as unknown[];
        // 2. Key spelled exactly like `t` when `t` resolves to this change.
        if (wireType && resolved === name && Array.isArray(r[wireType])) return r[wireType] as unknown[];
        // 3. Any array-valued key that resolves to this change (abbreviated
        //    payload key with a missing/short `t`).
        for (const [k, v] of Object.entries(r)) {
          if (k === 't' || !Array.isArray(v)) continue;
          if (resolveChangeType(k) === name) return v;
        }
        return undefined;
      };

      const upsert = payloadOf('DataRowInserted') ?? payloadOf('DataRowUpdated');
      if (Array.isArray(upsert) && upsert.length >= 2 && upsert[1] && typeof upsert[1] === 'object') {
        const payload = upsert[1] as Record<string, unknown>;
        upserts.push({
          bookmark: (payload['bookmark'] ?? payload['Bookmark'] ?? '') as string,
          cells: (payload['cells'] ?? payload['Cells'] ?? {}) as Record<string, unknown>,
        });
        continue;
      }
      const removed = payloadOf('DataRowRemoved');
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
