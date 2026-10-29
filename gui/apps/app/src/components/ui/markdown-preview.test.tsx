// @vitest-environment jsdom

import {
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { highlightMarkdownCode } from "./markdown-code-highlight";
import { MarkdownPreview } from "./markdown-preview";
import {
  MarkdownLocalFileContextMenuContext,
  type MarkdownLinkRouting,
} from "./markdown-link-routing";

const workspaceLinkRouting = {
  localFile: {
    absoluteLinks: {
      kind: "trusted-host",
    },
    relativeLinks: {
      baseDir: "/workspace",
      rootPath: "/workspace",
    },
    onOpenLink: vi.fn(() => true),
  },
} satisfies MarkdownLinkRouting;

afterEach(() => {
  cleanup();
  window.localStorage.clear();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  vi.clearAllMocks();
});

function requireElement(container: ParentNode, selector: string): Element {
  const element = container.querySelector(selector);
  if (element === null) {
    throw new Error(`Expected an element matching ${selector}`);
  }
  return element;
}

describe("MarkdownPreview", () => {
  it("keeps the starting number of an ordered list", () => {
    const { container } = render(
      <MarkdownPreview content={"> 2. What happens if debt is unpaid?"} />,
    );

    expect(container.querySelector("ol")?.getAttribute("start")).toBe("2");
  });

  it("widens the ordered list gutter for two-digit numbers", () => {
    const { container } = render(
      <MarkdownPreview
        content={"1. One\n\nText\n\n20. Twenty\n\nText\n\n9. Nine\n10. Ten"}
      />,
    );
    const paddings = Array.from(
      container.querySelectorAll("ol"),
      (list) => list.style.paddingLeft,
    );

    expect(paddings).toEqual([
      "",
      "calc(1ch + 1.25rem)",
      "calc(1ch + 1.25rem)",
    ]);
  });

  it("HTML-escapes fenced code so it cannot inject markup", () => {
    const { container } = render(
      <MarkdownPreview
        content={'```ts\nconst html = "<script>alert(1)</script>";\n```'}
      />,
    );
    expect(container.querySelector("script")).toBeNull();
    expect(container.textContent).toContain("<script>alert(1)</script>");
  });

  it("keeps highlighted code DOM until the code text changes", () => {
    const fence = "```ts\nconst a = 1;\n```";
    const view = render(<MarkdownPreview content={`${fence}\n\nPara one.`} />);
    const code = requireElement(view.container, "pre code");
    const line = requireElement(code, "span.sh__line");
    const observer = new MutationObserver(() => {});
    observer.observe(code, {
      characterData: true,
      childList: true,
      subtree: true,
    });

    view.rerender(
      <MarkdownPreview content={`${fence}\n\nPara one.\n\nPara two.`} />,
    );

    const mutations = observer.takeRecords();
    observer.disconnect();
    expect(view.container.textContent).toContain("Para two.");
    expect(mutations).toHaveLength(0);
    expect(line.isConnected).toBe(true);

    view.rerender(
      <MarkdownPreview
        content={"```ts\nconst a = 1;\nconst b = 2;\n```\n\nPara one."}
      />,
    );

    const expected = document.createElement("code");
    expected.innerHTML = highlightMarkdownCode({
      code: "const a = 1;\nconst b = 2;",
      language: "ts",
    });
    expect(requireElement(view.container, "pre code")).toBe(code);
    expect(code.innerHTML).toBe(expected.innerHTML);
    expect(code.querySelectorAll("span.sh__line")).toHaveLength(2);
  });

  it("links inline-code Markdown paths with a folder, not bare names", () => {
    render(
      <MarkdownPreview
        content="Read `README.md`, `docs/guide.markdown:4`, and `src/app.ts`."
        linkRouting={workspaceLinkRouting}
      />,
    );

    expect(screen.getByText("README.md").tagName).toBe("CODE");
    expect(
      screen
        .getByRole("link", { name: "docs/guide.markdown:4" })
        .getAttribute("href"),
    ).toBe("file:///workspace/docs/guide.markdown#L4");
    expect(screen.getByText("src/app.ts").tagName).toBe("CODE");
  });

  it("shows a context menu on local file links when the context provides items", () => {
    const openBuiltin = vi.fn();
    const openFinder = vi.fn();
    const openWithPlugin = vi.fn();
    render(
      <MarkdownLocalFileContextMenuContext.Provider
        value={(link) =>
          link.path.endsWith(".md")
            ? [
                {
                  id: "open-in",
                  items: [
                    {
                      id: "finder",
                      label: "Open in Finder",
                      onSelect: openFinder,
                    },
                  ],
                  label: "Open in",
                  type: "submenu",
                },
                {
                  id: "open-in-separator",
                  type: "separator",
                },
                {
                  id: "builtin",
                  label: "Open with built-in preview",
                  onSelect: openBuiltin,
                },
                {
                  id: "separator",
                  type: "separator",
                },
                {
                  id: "notes:editor",
                  label: "Open with Notes editor",
                  onSelect: openWithPlugin,
                },
              ]
            : null
        }
      >
        <MarkdownPreview
          content="See [notes](/workspace/notes/todo.md) and [app](/workspace/src/app.ts)."
          linkRouting={{
            localFile: {
              absoluteLinks: { kind: "trusted-host" },
              onOpenLink: vi.fn(() => true),
            },
          }}
        />
      </MarkdownLocalFileContextMenuContext.Provider>,
    );

    const link = screen.getByRole("link", { name: /notes/ });
    fireEvent.contextMenu(link);
    expect(screen.getByText("Open in")).not.toBeNull();
    fireEvent.click(screen.getByText("Open with Notes editor"));
    expect(openWithPlugin).toHaveBeenCalledTimes(1);
    expect(openFinder).not.toHaveBeenCalled();
    expect(openBuiltin).not.toHaveBeenCalled();

    fireEvent.contextMenu(screen.getByRole("link", { name: /app/ }));
    expect(screen.queryByText(/Open with/)).toBeNull();
  });

  it("leaves inline-code Markdown paths as code without local file routing", () => {
    render(<MarkdownPreview content="Read `README.md`." />);

    expect(screen.queryByRole("link", { name: "README.md" })).toBeNull();
    expect(screen.getByText("README.md").tagName).toBe("CODE");
  });

  it("routes local Markdown images through the configured content resolver", () => {
    const resolveSrc = vi.fn(
      ({ path }: { path: string }) =>
        `/api/files/content?path=${encodeURIComponent(path)}`,
    );
    const { container } = render(
      <MarkdownPreview
        content={[
          "![absolute](/workspace/generated.png)",
          "![relative](art/chart.png)",
          "![remote](https://example.com/image.png)",
        ].join("\n\n")}
        linkRouting={{
          localImage: {
            absolutePaths: { kind: "trusted-host" },
            relativePaths: {
              baseDir: "/workspace",
              rootPath: "/workspace",
            },
            resolveSrc,
          },
        }}
      />,
    );

    expect(
      container.querySelector('img[alt="absolute"]')?.getAttribute("src"),
    ).toBe("/api/files/content?path=%2Fworkspace%2Fgenerated.png");
    expect(
      container.querySelector('img[alt="relative"]')?.getAttribute("src"),
    ).toBe("/api/files/content?path=%2Fworkspace%2Fart%2Fchart.png");
    expect(
      container.querySelector('img[alt="remote"]')?.getAttribute("src"),
    ).toBe("https://example.com/image.png");
    expect(resolveSrc).toHaveBeenCalledTimes(2);
  });

  it("keeps absolute app-origin URLs on the app-route path", () => {
    const onOpenLink = vi.fn(() => true);
    const href = `${window.location.origin}/threads/thr_localhost`;

    render(
      <MarkdownPreview
        content={`Open [local thread](${href}).`}
        linkRouting={{ onOpenLink }}
      />,
    );

    fireEvent.click(screen.getByRole("link", { name: "local thread" }));

    expect(onOpenLink).not.toHaveBeenCalled();
    expect(
      screen.getByRole("link", { name: "local thread" }).getAttribute("href"),
    ).toBe(href);
  });

  it("rewrites localhost link hrefs without changing the visible text", () => {
    const displayedText = "http://127.0.0.1:5173";

    render(
      <MarkdownPreview
        content={`Open [${displayedText}](http://127.0.0.1:5173/demo).`}
      />,
    );

    const link = screen.getByRole("link", { name: displayedText });
    expect(link.getAttribute("href")).toBe(
      `${window.location.protocol}//${window.location.hostname}:5173/demo`,
    );
  });

  it("renders inline LaTeX math with KaTeX", async () => {
    const { container } = render(
      <MarkdownPreview content={"Mass-energy is $$E = mc^2$$ exactly."} />,
    );

    await waitFor(() =>
      expect(container.querySelector(".katex")).not.toBeNull(),
    );
    expect(container.querySelector(".katex-display")).toBeNull();
  });

  it("leaves single-dollar spans as literal text", () => {
    const { container } = render(
      <MarkdownPreview
        content={"It went from $5 to $10 last week, so $x$ stays literal."}
      />,
    );

    expect(container.querySelector(".katex")).toBeNull();
    expect(container.textContent).toContain("$5 to $10");
    expect(container.textContent).toContain("$x$");
  });

  it("renders display LaTeX math blocks with KaTeX", async () => {
    const { container } = render(
      <MarkdownPreview content={"$$\n\\frac{1}{2} + \\frac{1}{2} = 1\n$$"} />,
    );

    await waitFor(() =>
      expect(container.querySelector(".katex-display")).not.toBeNull(),
    );
  });

  it("leaves escaped dollar amounts as literal text", () => {
    const { container } = render(
      <MarkdownPreview content={"It went from \\$5 to \\$10 last week."} />,
    );

    expect(container.querySelector(".katex")).toBeNull();
    expect(container.textContent).toContain("$5");
    expect(container.textContent).toContain("$10");
  });

  it("renders math while still sanitizing untrusted HTML when allowHtml is set", async () => {
    const { container } = render(
      <MarkdownPreview
        allowHtml
        content={"$$a^2 + b^2 = c^2$$\n\n<script>alert(1)</script>"}
      />,
    );

    await waitFor(() =>
      expect(container.querySelector(".katex")).not.toBeNull(),
    );
    expect(container.querySelector("script")).toBeNull();
    expect(container.textContent).not.toContain("alert(1)");
  });

  it("contains invalid TeX instead of throwing", async () => {
    const { container } = render(
      <MarkdownPreview content={"Broken: $$\\frac{1}{$$ keeps rendering."} />,
    );

    await waitFor(() =>
      expect(container.querySelector(".katex-error")).not.toBeNull(),
    );
    expect(container.textContent).toContain("keeps rendering.");
  });

  it("closes a display math block whose `$$` delimiters are glued to the TeX (#1778)", async () => {
    const { container } = render(
      <MarkdownPreview
        content={[
          "Before the formula.",
          "",
          "$$T_{\\text{appearance}\\rightarrow\\text{chunk}}",
          "\\approx73\\text{--}146\\text{ ms}$$",
          "",
          "## Content after the formula",
          "",
          "- This should remain a list item.",
          "- [This should remain a link](https://example.com).",
        ].join("\n")}
      />,
    );

    await waitFor(() =>
      expect(container.querySelector(".katex-display")).not.toBeNull(),
    );
    expect(container.querySelector(".katex-error")).toBeNull();
    expect(
      container.querySelector(".katex-display annotation")?.textContent,
    ).toContain("appearance");
    expect(container.querySelector("h2")?.textContent).toBe(
      "Content after the formula",
    );
    expect(container.querySelectorAll("li")).toHaveLength(2);
    expect(
      container.querySelector('a[href="https://example.com"]')?.textContent,
    ).toBe("This should remain a link");
  });
});
