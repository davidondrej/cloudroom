import type { PhrasingContent, Root } from "mdast";
import { visit } from "unist-util-visit";

export function remarkLineBreaks() {
  return (tree: Root): void => {
    visit(tree, "text", (node, index, parent) => {
      if (index === undefined || parent === undefined) return;

      const lines = node.value.split(/\r\n|\r|\n/);
      if (lines.length === 1) return;

      const replacements: PhrasingContent[] = [];
      for (const [lineIndex, value] of lines.entries()) {
        if (lineIndex > 0) replacements.push({ type: "break" });
        if (value) replacements.push({ type: "text", value });
      }

      parent.children.splice(index, 1, ...replacements);
      return index + replacements.length;
    });
  };
}
