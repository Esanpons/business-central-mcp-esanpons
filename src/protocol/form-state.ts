// src/protocol/form-state.ts
import type {
  ControlField, RepeaterState, RepeaterRow, ActionInfo, ControlContainerType,
  BCEvent, DataLoadedEvent, PropertyChangedEvent, BookmarkChangedEvent, TabGroup,
} from './types.js';
import type { FormNode } from './form-node.js';
import { buildFormTree } from './form-tree-builder.js';

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

/** Returns the first (and usually only) repeater, or null. */
export function primaryRepeater(form: FormState): RepeaterState | null {
  const first = form.repeaters.values().next();
  return first.done ? null : first.value;
}

/** Returns the repeater matching a controlPath, or the primary. */
export function resolveRepeater(form: FormState, controlPath?: string): RepeaterState | null {
  if (controlPath) return form.repeaters.get(controlPath) ?? null;
  return primaryRepeater(form);
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
    const repeater = form.repeaters.get(event.controlPath);
    if (!repeater) return form;

    const extractedRows = this.extractRows(event.rows);

    let newRows: RepeaterRow[];
    if (event.currentRowOnly) {
      // Merge by bookmark -- replace matching rows, keep others
      newRows = form.repeaters.get(event.controlPath)!.rows.map(existing => {
        const updated = extractedRows.find(r => r.bookmark === existing.bookmark);
        return updated ?? existing;
      });
    } else {
      newRows = extractedRows;
    }

    const updatedRepeater: RepeaterState = {
      ...repeater,
      rows: newRows,
      // totalRowCount is NOT inferred from rows.length -- stays null unless set by PropertyChanged
    };

    const newRepeaters = new Map(form.repeaters);
    newRepeaters.set(event.controlPath, updatedRepeater);
    return { ...form, repeaters: newRepeaters };
  }

  private applyPropertyChanged(form: FormState, event: PropertyChangedEvent): FormState {
    const repeater = form.repeaters.get(event.controlPath);

    if (repeater && 'TotalRowCount' in event.changes) {
      const totalRowCount = event.changes['TotalRowCount'] as number;
      const updatedRepeater: RepeaterState = { ...repeater, totalRowCount };
      const newRepeaters = new Map(form.repeaters);
      newRepeaters.set(event.controlPath, updatedRepeater);
      return { ...form, repeaters: newRepeaters };
    }

    // If the controlPath targets a tracked group container, update its
    // visibility — descendants' effective visibility is derived from this map
    // via isEffectivelyVisible(). Group updates land *before* the action /
    // field branches so a gc that happens to share a path with an action
    // doesn't get mis-routed.
    if (form.groupVisibility.has(event.controlPath)) {
      const { Visible: GroupVisible } = event.changes as Record<string, unknown>;
      if (typeof GroupVisible === 'boolean') {
        const newGroupVisibility = new Map(form.groupVisibility);
        newGroupVisibility.set(event.controlPath, GroupVisible);
        return { ...form, groupVisibility: newGroupVisibility };
      }
    }

    // Update action Enabled/Visible state if the controlPath matches an action.
    // BC sends PropertyChanged events for action controls after page load.
    const { Enabled, Visible: VisibleProp } = event.changes as Record<string, unknown>;
    if (Enabled !== undefined || VisibleProp !== undefined) {
      const actionIndex = form.actions.findIndex(a => a.controlPath === event.controlPath);
      if (actionIndex >= 0) {
        const existing = form.actions[actionIndex]!;
        const updatedAction: ActionInfo = {
          ...existing,
          ...(Enabled !== undefined ? { enabled: Enabled as boolean } : {}),
          ...(VisibleProp !== undefined ? { visible: VisibleProp as boolean } : {}),
        };
        const updatedActions = [
          ...form.actions.slice(0, actionIndex),
          updatedAction,
          ...form.actions.slice(actionIndex + 1),
        ];
        return { ...form, actions: updatedActions };
      }
    }

    // Otherwise update the controlTree field
    const { StringValue, Caption, Editable, Visible } = event.changes as Record<string, unknown>;

    const existingIndex = form.controlTree.findIndex(f => f.controlPath === event.controlPath);
    let updatedTree: ControlField[];

    if (existingIndex >= 0) {
      const existing = form.controlTree[existingIndex]!;
      const updated: ControlField = {
        ...existing,
        ...(StringValue !== undefined ? { stringValue: StringValue as string } : {}),
        ...(Caption !== undefined ? { caption: Caption as string } : {}),
        ...(Editable !== undefined ? { editable: Editable as boolean } : {}),
        ...(Visible !== undefined ? { visible: Visible as boolean } : {}),
      };
      updatedTree = [
        ...form.controlTree.slice(0, existingIndex),
        updated,
        ...form.controlTree.slice(existingIndex + 1),
      ];
    } else {
      // Synthesised from a PropertyChanged whose controlPath the parser never
      // saw — leave ancestorGroupPaths empty so it inherits no group filter.
      const newField: ControlField = {
        controlPath: event.controlPath,
        caption: (Caption as string | undefined) ?? '',
        type: '',
        editable: (Editable as boolean | undefined) ?? false,
        visible: (Visible as boolean | undefined) ?? true,
        ancestorGroupPaths: [],
        ...(StringValue !== undefined ? { stringValue: StringValue as string } : {}),
      };
      updatedTree = [...form.controlTree, newField];
    }

    return { ...form, controlTree: updatedTree };
  }

  private applyBookmarkChanged(form: FormState, event: BookmarkChangedEvent): FormState {
    const repeater = form.repeaters.get(event.controlPath);
    if (!repeater) return form;

    const updatedRepeater: RepeaterState = { ...repeater, currentBookmark: event.bookmark };
    const newRepeaters = new Map(form.repeaters);
    newRepeaters.set(event.controlPath, updatedRepeater);
    return { ...form, repeaters: newRepeaters };
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
