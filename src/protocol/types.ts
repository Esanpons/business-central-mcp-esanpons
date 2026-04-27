// -- BCEvent types --

export type BCEvent =
  | FormCreatedEvent
  | FormClosedEvent
  | DialogOpenedEvent
  | DataLoadedEvent
  | PropertyChangedEvent
  | BookmarkChangedEvent
  | InvokeCompletedEvent
  | SessionInfoEvent;

export interface FormCreatedEvent {
  readonly type: 'FormCreated';
  readonly formId: string;
  readonly parentFormId?: string;
  readonly isReload?: boolean;
  readonly controlTree: unknown;
}

export interface FormClosedEvent {
  readonly type: 'FormClosed';
  readonly formId: string;
}

export interface DialogOpenedEvent {
  readonly type: 'DialogOpened';
  readonly formId: string;
  readonly ownerFormId?: string;
  readonly controlTree: unknown;
}

export interface DataLoadedEvent {
  readonly type: 'DataLoaded';
  readonly formId: string;
  readonly controlPath: string;
  readonly currentRowOnly: boolean;
  readonly rows: unknown[];
}

export interface PropertyChangedEvent {
  readonly type: 'PropertyChanged';
  readonly formId: string;
  readonly controlPath: string;
  readonly changes: Record<string, unknown>;
}

export interface BookmarkChangedEvent {
  readonly type: 'BookmarkChanged';
  readonly formId: string;
  readonly controlPath: string;
  readonly bookmark: string;
}

export interface InvokeCompletedEvent {
  readonly type: 'InvokeCompleted';
  readonly sequenceNumber: number;
  readonly completedInteractions: Array<{
    invocationId: string;
    durationMs: number;
    result?: unknown;
  }>;
}

export interface SessionInfoEvent {
  readonly type: 'SessionInfo';
  readonly formId: string;
  readonly sessionData: unknown;
}

// -- BCInteraction types --

export type BCInteraction =
  | OpenFormInteraction
  | LoadFormInteraction
  | CloseFormInteraction
  | InvokeActionInteraction
  | SaveValueInteraction
  | FilterInteraction
  | SetCurrentRowInteraction
  | ScrollRepeaterInteraction
  | SessionActionInteraction;

interface BaseInteraction {
  readonly formId?: string;
  readonly controlPath?: string;
}

export interface OpenFormInteraction extends BaseInteraction {
  readonly type: 'OpenForm';
  readonly query: string;
}

export interface LoadFormInteraction extends BaseInteraction {
  readonly type: 'LoadForm';
  readonly formId: string;
  readonly loadData: boolean;
  readonly delayed?: boolean;
  readonly openForm?: boolean;
}

export interface CloseFormInteraction extends BaseInteraction {
  readonly type: 'CloseForm';
  readonly formId: string;
}

export interface InvokeActionInteraction extends BaseInteraction {
  readonly type: 'InvokeAction';
  readonly formId: string;
  readonly controlPath: string;
  readonly systemAction?: number;
  readonly namedParameters?: Record<string, unknown>;
}

export interface SaveValueInteraction extends BaseInteraction {
  readonly type: 'SaveValue';
  readonly formId: string;
  readonly controlPath: string;
  readonly newValue: string;
}

export interface FilterInteraction extends BaseInteraction {
  readonly type: 'Filter';
  readonly formId: string;
  readonly controlPath: string;
  readonly filterOperation: number;
  readonly filterColumnId?: string;
  readonly filterValue?: string;
}

export interface SetCurrentRowInteraction extends BaseInteraction {
  readonly type: 'SetCurrentRow';
  readonly formId: string;
  readonly controlPath: string;
  readonly key: string;
}

export interface ScrollRepeaterInteraction extends BaseInteraction {
  readonly type: 'ScrollRepeater';
  readonly formId: string;
  readonly controlPath: string;
  readonly delta: number;  // positive = forward/down, negative = backward/up
}

export interface SessionActionInteraction extends BaseInteraction {
  readonly type: 'SessionAction';
  readonly actionName: string;
  readonly namedParameters?: Record<string, unknown>;
}

// -- Constants --

export const SystemAction = {
  None: 0, New: 10, Delete: 20, Refresh: 30, Edit: 40,
  EditList: 50, View: 60, ViewList: 70, OpenFullList: 80,
  AssistEdit: 100, Lookup: 110, DrillDown: 120,
  PageSearch: 220,
  Ok: 300, Cancel: 310, Abort: 320,
  LookupOk: 330, LookupCancel: 340, Yes: 380, No: 390,
} as const;

export const FilterOperation = {
  Execute: 0, AddLine: 1, RemoveLine: 2, Reset: 3,
} as const;

export type EventPredicate = (event: BCEvent, context: {
  callbackId: string;
  interactionFormId?: string;
  invokeCompletedSeen: boolean;
}) => boolean;

// -- PageState: derived from BCEvent[] projections --

/**
 * AL PageType names. Wire ordinal -> name mapping lives in control-tree-parser.ts
 * `PAGE_TYPE_MAP` and is sourced from decompiled `Microsoft.Dynamics.Nav.Types.Metadata.PageType.cs`.
 */
export type PageType =
  | 'Card'
  | 'List'
  | 'RoleCenter'
  | 'CardPart'
  | 'ListPart'
  | 'Document'
  | 'Worksheet'
  | 'ListPlus'
  | 'ConfirmationDialog'
  | 'NavigatePage'
  | 'StandardDialog'
  | 'API'
  | 'HeadlinePart'
  | 'ReportPreview'
  | 'ReportProcessingOnly'
  | 'XmlPort'
  | 'ReportViewer'
  | 'FilterPage'
  | 'ListQuery'
  | 'BannerPart'
  | 'PromptDialog'
  | 'ConfigurationDialog'
  | 'UserControlHost'
  | 'Unknown';

