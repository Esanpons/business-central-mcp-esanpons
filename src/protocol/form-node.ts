// src/protocol/form-node.ts
//
// Reactive tree representation of a BC LogicalForm. Every node has a
// canonical controlPath; PropertyChanged events update node properties in
// place. Derived views (fields, actions, tabs, repeaters, groupVisibility)
// are memoised pure functions over this tree.
//
// References: Microsoft.Dynamics.Framework.UI.Client.LogicalControlSerializer.cs
// for the wire-format property names; Microsoft.Dynamics.Nav.Types.Metadata.PageType.cs
// for the PageType enum.

import type { PageType } from './types.js';

/**
 * Generic property bag — append-only union of every BC LogicalControl property
 * we care to surface. Adding a new property never requires a new node type.
 *
 * Properties only meaningful on specific nodes (`bookmark` / `totalRowCount`
 * on RepeaterNode, `mappingHint` on most container types, `hasFiltersApplied`
 * on FilterNode) live here for uniformity. Consumers should know which
 * properties to read on which node type.
 */
export interface NodeProperties {
  readonly caption?: string;
  readonly visible?: boolean;
  readonly editable?: boolean;
  readonly enabled?: boolean;
  readonly stringValue?: string;
  readonly objectValue?: unknown;
  readonly showCaption?: boolean;
  readonly showMandatory?: boolean;
  readonly mappingHint?: string;
  readonly designName?: string;
  readonly controlIdentifier?: string;
  readonly totalRowCount?: number;
  readonly bookmark?: string;
  readonly hasFiltersApplied?: boolean;
}

interface NodeBase<T extends string> {
  readonly type: T;
  readonly controlPath: string;
  readonly properties: NodeProperties;
}

export interface LogicalFormNode extends NodeBase<'lf'> {
  readonly serverId: string;
  readonly pageType: PageType;
  readonly children: readonly FormNode[];
  /**
   * Source object metadata published by BC: `id` is the page object ID;
   * `sourceTableId` is the table this page reads from. Both come from the
   * `Metadata` object in the wire `lf` node.
   */
  readonly metadata?: { readonly id: number; readonly sourceTableId: number };
}

export interface GroupNode extends NodeBase<'gc'> {
  readonly children: readonly FormNode[];
}

export type FieldType = 'sc' | 'dc' | 'bc' | 'dtc' | 'i32c' | 'sec' | 'pc' | 'ssc';

export interface FieldNode extends NodeBase<FieldType> {
  readonly columnBinder?: { readonly name: string; readonly path?: string };
  readonly hasLookup?: boolean;
}

export interface ActionNode extends NodeBase<'ac'> {
  readonly systemAction: number;
  readonly iconIdentifier?: string;
  readonly children: readonly ActionNode[];   // sub-action menus
  readonly isLineScoped: boolean;             // inside a repeater subtree
}

export interface RepeaterNode extends NodeBase<'rc'> {
  readonly columns: readonly RepeaterColumnNode[];
  readonly children: readonly FormNode[];     // row-cell field templates
}

export interface RepeaterColumnNode extends NodeBase<'rcc'> {
  readonly columnBinder?: { readonly name: string; readonly path?: string };
}

export interface FormHostNode extends NodeBase<'fhc'> {
  /** ServerId of the hosted child form. The child form is its own FormState. */
  readonly hostedFormServerId: string;
  readonly hostedFormCaption: string;
  readonly hostedFormIsSubForm: boolean;
  readonly hostedFormIsPart: boolean;
  /**
   * Raw `lf` JSON node of the hosted child form (as it arrived on the wire,
   * before parsing). Handed to `PageContextRepository.registerDiscoveredChildForm`
   * which builds a separate FormState for the child.
   */
  readonly hostedFormControlTree: unknown;
}

export interface FilterNode extends NodeBase<'filc'> {
  readonly children: readonly FormNode[];
}

/**
 * Catch-all for protocol nodes the parser does not specifically model. The
 * `__unknown` brand keeps the discriminated union disjoint from the named
 * node types, so `switch (node.type)` statements get exhaustive narrowing
 * (the `default:` branch stays a true `never` after every named case is
 * handled).
 */
export interface UnknownNode extends NodeBase<string> {
  readonly __unknown: true;
  readonly children: readonly FormNode[];
}

export type FormNode =
  | LogicalFormNode
  | GroupNode
  | FieldNode
  | ActionNode
  | RepeaterNode
  | RepeaterColumnNode
  | FormHostNode
  | FilterNode
  | UnknownNode;

export const FIELD_TYPES: ReadonlySet<FieldType> = new Set<FieldType>([
  'sc', 'dc', 'bc', 'dtc', 'i32c', 'sec', 'pc', 'ssc',
]);

export function isFieldNode(node: FormNode): node is FieldNode {
  // Set.has() is typed (value: FieldType) => boolean, but at runtime it accepts
  // any value and returns false for non-members. The membership check is what
  // proves the narrowing — the cast is only there to satisfy the declared
  // signature.
  return FIELD_TYPES.has(node.type as FieldType);
}

export function isGroupNode(node: FormNode): node is GroupNode {
  return node.type === 'gc';
}

export function isActionNode(node: FormNode): node is ActionNode {
  return node.type === 'ac';
}

export function isRepeaterNode(node: FormNode): node is RepeaterNode {
  return node.type === 'rc';
}

export function isLogicalFormNode(node: FormNode): node is LogicalFormNode {
  return node.type === 'lf';
}

export function isFormHostNode(node: FormNode): node is FormHostNode {
  return node.type === 'fhc';
}

/**
 * Returns the node's `children` array, or `[]` for leaves (FieldNode,
 * RepeaterColumnNode, FormHostNode). NOTE: this does NOT include
 * `RepeaterNode.columns` — generic walkers must visit columns separately.
 */
export function childrenOf(node: FormNode): readonly FormNode[] {
  if ('children' in node) return node.children;
  return [];
}
