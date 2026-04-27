// src/protocol/form-state.ts
import type {
  ControlField, RepeaterState, RepeaterRow, ActionInfo, ControlContainerType,
  BCEvent, DataLoadedEvent, PropertyChangedEvent, BookmarkChangedEvent, TabGroup,
} from './types.js';
import { isGroupNode, type ActionNode, type FieldNode, type FormNode } from './form-node.js';
import type { NodeProperties } from './form-node.js';
import { buildFormTree } from './form-tree-builder.js';
import { applyPropertyChange } from './form-tree-mutator.js';
import {
  fields as treeFields, actions as treeActions, repeaters as treeRepeaters,
  tabs as treeTabs, groupVisibility as treeGroupVisibility, filterControlPath as treeFilter,
} from './form-views.js';
import { ancestorsOf } from './form-tree-walk.js';

export interface FormState {
  readonly formId: string;
  readonly parentFormId?: string;
  /** Reactive control tree — mutated by FormProjection.apply via tree mutator.
   * Source of truth for fields/actions/tabs/repeaters/groupVisibility (computed
   * via form-views.ts). */
  readonly root: FormNode;
  /** Repeater rows keyed by repeater controlPath. Rows arrive via DataLoaded
   * events and don't fit the publish-then-mutate tree model. */
  readonly rows: ReadonlyMap<string, readonly RepeaterRow[]>;
  // Legacy flat fields — coexist during migration. Removed in Phase 7.
  readonly controlTree: ControlField[];
  readonly tabs?: TabGroup[];
  readonly repeaters: ReadonlyMap<string, RepeaterState>;
  readonly actions: ActionInfo[];
  readonly filterControlPath: string | null;
  readonly containerType?: ControlContainerType;
  /**
   * Per-form record of every group container's current `Visible` value, keyed
   * by controlPath. Seeded from the parsed control tree and updated by
   * PropertyChanged events. Empty for forms with no group containers.
   */
  readonly groupVisibility: ReadonlyMap<string, boolean>;
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
      controlTree: [],
      repeaters: new Map(),
      actions: [],
      filterControlPath: null,
      groupVisibility: new Map(),
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

    return {
      ...form,
      rows: newRowsMap,
      // Re-derive repeaters using the new rows map. Tree didn't mutate, so views
      // are cache-hit; only the rows map matters here.
      repeaters: deriveRepeaterStates(form.root, newRowsMap),
    };
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

    // Re-derive flat arrays from the (possibly new) root. Memoised in form-views,
    // so this is free when newRoot === form.root.
    return {
      ...form,
      root: newRoot,
      controlTree: deriveControlFields(newRoot),
      actions: deriveActionInfos(newRoot),
      tabs: deriveTabGroups(newRoot),
      repeaters: deriveRepeaterStates(newRoot, form.rows),
      filterControlPath: treeFilter(newRoot),
      groupVisibility: treeGroupVisibility(newRoot),
    };
  }

  private applyBookmarkChanged(form: FormState, event: BookmarkChangedEvent): FormState {
    // Bookmark lives on the repeater's NodeProperties — route through the mutator.
    const newRoot = applyPropertyChange(form.root, event.controlPath, { bookmark: event.bookmark });
    if (newRoot === form.root) return form; // path unknown
    return {
      ...form,
      root: newRoot,
      repeaters: deriveRepeaterStates(newRoot, form.rows),
    };
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

// ---------------------------------------------------------------------------
// Adapter functions: translate tree nodes → legacy flat shapes consumed by
// the rest of the codebase during the migration period (removed in Phase 7).
// ---------------------------------------------------------------------------

function ancestorGroupPathsFor(root: FormNode, controlPath: string): readonly string[] {
  return ancestorsOf(root, controlPath).filter(n => isGroupNode(n)).map(n => n.controlPath);
}

function fieldNodeToControlField(root: FormNode, f: FieldNode): ControlField {
  return {
    controlPath: f.controlPath,
    caption: f.properties.caption ?? '',
    type: f.type,
    editable: f.properties.editable ?? false,
    visible: f.properties.visible ?? true,
    stringValue: f.properties.stringValue,
    value: f.properties.objectValue ?? f.properties.stringValue,
    columnBinderName: f.columnBinder?.name,
    ...(f.hasLookup ? { isLookup: true } : {}),
    ...(f.properties.showMandatory ? { showMandatory: true } : {}),
    ancestorGroupPaths: ancestorGroupPathsFor(root, f.controlPath),
  };
}

function actionNodeToActionInfo(root: FormNode, a: ActionNode): ActionInfo {
  const wizardNav = classifyWizardNav(a);
  return {
    controlPath: a.controlPath,
    caption: a.properties.caption ?? '',
    systemAction: a.systemAction,
    enabled: a.properties.enabled ?? true,
    visible: a.properties.visible ?? true,
    isLineScoped: a.isLineScoped,
    ...(a.iconIdentifier ? { iconIdentifier: a.iconIdentifier } : {}),
    ...(wizardNav ? { wizardNav } : {}),
    ancestorGroupPaths: ancestorGroupPathsFor(root, a.controlPath),
  };
}

function classifyWizardNav(a: ActionNode): 'back' | 'next' | 'finish' | 'cancel' | undefined {
  const id = a.iconIdentifier;
  if (id) {
    if (/PreviousRecord/i.test(id)) return 'back';
    if (/NextRecord|Action_Start/i.test(id)) return 'next';
    if (/Approve/i.test(id)) return 'finish';
  }
  if (a.systemAction === 310 || a.systemAction === 320 || a.systemAction === 350) return 'cancel';
  return undefined;
}

function deriveControlFields(root: FormNode): ControlField[] {
  return treeFields(root).map(f => fieldNodeToControlField(root, f));
}

function deriveActionInfos(root: FormNode): ActionInfo[] {
  return treeActions(root).map(a => actionNodeToActionInfo(root, a));
}

function deriveTabGroups(root: FormNode): TabGroup[] {
  return treeTabs(root).map(t => ({
    caption: t.caption,
    fields: t.fields.map(f => fieldNodeToControlField(root, f)),
  }));
}

function deriveRepeaterStates(root: FormNode, rows: ReadonlyMap<string, readonly RepeaterRow[]>): ReadonlyMap<string, RepeaterState> {
  const out = new Map<string, RepeaterState>();
  for (const [path, node] of treeRepeaters(root)) {
    out.set(path, {
      controlPath: path,
      columns: node.columns.map(c => ({
        controlPath: c.controlPath,
        caption: c.properties.caption ?? '',
        type: 'rcc',
        columnBinderName: c.columnBinder?.name,
        columnBinderPath: c.columnBinder?.path,
      })),
      rows: [...(rows.get(path) ?? [])],
      totalRowCount: node.properties.totalRowCount ?? null,
      currentBookmark: node.properties.bookmark ?? null,
    });
  }
  return out;
}
