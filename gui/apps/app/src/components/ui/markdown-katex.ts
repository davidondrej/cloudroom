import katex, { type KatexOptions } from "katex";
import rehypeRaw from "rehype-raw";
import "katex/dist/katex.min.css";

// Our own rehype-katex: render `math-inline`, `math-display`, and
// `language-math` elements with KaTeX. rehype-raw supplies the HTML parser and
// the hast types, so this adds no packages.
type Root = Parameters<ReturnType<typeof rehypeRaw>>[0];
type VFile = Parameters<ReturnType<typeof rehypeRaw>>[1];
type Element = Extract<Root["children"][number], { type: "element" }>;
type Content = Element["children"][number];
type Parent = Root | Element;
type Options = Omit<KatexOptions, "displayMode" | "throwOnError">;

// hast-util-to-text's rules for elements that render no text or a line break.
const NOT_RENDERED = new Set(
  "datalist head noembed noframes noscript rp script style template title".split(
    " ",
  ),
);
const BLOCKS = new Set(
  "address article aside blockquote body caption center dd dialog dir div dl dt figcaption figure footer h1 h2 h3 h4 h5 h6 header hgroup hr html legend li listing main menu nav ol p plaintext pre section ul xmp".split(
    " ",
  ),
);

// No file on purpose: KaTeX's HTML has no place in the markdown source, so its
// nodes get no positions, like rehype-katex's.
const parseHtml = rehypeRaw();
const NO_FILE = undefined as unknown as VFile;

function parseKatexHtml(html: string): Content[] {
  return parseHtml(
    { type: "root", children: [{ type: "raw", value: html }] },
    NO_FILE,
  ).children as Content[];
}

// The TeX source, read like hast-util-to-text with `whitespace: "pre"`: text
// as-is, line breaks around blocks and after `<br>` and table rows, tabs
// between table cells.
function mathText(scope: Element): string {
  const items: (string | number)[] = [];
  const collect = (parent: Element): void => {
    parent.children.forEach((node, index) => {
      if (node.type === "text") items.push(node.value);
      if (
        node.type !== "element" ||
        NOT_RENDERED.has(node.tagName) ||
        node.properties.hidden ||
        (node.tagName === "dialog" && !node.properties.open)
      ) {
        return;
      }
      const tag = node.tagName;
      const followedBy = (tags: string[]): boolean =>
        parent.children
          .slice(index + 1)
          .some(
            (next) => next.type === "element" && tags.includes(next.tagName),
          );
      const lines = tag === "p" ? 2 : BLOCKS.has(tag) ? 1 : 0;
      if (lines) items.push(lines);
      collect(node);
      if ((tag === "td" || tag === "th") && followedBy(["td", "th"])) {
        items.push("\t");
      }
      if (tag === "br" || (tag === "tr" && followedBy(["tr"]))) {
        items.push("\n");
      } else if (lines) {
        items.push(lines);
      }
    });
  };
  collect(scope);
  let text = "";
  let breaks: number | undefined;
  for (const item of items) {
    if (typeof item === "number") {
      if (breaks !== undefined) breaks = Math.max(breaks, item);
    } else if (item) {
      text += "\n".repeat(breaks ?? 0) + item;
      breaks = 0;
    }
  }
  return text;
}

export default function rehypeKatex(options?: Readonly<Options> | null) {
  const settings = options ?? {};
  return (tree: Root, file: VFile): undefined => {
    function render(
      scope: Element,
      element: Element,
      ancestors: Parent[],
      displayMode: boolean,
    ): Content[] {
      const value = mathText(scope);
      let html: string;
      try {
        html = katex.renderToString(value, {
          ...settings,
          displayMode,
          throwOnError: true,
        });
      } catch (error) {
        const cause = error as Error;
        file.message("Could not render math with KaTeX", {
          ancestors: [...ancestors, element],
          cause,
          place: element.position,
          ruleId: cause.name.toLowerCase(),
          source: "rehype-katex",
        });
        try {
          html = katex.renderToString(value, {
            ...settings,
            displayMode,
            strict: "ignore",
            throwOnError: false,
          });
        } catch {
          // KaTeX's own error markup, for errors it does not handle itself.
          return [
            {
              type: "element",
              tagName: "span",
              properties: {
                className: ["katex-error"],
                style: `color:${settings.errorColor || "#cc0000"}`,
                title: String(error),
              },
              children: [{ type: "text", value }],
            },
          ];
        }
      }
      return parseKatexHtml(html);
    }

    // Replaces math elements under `parent`. Returns the replacement for
    // `parent` itself, and stops, when it is a `<pre>` around ```math code.
    function visit(parent: Parent, ancestors: Parent[]): Content[] | null {
      const path = [...ancestors, parent];
      for (let index = 0; index < parent.children.length;) {
        const node = parent.children[index]!;
        let replacement: Content[] | null = null;
        if (node.type === "element") {
          const classes = Array.isArray(node.properties.className)
            ? node.properties.className
            : [];
          const languageMath = classes.includes("language-math");
          const display = classes.includes("math-display");
          if (languageMath || display || classes.includes("math-inline")) {
            const fenced =
              languageMath &&
              node.tagName === "code" &&
              parent.type === "element" &&
              parent.tagName === "pre";
            replacement = render(
              fenced ? parent : node,
              node,
              path,
              display || fenced,
            );
            if (fenced) return replacement;
          } else {
            replacement = visit(node, path);
          }
        }
        if (replacement === null) {
          index += 1;
        } else {
          parent.children.splice(index, 1, ...replacement);
          index += replacement.length;
        }
      }
      return null;
    }

    visit(tree, []);
  };
}
