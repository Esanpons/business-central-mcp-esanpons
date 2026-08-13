// src/protocol/section-dto.ts
//
// MCP output DTO for a single page section. A page is a flat list of sections;
// each section is one of: header (the root form's primary content),
// lines (the document's lines repeater), factbox (a CardPart attached as a
// FactBox), subpage (any other embedded part), requestPage (a report's
// request-page modal). Internal code reads FieldNode/ActionNode via
// form-views.ts; this DTO is the shape exposed to MCP callers.

import type { SectionKind } from './section-resolver.js';
import type { ActionNode, FieldNode, FieldType, FormNode } from './form-node.js';
import { childrenOf, isFieldNode, isGroupNode } from './form-node.js';
import type { GroupVisibility, RepeaterRow, WizardState } from './types.js';
import { resolveSection } from './section-resolver.js';
import {
  fields as treeFields,
  actions as treeActions,
  groupVisibility as treeGroupVisibility,
  cues as treeCues,
} from './form-views.js';
import { mapRowCellKeys, repeaterColumnsToDto } from './row-mapping.js';
import { classifyWizardNav } from './wizard-classify.js';
import type { PageContext } from './page-context.js';

// ---------------------------------------------------------------------------
// Per-root tree index (perf)
//
// Building a Section used to call findByControlPath + ancestorsOf ONCE PER
// captioned field and per action — each of those is a full-tree walk, so a
// document header with 150 fields walked the tree 300+ times. This index is
// built in a single pass and memoised per root reference (the same WeakMap
// discipline as form-views.ts: any tree mutation yields a new root, so the
// cache invalidates itself).
//
// `groupLabel` mirrors form-tree-walk.nearestGroupCaption exactly, including
// BC's Sell-to/Bill-to/Ship-to idiom where an anonymous "Control41" group is
// labelled by a sibling option selector (`sec`). tests/protocol/section-dto.test.ts
// asserts the two stay in agreement.
// ---------------------------------------------------------------------------

const AUTO_GROUP_NAME = /^control\d+$/i;

interface IndexedNode {
  readonly node: FormNode;
  /** controlPaths of every gc ancestor, root -> leaf. */
  readonly groupPaths: readonly string[];
  /** Nearest meaningful enclosing group caption, or undefined. */
  readonly groupCaption?: string;
}

interface GroupFrame {
  readonly path: string;
  /** Human-meaningful label (own caption, or a sibling `sec` selector's caption). */
  readonly label?: string;
  /** Own caption even when auto-generated — the last-resort fallback. */
  readonly ownCaption?: string;
}

const treeIndexCache = new WeakMap<FormNode, ReadonlyMap<string, IndexedNode>>();

/** Label a group node the way nearestGroupCaption does, given its siblings. */
function groupFrame(group: FormNode, siblings: readonly FormNode[]): GroupFrame {
  const own = group.properties.caption?.trim();
  if (own && !AUTO_GROUP_NAME.test(own)) return { path: group.controlPath, label: own, ownCaption: own };
  for (const sib of siblings) {
    if (sib.controlPath === group.controlPath) continue;
    if (!isFieldNode(sib) || sib.type !== 'sec') continue;
    const cap = sib.properties.caption?.trim();
    if (cap && !AUTO_GROUP_NAME.test(cap)) return { path: group.controlPath, label: cap, ownCaption: own };
  }
  return { path: group.controlPath, ...(own ? { ownCaption: own } : {}) };
}

