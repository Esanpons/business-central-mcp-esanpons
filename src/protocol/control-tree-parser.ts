import type { ControlField, RepeaterColumn, RepeaterState, ActionInfo, TabGroup, PageType } from './types.js';

export interface DiscoveredChildForm {
  readonly serverId: string;          // lf node's ServerId (used as formId)
  readonly caption: string;
  readonly controlTree: unknown;      // raw lf node, to be parsed separately
  readonly isSubForm: boolean;        // true for lines subpages
  readonly isPart: boolean;           // true for factboxes and parts
}

export interface ParsedControlTree {
  caption: string;
  pageType: PageType;
  fields: ControlField[];
  tabs?: TabGroup[];
  repeaters: ReadonlyMap<string, RepeaterState>;
  filterControlPath: string | null;
  actions: ActionInfo[];
  childForms: DiscoveredChildForm[];  // fhc -> lf nodes found in the tree
  metadata?: { id: number; sourceTableId: number };
}

const FIELD_TYPES = new Set([
  'sc',   // StringControl — text field
  'dc',   // DecimalControl — numeric field
  'bc',   // BooleanControl — checkbox
  'dtc',  // DateControl
  'i32c', // Int32Control
  'sec',  // SelectControl — option/dropdown
  'pc',   // PasswordControl
  'ssc',  // StaticStringControl — read-only label / instructional text on wizards & cues
]);

/**
 * Wire-level PageType ordinal -> AL PageType name. Indices come from BC's
 * enum (decompiled `Microsoft.Dynamics.Nav.Types.Metadata.PageType.cs`).
 * Order is load-bearing — values are serialized as the enum index.
 */
const PAGE_TYPE_MAP: Record<number, PageType> = {
  0: 'Card',
  1: 'List',
  2: 'RoleCenter',
  3: 'CardPart',
  4: 'ListPart',
  5: 'Document',
  6: 'Worksheet',
  7: 'ListPlus',
  8: 'ConfirmationDialog',
  9: 'NavigatePage',
  10: 'StandardDialog',
  11: 'API',
  12: 'HeadlinePart',
  13: 'ReportPreview',
  14: 'ReportProcessingOnly',
  15: 'XmlPort',
  16: 'ReportViewer',
  17: 'FilterPage',
  18: 'ListQuery',
  19: 'BannerPart',
  20: 'PromptDialog',
  21: 'ConfigurationDialog',
  22: 'UserControlHost',
};

/**
 * Parse a BC control tree (the `lf` root node from FormCreated.controlTree)
 * and extract fields, repeater columns, actions, and page metadata.
 */
export function parseControlTree(controlTree: unknown): ParsedControlTree {
  const result: ParsedControlTree = {
    caption: '',
    pageType: 'Unknown',
    fields: [],
    repeaters: new Map(),
    filterControlPath: null,
    actions: [],
    childForms: [],
  };

  if (!controlTree || typeof controlTree !== 'object') return result;
  const root = controlTree as Record<string, unknown>;

  // Extract root metadata from the lf node
  result.caption = (root.Caption as string) ?? '';
  const pageTypeNum = root.PageType as number | undefined;
  if (pageTypeNum !== undefined && pageTypeNum in PAGE_TYPE_MAP) {
    result.pageType = PAGE_TYPE_MAP[pageTypeNum]!;
  }

  if (root.Metadata && typeof root.Metadata === 'object') {
    const meta = root.Metadata as Record<string, unknown>;
    result.metadata = {
      id: (meta.id as number) ?? 0,
      sourceTableId: (meta.sourceTableId as number) ?? 0,
    };
  }

  // Walk the tree starting from root Children
  // BC references the lf root's children as server:c[0], server:c[1], etc.
  // (not server:c[0]/c[0], server:c[0]/c[1] — the lf node is implicit)
  const children = root.Children as unknown[] | undefined;
  if (Array.isArray(children)) {
    walkChildren(children, 'server', result, false);

    // Extract tab groups from top-level gc nodes.
    // Tab gc nodes have a Caption and no MappingHint (excludes TOOLBAR, ACTIONBAR, PromptActions, etc.)
    const tabs = extractTabGroups(children, result);
    if (tabs.length > 0) {
      result.tabs = tabs;
    }
  }

  return result;
}

