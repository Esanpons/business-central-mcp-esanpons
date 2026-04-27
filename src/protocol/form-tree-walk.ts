// src/protocol/form-tree-walk.ts
import { childrenOf, isGroupNode, type FormNode } from './form-node.js';

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