function buildTreeIndex(root: FormNode): ReadonlyMap<string, IndexedNode> {
  const cached = treeIndexCache.get(root);
  if (cached) return cached;

  const index = new Map<string, IndexedNode>();
  const stack: GroupFrame[] = [];

  const resolveCaption = (): string | undefined => {
    for (let i = stack.length - 1; i >= 0; i--) {
      const l = stack[i]!.label;
      if (l) return l;
    }
    for (let i = stack.length - 1; i >= 0; i--) {
      const c = stack[i]!.ownCaption;
      if (c) return c;
    }
    return undefined;
  };

  const visit = (node: FormNode, siblings: readonly FormNode[]): void => {
    const caption = resolveCaption();
    index.set(node.controlPath, {
      node,
      groupPaths: stack.map(f => f.path),
      ...(caption ? { groupCaption: caption } : {}),
    });
    const kids = childrenOf(node);
    if (isGroupNode(node)) {
      stack.push(groupFrame(node, siblings));
      for (const c of kids) visit(c, kids);
      stack.pop();
      return;
    }
    for (const c of kids) visit(c, kids);
  };

  visit(root, [root]);
  treeIndexCache.set(root, index);
  return index;
}

/**
 * Effective visibility from the index. Same semantics as
 * protocol/visibility.ts `isEffectivelyVisible` (ancestor groups gate the
 * subtree; the active wizard step's subtree is visible wholesale), but O(1)
 * per control after the one-pass index build.
 */
function visibleIndexed(
  idx: ReadonlyMap<string, IndexedNode>,
  controlPath: string,
  groupVis: GroupVisibility,
  ws?: WizardState | null,
): boolean {
  const entry = idx.get(controlPath);
  const intrinsic = entry ? (entry.node.properties.visible ?? true) : true;
  const activeStepPath = ws?.stepPaths[ws.currentStepIndex];
  for (const p of entry?.groupPaths ?? []) {
    if (activeStepPath && p === activeStepPath) return true;
    if (groupVis.has(p) && !groupVis.get(p)) return false;
  }
  return intrinsic;
}

export interface SectionField {
  /** Field caption as shown in the BC client. Display label only. */
  readonly name: string;
  /**
   * Stable control path (e.g. "server:c[4]/c[1]/c[1]/c[0]"). Unique per control
   * even when several fields share the same caption. Pass it straight back as
   * the field key to bc_write_data / bc_read_data to target this exact control,
   * bypassing caption ambiguity.
   */
  readonly controlPath: string;
  /**
   * Caption of the innermost enclosing group (e.g. "Bill-to", "Ship-to"),
   * when the field sits inside one. Disambiguates duplicate captions: the three
   * `Name` controls on a Sales Quote header differ only by this group.
   */
  readonly group?: string;
  /** Display string. Undefined for fields that have no string projection (e.g. boolean tristate). */
  readonly value?: string;
  /**
   * Tri-state editability. `true`/`false` reflect what BC reported; `"unknown"`
   * means BC has not (yet) emitted an Editable flag for this control. Page
   * variables backing option controls (Ship-to / Bill-to selectors) frequently
   * arrive as `"unknown"` yet ARE writable -- do not treat `"unknown"` as
   * read-only. After a write, trust the `changed` flag from bc_write_data over
   * this hint (P2/P6).
   */
  readonly editable: boolean | 'unknown';
  /** Wire-level BC field type. See FieldType union in protocol/form-node.ts. */
  readonly type: FieldType;
  /**
   * Allowed choices for an option/enum (`sec`) or boolean (`bc`) control, in wire
   * order. Present only when BC published an `Items` array. Write one of these
   * texts back with bc_write_data — guessing an option value is the usual cause of
   * a silent `changed:false`.
   */
  readonly options?: readonly string[];
  /** The currently selected entry of `options`, when BC published a CurrentIndex. */
  readonly selectedOption?: string;
  /** True if BC marked the field as mandatory. */
  readonly showMandatory?: boolean;
  /** True if the field has an AssistEdit/Lookup action attached. */
  readonly isLookup?: boolean;
}