export interface PageState {
  readonly pageContextId: string;
  readonly formId: string;
  readonly pageType: PageType;
  readonly controlTree: ControlField[];
  readonly repeater: RepeaterState | null;
  readonly filterControlPath: string | null;
  readonly actions: ActionInfo[];
  readonly childForms: ChildFormInfo[];
  readonly dialogs: DialogInfo[];
  readonly openFormIds: string[];
}

export interface ControlField {
  readonly controlPath: string;
  readonly caption: string;
  readonly type: string;
  readonly editable: boolean;
  /**
   * The control's own published `Visible` state. The user-visible filter must
   * combine this with every ancestor group's visibility — see
   * `isEffectivelyVisible` in protocol/visibility.ts.
   */
  readonly visible: boolean;
  readonly value?: unknown;
  readonly stringValue?: string;
  readonly columnBinderName?: string; // e.g., "1165569367_c2" — key in row cells
  readonly isLookup?: boolean;        // true if field has AssistEditAction or LookupAction
  readonly showMandatory?: boolean;   // true if field is marked as mandatory in BC
  /**
   * controlPaths of every gc ancestor between the form root (`server:`) and
   * this field's immediate parent gc, in root → leaf order. Empty for fields
   * that hang directly off the form root with no group container.
   */
  readonly ancestorGroupPaths: readonly string[];
}

export interface RepeaterState {
  readonly controlPath: string;
  readonly columns: RepeaterColumn[];
  readonly rows: RepeaterRow[];
  readonly totalRowCount: number | null;      // null = unknown; set from PropertyChanged, NOT rows.length
  readonly currentBookmark: string | null;     // per-repeater; set from BookmarkChanged events
}

export interface RepeaterColumn {
  readonly controlPath: string;
  readonly caption: string;
  readonly type: string;
  readonly columnBinderName?: string;   // key that matches row.cells keys
  readonly columnBinderPath?: string;   // for filter column IDs
}

export interface RepeaterRow {
  readonly bookmark: string;
  readonly cells: Record<string, unknown>;
}

export interface TabGroup {
  readonly caption: string;
  readonly fields: ControlField[];
}

export interface ActionInfo {
  readonly controlPath: string;
  readonly caption: string;
  readonly systemAction: number;
  readonly enabled: boolean;
  readonly visible: boolean;
  readonly isLineScoped: boolean;       // true if defined inside a repeater subtree
  readonly iconIdentifier?: string;     // raw icon resource path, e.g. "Actions/NextRecord/16.png"
  readonly wizardNav?: 'back' | 'next' | 'finish' | 'cancel'; // semantic role on a NavigatePage
  /** Ancestor gc paths — same shape and intent as on `ControlField`. */
  readonly ancestorGroupPaths: readonly string[];
}

/**
 * Per-form record of every group container's current `Visible` value, keyed by
 * controlPath. Maintained by FormProjection: seeded from the parsed control
 * tree and updated from `PropertyChanged` events whose target is a gc path.
 *
 * Groups not in the map are treated as visible (default-true) — only groups
 * the parser saw are tracked. Empty for forms with no group containers.
 */
export type GroupVisibility = ReadonlyMap<string, boolean>;

/**
 * Tracks the active step on a NavigatePage / wizard. BC's web client owns the
 * step variable entirely client-side; the wire only carries the initial
 * visibility and the `ExpressionProperties.Visible` membership flag that marks
 * which groups participate. We mirror the same state machine here.
 */
export interface WizardState {
  /**
   * controlPaths of the participating step groups in document order. Always
   * length ≥ 2; otherwise the page isn't treated as a wizard.
   */
  readonly stepPaths: readonly string[];
  /** Index into `stepPaths` of the currently visible step. */
  readonly currentStepIndex: number;
}

export enum ControlContainerType {
  ContentArea = 0,
  FactBoxArea = 1,
  RoleCenterArea = 2,
  RequestPageFilters = 3,
  DetailsArea = 4,
}

export interface ChildFormInfo {
  readonly formId: string;
  readonly caption: string;
}

export interface DialogInfo {
  readonly formId: string;
  readonly ownerFormId?: string;
  readonly controlTree: unknown;
}

// -- Backward compatibility --

import type { PageContext } from './page-context.js';
import type { FormState } from './form-state.js';

/**
 * DEPRECATED: Use PageContext for new code.
 * Converts a PageContext back to a PageState for consumers that haven't been migrated yet.
 */
export function derivePageState(ctx: PageContext): PageState {
  const rootForm = ctx.forms.get(ctx.rootFormId);
  const rep = rootForm ? primaryRepeaterFromCtx(rootForm) : null;
  return {
    pageContextId: ctx.pageContextId,
    formId: ctx.rootFormId,
    pageType: ctx.pageType,
    controlTree: rootForm?.controlTree ?? [],
    repeater: rep,
    filterControlPath: rootForm?.filterControlPath ?? null,
    actions: rootForm?.actions ?? [],
    childForms: Array.from(ctx.forms.entries())
      .filter(([fId]) => fId !== ctx.rootFormId)
      .map(([fId]) => ({ formId: fId, caption: '' })),
    dialogs: ctx.dialogs,
    openFormIds: ctx.ownedFormIds,
  };
}

function primaryRepeaterFromCtx(form: FormState): RepeaterState | null {
  const first = form.repeaters.values().next();
  return first.done ? null : first.value;
}
