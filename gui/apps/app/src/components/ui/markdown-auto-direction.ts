interface HastNode {
  type: string;
  tagName?: string;
  properties?: Record<string, unknown>;
  children?: HastNode[];
}

// Outermost text blocks pick their direction from their first strong
// character, so an Arabic, Persian or Hebrew paragraph, list, quote or table
// reads right-to-left
// and an English one left-to-right. Only the outermost block gets dir="auto":
// a child with its own dir would be skipped by the parent's detection, and
// inheriting keeps list markers, quote borders and table columns on the same
// side as the text. Code stays left-to-right.
const AUTO_DIRECTION_TAGS = new Set([
  "p",
  "ul",
  "ol",
  "h1",
  "h2",
  "h3",
  "h4",
  "h5",
  "h6",
  "blockquote",
  "table",
]);

function visit(node: HastNode, insideDirectedBlock: boolean): void {
  let inside = insideDirectedBlock;
  if (node.type === "element" && node.tagName !== undefined) {
    if (node.tagName === "pre" || node.tagName === "code") return;
    if (!inside && AUTO_DIRECTION_TAGS.has(node.tagName)) {
      node.properties ??= {};
      node.properties.dir ??= "auto";
      inside = true;
    }
  }
  for (const child of node.children ?? []) visit(child, inside);
}

export function rehypeAutoDirection() {
  return (tree: HastNode) => {
    visit(tree, false);
  };
}
