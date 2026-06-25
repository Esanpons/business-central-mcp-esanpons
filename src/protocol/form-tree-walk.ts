// src/protocol/form-tree-walk.ts
import { childrenOf, isGroupNode, isFieldNode, type FormNode } from './form-node.js';

// BC auto-names anonymous group() containers as "Control<NN>" when the AL source
// gives them no caption. Such a caption is useless for disambiguation, so we
// treat it as "unnamed" and derive a human label from the labeling option
// selector instead (the Sell-to / Bill-to / Ship-to idiom).
const AUTO_GROUP_NAME = /^control\d+$/i;

/** Pre-order traversal of the tree, yielding every node including the root. */
export function* walkTree(root: FormNode): Generator<FormNode> {
  yield root;
  for (const child of childrenOf(root)) {
    yield* walkTree(child);
  }
}

/** O(n) lookup. For repeated lookups, prefer buildPathIndex (see form-tree-mutator). */
export function findByControlPath(root: FormNode, controlPath: string): FormNode | undefined {
  for (const node of walkTree(root)) {
    if (node.controlPath === controlPath) return node;
  }
  return undefined;
}

/** Returns the node's parent (or undefined for root), and the index of the node
 * within the parent's children. Used by the mutator to rebuild the path. */
export function parentOf(root: FormNode, controlPath: string): { parent: FormNode; index: number } | undefined {
  function visit(node: FormNode): { parent: FormNode; index: number } | undefined {
    const kids = childrenOf(node);
    for (let i = 0; i < kids.length; i++) {
      if (kids[i]!.controlPath === controlPath) return { parent: node, index: i };
      const found = visit(kids[i]!);
      if (found) return found;
    }
    return undefined;
  }
  return visit(root);
}

/** Returns the chain of ancestors from root down to (but not including) the
 * target node, in document order. Empty when the target is the root or absent. */
export function ancestorsOf(root: FormNode, controlPath: string): readonly FormNode[] {
  function visit(node: FormNode, trail: FormNode[]): readonly FormNode[] | undefined {
    if (node.controlPath === controlPath) return trail;
    for (const child of childrenOf(node)) {
      const found = visit(child, [...trail, node]);
      if (found) return found;
    }
    return undefined;
  }
  return visit(root, []) ?? [];
}

const ancestorGroupPathsCache = new WeakMap<FormNode, Map<string, readonly string[]>>();

/** Returns the gc-only ancestor controlPaths for the node at controlPath.
 * Memoised per root; same root reference returns the same array reference. */
export function ancestorGroupPaths(root: FormNode, controlPath: string): readonly string[] {
  let cache = ancestorGroupPathsCache.get(root);
  if (!cache) { cache = new Map(); ancestorGroupPathsCache.set(root, cache); }
  const cached = cache.get(controlPath);
  if (cached) return cached;
  const result = ancestorsOf(root, controlPath).filter(n => isGroupNode(n)).map(n => n.controlPath);
  cache.set(controlPath, result);
  return result;
}

/**
 * Caption of the innermost (closest) enclosing group with a non-empty caption,
 * or undefined when the field sits in no captioned group. This is what
 * disambiguates fields sharing a caption across groups -- e.g. the three
 * `Name` controls on a Sales Quote header belong to the "Sell-to", "Bill-to"
 * and "Ship-to" groups respectively. Walks the gc ancestors leaf->root and
 * returns the first non-blank caption.
 */
export function nearestGroupCaption(root: FormNode, controlPath: string): string | undefined {
  const groups = ancestorsOf(root, controlPath).filter(n => isGroupNode(n));
  // innermost -> outermost
  for (let i = groups.length - 1; i >= 0; i--) {
    const g = groups[i]!;
    const cap = g.properties.caption?.trim();
    // A real, human-meaningful group caption wins immediately (e.g. "Sell-to").
    if (cap && !AUTO_GROUP_NAME.test(cap)) return cap;
    // Auto-named / unnamed group ("Control41"): the human label is usually carried
    // by an OPTION-SELECTOR field (wire type `sec`) that is a SIBLING of this group
    // in the parent container — BC's Sell-to/Bill-to/Ship-to idiom puts a `Bill-to`
    // option control next to the address sub-group. We only borrow the caption of
    // such a selector (not any field), so ordinary string fields like "Address" or
    // "Name" never get mistaken for a group label. Prefer this over climbing to the
    // enclosing FastTab.
    const parent = parentOf(root, g.controlPath)?.parent;
    if (parent && 'children' in parent) {
      for (const child of (parent as { children: readonly FormNode[] }).children) {
        if (child.controlPath === g.controlPath) continue;
        if (isFieldNode(child) && child.type === 'sec') {
          const fcap = child.properties.caption?.trim();
          if (fcap && !AUTO_GROUP_NAME.test(fcap)) return fcap;
        }
      }
    }
  }
  // Fallback: any non-empty caption (innermost first), even an auto-name, so a
  // field is never left with no group rather than a useless one.
  for (let i = groups.length - 1; i >= 0; i--) {
    const cap = groups[i]!.properties.caption?.trim();
    if (cap) return cap;
  }
  return undefined;
}

/**
 * Resolve a FieldNode by group + caption: find the field whose caption matches
 * `fieldCaption` (case-insensitive) AND whose nearest captioned ancestor group
 * matches `group` (case-insensitive). Returns undefined when no unique-enough
 * match exists. Used by bc_write_data / bc_read_data `group` targeting to pick
 * the right control among duplicate captions.
 */
export function findFieldByGroupCaption(
  root: FormNode,
  group: string,
  fieldCaption: string,
): FormNode | undefined {
  const wantGroup = group.trim().toLowerCase();
  const wantField = fieldCaption.trim().toLowerCase();
  for (const node of walkTree(root)) {
    const cap = node.properties.caption;
    if (!cap || cap.trim().toLowerCase() !== wantField) continue;
    const g = nearestGroupCaption(root, node.controlPath);
    if (g && g.trim().toLowerCase() === wantGroup) return node;
  }
  return undefined;
}