export interface SectionAction {
  /** Action caption as shown in the BC client. */
  readonly name: string;
  /** SystemAction ordinal. See SystemAction enum in protocol/types.ts. 0 = no system role (custom AL action). */
  readonly systemAction: number;
  /**
   * Whether BC currently allows the action to be invoked. `false` means the
   * action EXISTS on this page but is greyed out right now (unmet precondition,
   * wrong document status, read-only record) — invoking it returns
   * "Action is disabled". Both states are listed: an action missing from the list
   * altogether is a different problem from one that is merely disabled.
   */
  readonly enabled: boolean;
  /**
   * True when the action lives inside a repeater subtree — a row command, not a
   * page command. It operates on the CURRENT row, so a row must be selected
   * (bookmark/rowIndex) before invoking it or BC acts on whatever row it happens
   * to have. Repeater header actions (the `ha[N]` path segment) are the common
   * case; they only became visible here once the builder started parsing them.
   */
  readonly isLineScoped?: boolean;
  /** Wizard role on a NavigatePage / StandardDialog. */
  readonly wizardNav?: 'back' | 'next' | 'finish' | 'cancel';
}

export interface SectionCue {
  /** Cue tile caption — used as the cue identifier for bc_execute_action. */
  readonly name: string;
  /** Display value (the count). May be empty initially before LoadForm populates StringValue. */
  readonly value: string;
  /** Group caption (e.g. "Ongoing Sales"). Helps the LLM frame the cue. */
  readonly groupCaption?: string;
  /** Tooltip text from the AL source. */
  readonly synopsis?: string;
  /** True when the cue supports drill-down (HasAction on the wire). */
  readonly hasAction: boolean;
}

/**
 * Row inside a list-shape Section. Identical to the internal `RepeaterRow`
 * type — cells keyed by `columnBinderName` (e.g. "1165569367_c2"), not by
 * caption.
 */
export type SectionRow = RepeaterRow;

export interface Section {
  readonly sectionId: string;
  readonly kind: SectionKind;
  readonly caption: string;
  /**
   * Card-shape sections (header, factbox, requestPage, most subpages) carry
   * `fields[]` populated with visible, captioned fields.
   */
  readonly fields?: readonly SectionField[];
  /**
   * List-shape sections (lines, list-bodied subpages) carry `rows[]`.
   * `totalRowCount` reflects BC's TotalRowCount property; null when unknown.
   */
  readonly rows?: readonly SectionRow[];
  readonly totalRowCount?: number | null;
  readonly actions?: readonly SectionAction[];
  /** Populated when the section's form contains cuegroup tiles. */
  readonly cues?: readonly SectionCue[];
}

/**
 * Every captioned field that is effectively visible on `root`, in tree order.
 * Shared by the Section builder and by the operations that echo a form's fields
 * back (execute-action, wizard-navigate) so all three agree on what "visible"
 * means and all three pay ONE tree walk instead of one per field.
 */
export function visibleCaptionedFields(root: FormNode, ws?: WizardState | null): readonly FieldNode[] {
  const idx = buildTreeIndex(root);
  const groupVis = treeGroupVisibility(root);
  return treeFields(root).filter(f => f.properties.caption && visibleIndexed(idx, f.controlPath, groupVis, ws));
}

/** Every captioned action that is effectively visible on `root` (enabled or not). */
export function visibleCaptionedActions(root: FormNode, ws?: WizardState | null): readonly ActionNode[] {
  const idx = buildTreeIndex(root);
  const groupVis = treeGroupVisibility(root);
  return treeActions(root).filter(a => a.properties.caption && visibleIndexed(idx, a.controlPath, groupVis, ws));
}

/**
 * Build the Section DTO for `sectionId` in `ctx`. Returns `null` when the
 * sectionId is unknown or the section has been invalidated.
 *
 * Card-shape sections emit `fields[]` (and `actions[]` for header sections);
 * list-shape sections emit `rows[]` and `totalRowCount`. Header sections
 * always include `actions[]` because actions are reachable only from the root
 * form.
 */
