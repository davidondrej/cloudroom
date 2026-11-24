import type { Nodes, Parent, RootContent } from "mdast";

/** A visitor returns this to stop the walk. */
export const EXIT = false;

type VisitResult = typeof EXIT | number | undefined | void;
type Visitor<Node> = (
  node: Node,
  index: number | undefined,
  parent: Parent | undefined,
) => VisitResult;

/**
 * Walks an mdast tree depth-first, each node before its children, as
 * unist-util-visit does. Pass a node type to visit only those nodes. A visitor
 * returns EXIT to stop, or, after editing `parent.children`, the index of the
 * sibling to visit next.
 */
export function visit<Type extends Nodes["type"]>(
  tree: Nodes,
  type: Type,
  visitor: Visitor<Extract<Nodes, { type: Type }>>,
): void;
export function visit(tree: Nodes, visitor: Visitor<Nodes>): void;
export function visit(
  tree: Nodes,
  ...args: [type: string, visitor: Visitor<Nodes>] | [visitor: Visitor<Nodes>]
): void {
  const type = args.length === 2 ? args[0] : undefined;
  const visitor = args.length === 2 ? args[1] : args[0];
  walk(tree);

  function walk(node: Nodes, parent?: Parent): VisitResult {
    let result: VisitResult;
    if (type === undefined || node.type === type) {
      const index = parent?.children.indexOf(node as RootContent);
      result = visitor(node, index, parent);
      if (result === EXIT) return EXIT;
    }
    if ("children" in node && node.children) {
      // Reads `children` on every step: visitors may splice it.
      for (let index = 0; index > -1 && index < node.children.length;) {
        const next = walk(node.children[index], node);
        if (next === EXIT) return EXIT;
        index = typeof next === "number" ? next : index + 1;
      }
    }
    return result;
  }
}
