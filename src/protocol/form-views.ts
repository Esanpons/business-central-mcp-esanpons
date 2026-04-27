// src/protocol/form-views.ts
//
// Memoised derived views over a FormNode tree. Cached per-root via WeakMap;
// any tree mutation produces a new root, so cache invalidation is automatic.

import {
  isFieldNode, isActionNode, isRepeaterNode, isGroupNode, isLogicalFormNode,
  type ActionNode, type FieldNode, type FormNode, type RepeaterNode,
} from './form-node.js';
import { walkTree } from './form-tree-walk.js';

const NON_TAB_HINTS = new Set(['TOOLBAR', 'ACTIONBAR', 'PromptActions', 'CommandBarHelpGroup', 'CommandBarLayoutGroup']);

const fieldsCache = new WeakMap<FormNode, FieldNode[]>();
const actionsCache = new WeakMap<FormNode, ActionNode[]>();
const repeatersCache = new WeakMap<FormNode, ReadonlyMap<string, RepeaterNode>>();
const tabsCache = new WeakMap<FormNode, TabView[]>();
const groupVisibilityCache = new WeakMap<FormNode, ReadonlyMap<string, boolean>>();

export interface TabView {
  readonly caption: string;
  readonly controlPath: string;
  readonly fields: readonly FieldNode[];
}

export function fields(root: FormNode): readonly FieldNode[] {
  const cached = fieldsCache.get(root);
  if (cached) return cached;
  const result: FieldNode[] = [];
  for (const n of walkTree(root)) if (isFieldNode(n)) result.push(n);
  fieldsCache.set(root, result);
  return result;
}

export function actions(root: FormNode): readonly ActionNode[] {
  const cached = actionsCache.get(root);
  if (cached) return cached;
  const result: ActionNode[] = [];
  for (const n of walkTree(root)) if (isActionNode(n)) result.push(n);
  actionsCache.set(root, result);
  return result;
}

export function repeaters(root: FormNode): ReadonlyMap<string, RepeaterNode> {
  const cached = repeatersCache.get(root);
  if (cached) return cached;
  const map = new Map<string, RepeaterNode>();
  for (const n of walkTree(root)) if (isRepeaterNode(n)) map.set(n.controlPath, n);
  repeatersCache.set(root, map);
  return map;
}

export function tabs(root: FormNode): readonly TabView[] {
  const cached = tabsCache.get(root);
  if (cached) return cached;
  if (!isLogicalFormNode(root)) {
    tabsCache.set(root, []);
    return [];
  }
  const result: TabView[] = [];
  for (const child of root.children) {
    if (!isGroupNode(child)) continue;
    const caption = child.properties.caption;
    if (!caption) continue;
    const hint = child.properties.mappingHint;
    if (hint && NON_TAB_HINTS.has(hint)) continue;
    const tabFields: FieldNode[] = [];
    for (const n of walkTree(child)) if (isFieldNode(n)) tabFields.push(n);
    result.push({ caption, controlPath: child.controlPath, fields: tabFields });
  }
  tabsCache.set(root, result);
  return result;
}

export function groupVisibility(root: FormNode): ReadonlyMap<string, boolean> {
  const cached = groupVisibilityCache.get(root);
  if (cached) return cached;
  const map = new Map<string, boolean>();
  for (const n of walkTree(root)) {
    if (isGroupNode(n)) map.set(n.controlPath, n.properties.visible ?? true);
  }
  groupVisibilityCache.set(root, map);
  return map;
}

export function filterControlPath(root: FormNode): string | null {
  for (const n of walkTree(root)) {
    if (n.type === 'filc') return n.controlPath;
  }
  return null;
}