function walkChildren(
  children: unknown[],
  parentPath: string,
  result: ParsedControlTree,
  insideRepeater: boolean,
): void {
  for (let i = 0; i < children.length; i++) {
    const child = children[i];
    if (!child || typeof child !== 'object') continue;
    const node = child as Record<string, unknown>;
    const t = node.t as string | undefined;
    if (!t) continue;

    // Root-level children use "server:c[N]"; deeper children use "parent/c[N]"
    const separator = parentPath === 'server' ? ':' : '/';
    const controlPath = `${parentPath}${separator}c[${i}]`;

    if (FIELD_TYPES.has(t)) {
      extractField(node, t, controlPath, result);
    } else if (t === 'ac') {
      extractAction(node, controlPath, result, insideRepeater);
    } else if (t === 'rc') {
      // Collect ALL repeaters (not just the first)
      extractRepeater(node, controlPath, result);
      // Recurse into repeater's children with insideRepeater = true
      const subChildren = node.Children as unknown[] | undefined;
      if (Array.isArray(subChildren)) {
        walkChildren(subChildren, controlPath, result, true);
      }
      continue; // skip the general recursion below
    } else if (t === 'fhc') {
      // FormHostControl: contains a hosted child form (lf node) as first child.
      // Extract it as a discovered child form -- it will be processed separately.
      extractFormHostControl(node, result);
      continue; // don't recurse into fhc children (they belong to the child form)
    } else if (t === 'filc' && result.filterControlPath === null) {
      // FilterLogicalControl — used for Filter(AddLine) interactions
      result.filterControlPath = controlPath;
    }

    // Recurse into Children (gc groups, etc.)
    const subChildren = node.Children as unknown[] | undefined;
    if (Array.isArray(subChildren)) {
      walkChildren(subChildren, controlPath, result, insideRepeater);
    }
  }
}

function extractField(
  node: Record<string, unknown>,
  t: string,
  controlPath: string,
  result: ParsedControlTree,
): void {
  // Skip placeholder fields
  if (node.MappingHint === 'PlaceholderField') return;

  // Skip ssc spacers/decorations: bare static strings with neither caption nor
  // a column binder are layout fillers (e.g. blank rows in card forms).
  if (t === 'ssc' && !node.Caption && !node.ColumnBinder) return;

  // Determine visibility: check direct Visible, then ExpressionProperties.Visible
  let visible = true;
  if (typeof node.Visible === 'boolean') {
    visible = node.Visible;
  } else if (node.ExpressionProperties && typeof node.ExpressionProperties === 'object') {
    const expr = node.ExpressionProperties as Record<string, unknown>;
    if (typeof expr.Visible === 'boolean') {
      visible = expr.Visible;
    }
  }

  const binder = node.ColumnBinder as { Name?: string } | undefined;

  const hasLookup = !!(node.AssistEditAction || node.LookupAction);
  const showMandatory = node.ShowMandatory === true ? true : undefined;

  result.fields.push({
    controlPath,
    caption: (node.Caption as string) ?? '',
    type: t,
    editable: (node.Editable as boolean) ?? false,
    visible,
    stringValue: node.StringValue != null ? String(node.StringValue) : undefined,
    value: node.ObjectValue ?? node.StringValue,
    columnBinderName: binder?.Name || undefined,
    ...(hasLookup ? { isLookup: true } : {}),
    ...(showMandatory !== undefined ? { showMandatory } : {}),
  });
}

function extractAction(
  node: Record<string, unknown>,
  controlPath: string,
  result: ParsedControlTree,
  isLineScoped = false,
): void {
  const icon = node.Icon as { Identifier?: string } | undefined;
  const iconIdentifier = icon?.Identifier;
  const wizardNav = classifyWizardNav(node, iconIdentifier);

  result.actions.push({
    controlPath,
    caption: (node.Caption as string) ?? '',
    systemAction: (node.SystemAction as number) ?? 0,
    enabled: (node.Enabled as boolean) ?? true,
    visible: (node.Visible as boolean) ?? true,
    isLineScoped,
    ...(iconIdentifier ? { iconIdentifier } : {}),
    ...(wizardNav ? { wizardNav } : {}),
  });
}