export function buildSection(ctx: PageContext, sectionId: string): Section | null {
  const resolved = resolveSection(ctx, sectionId);
  if ('error' in resolved) return null;
  const { section, form, repeater, rows } = resolved;

  const isHeader = section.kind === 'header';

  const root = form.root;
  const groupVis = treeGroupVisibility(root);
  const ws = ctx.wizardState;

  const out: {
    sectionId: string;
    kind: typeof section.kind;
    caption: string;
    fields?: SectionField[];
    rows?: SectionRow[];
    totalRowCount?: number | null;
    actions?: SectionAction[];
    cues?: SectionCue[];
  } = {
    sectionId: section.sectionId,
    kind: section.kind,
    caption: section.caption,
  };

  const idx = buildTreeIndex(root);

  if (repeater) {
    // TODO(tier-2/T25): replace mapRowCellKeys adapter with direct tree-node reads
    out.rows = mapRowCellKeys([...rows], repeaterColumnsToDto(repeater))
      .map(r => ({ bookmark: r.bookmark, cells: r.cells }));
    out.totalRowCount = repeater.properties.totalRowCount ?? null;
  } else {
    out.fields = treeFields(root)
      .filter(f => f.properties.caption && visibleIndexed(idx, f.controlPath, groupVis, ws))
      .map(f => {
        const group = idx.get(f.controlPath)?.groupCaption;
        return {
          name: f.properties.caption!,
          controlPath: f.controlPath,
          ...(group ? { group } : {}),
          value: f.properties.stringValue,
          editable: f.properties.editable === undefined ? ('unknown' as const) : f.properties.editable,
          type: f.type,
          ...(f.properties.options ? { options: f.properties.options.map(o => o.text) } : {}),
          ...(f.properties.options && f.properties.optionIndex !== undefined && f.properties.optionIndex >= 0
            ? { selectedOption: f.properties.options[f.properties.optionIndex]?.text }
            : {}),
          ...(f.properties.showMandatory ? { showMandatory: true as const } : {}),
          ...(f.hasLookup ? { isLookup: true as const } : {}),
        };
      });
  }

  if (isHeader) {
    // Disabled actions are surfaced too, with `enabled: false`. Filtering them out
    // and then reporting `enabled: true` for everything left made the field a
    // constant: an agent could not tell "this action does not exist on this page"
    // (retry differently) from "it exists but BC has it greyed out right now"
    // (satisfy its precondition first).
    out.actions = treeActions(root)
      .filter(a => a.properties.caption && visibleIndexed(idx, a.controlPath, groupVis, ws))
      .map(a => {
        const wn = classifyWizardNav(a);
        return {
          name: a.properties.caption!,
          systemAction: a.systemAction,
          enabled: a.properties.enabled ?? true,
          ...(a.isLineScoped ? { isLineScoped: true } : {}),
          ...(wn ? { wizardNav: wn } : {}),
        };
      });
  }

  const cueList = treeCues(root);
  if (cueList.length > 0) {
    out.cues = cueList.map(c => ({
      name: c.caption,
      value: c.value,
      ...(c.groupCaption ? { groupCaption: c.groupCaption } : {}),
      ...(c.synopsis ? { synopsis: c.synopsis } : {}),
      hasAction: c.hasAction,
    }));
  }

  return out as Section;
}

const SECTION_KIND_ORDER: Record<SectionKind, number> = {
  header: 0,
  // Right after the header: while a dialog is open it is the only thing BC will
  // accept input on, so it belongs near the top — but NOT at position 0, because
  // existing callers read sections[0] as "the header" and a dialog is transient.
  dialog: 1,
  lines: 2,
  subpage: 3,
  factbox: 4,
  requestPage: 5,
};

/**
 * Emit every valid section in `ctx` in canonical order: header, lines,
 * subpages, factboxes, requestPage. Returns an empty array for a context
 * with no sections (defensive — should not occur in practice).
 */
export function buildAllSections(ctx: PageContext): Section[] {
  const out: Section[] = [];
  const ordered = Array.from(ctx.sections.values())
    .filter(s => s.valid)
    .sort((a, b) => SECTION_KIND_ORDER[a.kind] - SECTION_KIND_ORDER[b.kind]);
  for (const desc of ordered) {
    const built = buildSection(ctx, desc.sectionId);
    if (built !== null) out.push(built);
  }
  return out;
}
