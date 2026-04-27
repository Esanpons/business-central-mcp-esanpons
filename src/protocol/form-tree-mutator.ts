// src/protocol/form-tree-mutator.ts
import { childrenOf, isRepeaterNode, type FormNode, type NodeProperties, type RepeaterColumnNode, type RepeaterNode } from './form-node.js';

/** Returns a new tree with the node at `controlPath` having its properties
 * merged with `changes`. Off-path nodes are reused by reference (structural
 * sharing). If `controlPath` is not found, returns the input root unchanged.
 *
 * Recurses into `children` for every container, AND into `columns` for
 * `RepeaterNode` — BC publishes PropertyChanged on column paths
 * (e.g. `…/co[N]`) to update column captions / visibility / etc.
 *
 * Protocol invariant: a PropertyChanged never substitutes a node's type, only
 * its properties. The structural-share rebuild therefore preserves every
 * node's runtime type. */
export function applyPropertyChange(
  root: FormNode,
  controlPath: string,
  changes: NodeProperties,
): FormNode {
  if (root.controlPath === controlPath) {
    return mergeProps(root, changes);
  }

  // Walk children first.
  const kids = childrenOf(root);
  for (let i = 0; i < kids.length; i++) {
    const updated = applyPropertyChange(kids[i]!, controlPath, changes);
    if (updated !== kids[i]) {
      return replaceChild(root, i, updated);
    }
  }

  // RepeaterNode also carries `columns` outside the children array.
  if (isRepeaterNode(root)) {
    const cols = root.columns;
    for (let j = 0; j < cols.length; j++) {
      const updatedCol = applyPropertyChange(cols[j]!, controlPath, changes);
      if (updatedCol !== cols[j]) {
        return replaceColumn(root, j, updatedCol as RepeaterColumnNode);
      }
    }
  }

  return root;  // path not in this subtree
}

function mergeProps(node: FormNode, changes: NodeProperties): FormNode {
  return { ...node, properties: { ...node.properties, ...changes } } as FormNode;
}

function replaceChild(parent: FormNode, index: number, newChild: FormNode): FormNode {
  if (!('children' in parent) || !Array.isArray(parent.children)) {
    throw new Error(
      `replaceChild: parent at controlPath '${parent.controlPath}' has no children array (type=${parent.type}). ` +
      `applyPropertyChange must not recurse into a leaf node.`,
    );
  }
  // All node types with a `children` array share the same rebuild shape. The
  // parent's child-element type is preserved at runtime by the protocol
  // invariant that PropertyChanged never substitutes a node's type.
  const newChildren = parent.children.slice();
  newChildren[index] = newChild as typeof newChildren[number];
  return { ...parent, children: newChildren } as FormNode;
}

function replaceColumn(repeater: RepeaterNode, index: number, newColumn: RepeaterColumnNode): RepeaterNode {
  const newColumns = repeater.columns.slice();
  newColumns[index] = newColumn;
  return { ...repeater, columns: newColumns };
}

/** O(1) controlPath → node lookup index. Build once per root; rebuild when
 * the root is replaced (any tree mutation returns a new root).
 *
 * Includes RepeaterColumnNode entries (which `walkTree` deliberately omits).
 *
 * Last-write-wins on duplicate controlPaths. ControlPaths are unique by
 * construction in BC's protocol, so the duplicate case is a defensive
 * fallback rather than a supported scenario. */
export function buildPathIndex(root: FormNode): ReadonlyMap<string, FormNode> {
  const index = new Map<string, FormNode>();
  function visit(n: FormNode) {
    index.set(n.controlPath, n);
    for (const c of childrenOf(n)) visit(c);
    if (isRepeaterNode(n)) {
      for (const col of n.columns) visit(col);
    }
  }
  visit(root);
  return index;
}