/**
 * Detect wizard navigation actions (Back / Next / Finish / Cancel) on a
 * NavigatePage. BC's own client classifies these by icon resource — confirmed
 * in `Microsoft.Dynamics.Framework.UI.NavigatePageActionControlHelper.cs`.
 *
 * Two icon naming conventions exist in the wild:
 *   modern: `Actions/PreviousRecord/16.png`, `Actions/NextRecord/16.png`, `Actions/Approve/16.png`
 *   legacy: `Action_PreviousRecord_16x16.png`, `Action_NextRecord_16x16.png`, `Action_Approve_16x16.png`
 *
 * Cancel is not icon-classified by BC; we detect it via SystemAction.Cancel(310)
 * or Abort(320) or the conventional close-action SystemAction 350.
 */
function classifyWizardNav(
  node: Record<string, unknown>,
  iconIdentifier: string | undefined,
): 'back' | 'next' | 'finish' | 'cancel' | undefined {
  if (iconIdentifier) {
    const id = iconIdentifier;
    if (/PreviousRecord/i.test(id)) return 'back';
    if (/NextRecord|Action_Start/i.test(id)) return 'next';
    if (/Approve/i.test(id)) return 'finish';
  }
  const sysAction = node.SystemAction as number | undefined;
  if (sysAction === 310 || sysAction === 320 || sysAction === 350) return 'cancel';
  return undefined;
}

function extractRepeater(
  node: Record<string, unknown>,
  controlPath: string,
  result: ParsedControlTree,
): void {
  const columns: RepeaterColumn[] = [];
  const rccArray = node.Columns as unknown[] | undefined;
  if (Array.isArray(rccArray)) {
    for (let j = 0; j < rccArray.length; j++) {
      const col = rccArray[j] as Record<string, unknown> | undefined;
      if (!col || col.t !== 'rcc') continue;
      // Skip placeholder columns
      if (col.MappingHint === 'PlaceholderField') continue;

      const binder = col.ColumnBinder as { Name?: string; Path?: string } | undefined;
      columns.push({
        controlPath: `${controlPath}/co[${j}]`,
        caption: (col.Caption as string) ?? '',
        type: 'rcc',
        columnBinderName: binder?.Name || undefined,
        columnBinderPath: (col.ColumnBinderPath as string) || binder?.Path || undefined,
      });
    }
  }

  (result.repeaters as Map<string, RepeaterState>).set(controlPath, {
    controlPath,
    columns,
    rows: [],       // Rows come from DataLoaded events, not the control tree
    totalRowCount: null,
    currentBookmark: null,
  });
}

function extractFormHostControl(
  node: Record<string, unknown>,
  result: ParsedControlTree,
): void {
  const children = node.Children as unknown[] | undefined;
  if (!Array.isArray(children) || children.length === 0) return;

  // The first child of an fhc is the lf (LogicalForm) node
  const lf = children[0] as Record<string, unknown> | undefined;
  if (!lf || typeof lf !== 'object') return;

  const serverId = (lf.ServerId as string) ?? '';
  if (!serverId) return;

  result.childForms.push({
    serverId,
    caption: (lf.Caption as string) ?? (node.Caption as string) ?? '',
    controlTree: lf,
    isSubForm: (lf.IsSubForm as boolean) ?? false,
    isPart: (lf.IsPart as boolean) ?? false,
  });
}

/**
 * Non-tab MappingHints at the root gc level (toolbars, action bars, etc.)
 */
const NON_TAB_HINTS = new Set(['TOOLBAR', 'ACTIONBAR', 'PromptActions', 'CommandBarHelpGroup', 'CommandBarLayoutGroup']);

/**
 * Extract tab groups from root-level gc children.
 * A tab gc has a Caption and no MappingHint from the excluded set.
 * Each tab's fields are found by matching controlPath prefixes against result.fields.
 */
function extractTabGroups(
  rootChildren: unknown[],
  result: ParsedControlTree,
): TabGroup[] {
  const tabs: TabGroup[] = [];
  for (let i = 0; i < rootChildren.length; i++) {
    const child = rootChildren[i];
    if (!child || typeof child !== 'object') continue;
    const node = child as Record<string, unknown>;
    if (node.t !== 'gc') continue;
    const caption = node.Caption as string | undefined;
    if (!caption) continue;
    const hint = node.MappingHint as string | undefined;
    if (hint && NON_TAB_HINTS.has(hint)) continue;

    // This gc is a tab. Its fields are those in result.fields whose controlPath
    // starts with "server:c[{i}]/"
    const prefix = `server:c[${i}]/`;
    const fields = result.fields.filter(f => f.controlPath.startsWith(prefix));
    tabs.push({ caption, fields });
  }
  return tabs;
}
