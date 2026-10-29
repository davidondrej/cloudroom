// @vitest-environment jsdom
import { act, cleanup, fireEvent, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { loadPluginApp, renderSlot } from "@get-bb/plugin-sdk/testing/app";

const app = await loadPluginApp(() => import("./app"));

afterEach(cleanup);

async function findFrame(container: HTMLElement): Promise<HTMLIFrameElement> {
  return waitFor(() => {
    const el = container.querySelector("iframe");
    if (!(el instanceof HTMLIFrameElement)) {
      throw new Error("Expected the inline visualization iframe to render");
    }
    return el;
  });
}

function postFromFrame(iframe: HTMLIFrameElement, data: unknown) {
  act(() => {
    window.dispatchEvent(
      new MessageEvent("message", { data, source: iframe.contentWindow }),
    );
  });
}

const message = {
  id: "msg_1",
  threadId: "thr_1",
  turnId: "turn_1",
  projectId: "proj_1",
};

describe("inline-vis messageDirective registration", () => {
  it("registers the inline-vis directive", () => {
    expect(app.messageDirectives).toHaveLength(1);
    expect(app.messageDirectives[0]!.id).toBe("inline-vis");
  });
});

describe("InlineVisDirective", () => {
  it("requires a file attribute without calling rpc", async () => {
    const slot = renderSlot(
      app.messageDirectives[0]!,
      {
        attributes: {},
        source: "::inline-vis{}",
        message,
        openWorkspaceFile: null,
      },
      { rpc: {} },
    );

    await slot.findByRole("alert");
    expect(slot.getByText(/requires a file attribute/i)).toBeTruthy();
    expect(slot.rpcCalls).toEqual([]);
  });

  it("shows the rpc validation error for an unknown source", async () => {
    const slot = renderSlot(
      app.messageDirectives[0]!,
      {
        attributes: { file: "demo.html", source: "project" },
        source: '::inline-vis{source="project" file="demo.html"}',
        message,
        openWorkspaceFile: vi.fn(() => true),
      },
      {
        rpc: {
          preparePreview: (input) => {
            expect(input).toEqual({
              threadId: "thr_1",
              file: "demo.html",
              source: "project",
            });
            throw new Error(
              'Invalid option: expected "workspace"|"thread-storage"',
            );
          },
        },
      },
    );

    const alert = await slot.findByRole("alert");
    expect(alert.textContent).toMatch(
      /expected "workspace"\|"thread-storage"/i,
    );
    expect(slot.container.querySelector("iframe")).toBeNull();
    expect(slot.rpcCalls).toEqual([
      {
        method: "preparePreview",
        input: {
          threadId: "thr_1",
          file: "demo.html",
          source: "project",
        },
      },
    ]);
  });

  it("renders workspace HTML in an opaque-origin frame with the theme and base URL", async () => {
    const openWorkspaceFile = vi.fn(() => true);
    const slot = renderSlot(
      app.messageDirectives[0]!,
      {
        attributes: { file: "charts/demo file.html" },
        source: '::inline-vis{file="charts/demo file.html"}',
        message,
        openWorkspaceFile,
      },
      {
        rpc: {
          preparePreview: (input) => {
            expect(input).toEqual({
              threadId: "thr_1",
              file: "charts/demo file.html",
            });
            return {
              kind: "html",
              file: "charts/demo file.html",
              source: "workspace",
              content: "<p>Chart</p>",
            };
          },
        },
      },
    );

    await slot.findByRole("status", {
      name: "Loading visualization charts/demo file.html",
    });
    const iframe = await findFrame(slot.container);

    expect(iframe.getAttribute("sandbox")).toBe("allow-scripts");
    expect(iframe.getAttribute("src")).toBeNull();
    const srcDoc = iframe.getAttribute("srcdoc")!;
    expect(srcDoc).toContain(
      '<base href="http://localhost:3000/api/v1/threads/thr_1/worktree/files/charts/demo%20file.html">',
    );
    expect(srcDoc).toContain('<style id="inline-vis-theme">:root{');
    expect(srcDoc.endsWith("<p>Chart</p>")).toBe(true);
    expect(iframe.parentElement!.style.height).toBe("224px");
    fireEvent.click(
      slot.getByRole("button", {
        name: "Open charts/demo file.html in sidebar",
      }),
    );
    expect(openWorkspaceFile).toHaveBeenCalledWith("charts/demo file.html");
  });

  it("uses the thread-storage route without a workspace action", async () => {
    const openWorkspaceFile = vi.fn(() => true);
    const slot = renderSlot(
      app.messageDirectives[0]!,
      {
        attributes: {
          source: "thread-storage",
          file: "reports/result file.html",
        },
        source:
          '::inline-vis{source="thread-storage" file="reports/result file.html"}',
        message,
        openWorkspaceFile,
      },
      {
        rpc: {
          preparePreview: () => ({
            kind: "html",
            file: "reports/result file.html",
            source: "thread-storage",
            content: "<p>Report</p>",
          }),
        },
      },
    );

    const iframe = await findFrame(slot.container);
    expect(iframe.getAttribute("srcdoc")).toContain(
      '<base href="http://localhost:3000/api/v1/threads/thr_1/thread-storage/files/reports/result%20file.html">',
    );
    expect(
      slot.queryByRole("button", { name: /open .* in sidebar/i }),
    ).toBeNull();
  });

  it("fits the frame to the page height, capped by the height attribute", async () => {
    const slot = renderSlot(
      app.messageDirectives[0]!,
      {
        attributes: { file: "fit.html", height: "480" },
        source: '::inline-vis{file="fit.html" height="480"}',
        message,
        openWorkspaceFile: null,
      },
      {
        rpc: {
          preparePreview: () => ({
            kind: "html",
            file: "fit.html",
            source: "workspace",
            content: "<p>Chart</p>",
          }),
        },
      },
    );

    const iframe = await findFrame(slot.container);
    const box = iframe.parentElement!;
    expect(box.style.height).toBe("480px");

    postFromFrame(iframe, { type: "inline-vis:size", height: 312.4 });
    await waitFor(() => expect(box.style.height).toBe("313px"));
    postFromFrame(iframe, { type: "inline-vis:size", height: 900 });
    await waitFor(() => expect(box.style.height).toBe("480px"));
    window.dispatchEvent(
      new MessageEvent("message", {
        data: { type: "inline-vis:size", height: 200 },
      }),
    );
    expect(box.style.height).toBe("480px");
  });

  it("opens links only for a focused frame", async () => {
    const slot = renderSlot(
      app.messageDirectives[0]!,
      {
        attributes: { file: "links.html" },
        source: '::inline-vis{file="links.html"}',
        message,
        openWorkspaceFile: null,
      },
      {
        rpc: {
          preparePreview: () => ({
            kind: "html",
            file: "links.html",
            source: "workspace",
            content: '<a href="https://example.com">PR</a>',
          }),
        },
        openUrl: () => true,
      },
    );

    const iframe = await findFrame(slot.container);
    const link = { type: "inline-vis:open", url: "https://example.com/" };
    postFromFrame(iframe, link);
    expect(slot.navigateCalls).toEqual([]);

    iframe.tabIndex = 0;
    iframe.focus();
    postFromFrame(iframe, link);
    expect(slot.navigateCalls).toEqual([
      { method: "openUrl", url: "https://example.com/" },
    ]);
  });

  it("renders a Markdown document with the host renderer and no iframe", async () => {
    const openWorkspaceFile = vi.fn(() => true);
    const slot = renderSlot(
      app.messageDirectives[0]!,
      {
        attributes: { file: "reports/notes.md" },
        source: '::inline-vis{file="reports/notes.md"}',
        message,
        openWorkspaceFile,
      },
      {
        rpc: {
          preparePreview: (input) => {
            expect(input).toEqual({
              threadId: "thr_1",
              file: "reports/notes.md",
            });
            return {
              kind: "markdown",
              file: "reports/notes.md",
              source: "workspace",
              content: "# Notes\n\nReady for review.",
            };
          },
        },
      },
    );

    const markdown = await slot.findByTestId("bb-markdown");
    expect(markdown.textContent).toBe("# Notes\n\nReady for review.");
    expect(slot.container.querySelector("iframe")).toBeNull();
    expect(markdown.parentElement?.style.height).toBe("224px");
    expect(markdown.parentElement?.className).toContain("overflow-auto");

    fireEvent.click(
      slot.getByRole("button", {
        name: "Open reports/notes.md in sidebar",
      }),
    );
    expect(openWorkspaceFile).toHaveBeenCalledWith("reports/notes.md");
  });

  it("renders thread-storage Markdown without a workspace action", async () => {
    const openWorkspaceFile = vi.fn(() => true);
    const slot = renderSlot(
      app.messageDirectives[0]!,
      {
        attributes: { source: "thread-storage", file: "reports/notes.md" },
        source: '::inline-vis{source="thread-storage" file="reports/notes.md"}',
        message,
        openWorkspaceFile,
      },
      {
        rpc: {
          preparePreview: () => ({
            kind: "markdown",
            file: "reports/notes.md",
            source: "thread-storage",
            content: "# Notes",
          }),
        },
      },
    );

    const markdown = await slot.findByTestId("bb-markdown");
    expect(markdown.textContent).toBe("# Notes");
    expect(slot.container.querySelector("iframe")).toBeNull();
    expect(
      slot.queryByRole("button", { name: /open .* in sidebar/i }),
    ).toBeNull();
    expect(openWorkspaceFile).not.toHaveBeenCalled();
  });

  it("uses an optional bounded height for Markdown", async () => {
    const slot = renderSlot(
      app.messageDirectives[0]!,
      {
        attributes: { file: "notes.md", height: "480" },
        source: '::inline-vis{file="notes.md" height="480"}',
        message,
        openWorkspaceFile: null,
      },
      {
        rpc: {
          preparePreview: () => ({
            kind: "markdown",
            file: "notes.md",
            source: "workspace",
            content: "# Notes",
          }),
        },
      },
    );

    const markdown = await slot.findByTestId("bb-markdown");
    expect(markdown.parentElement?.style.height).toBe("480px");
  });

  it("reserves the Markdown preview height while loading", async () => {
    type MarkdownPreview = {
      kind: "markdown";
      file: string;
      source: "workspace";
      content: string;
    };
    let resolvePreview = (_result: MarkdownPreview) => {};
    const pendingPreview = new Promise<MarkdownPreview>((resolve) => {
      resolvePreview = resolve;
    });
    const slot = renderSlot(
      app.messageDirectives[0]!,
      {
        attributes: { file: "notes.md", height: "480" },
        source: '::inline-vis{file="notes.md" height="480"}',
        message,
        openWorkspaceFile: vi.fn(() => true),
      },
      {
        rpc: {
          preparePreview: () => pendingPreview,
        },
      },
    );

    const loading = await waitFor(() => {
      const el = slot.container.querySelector('[aria-busy="true"]');
      if (!(el instanceof HTMLElement)) {
        throw new Error("Expected the inline visualization loader to render");
      }
      return el;
    });
    expect(loading.style.height).toBe("480px");
    const loadingCard = loading.parentElement!;

    resolvePreview({
      kind: "markdown",
      file: "notes.md",
      source: "workspace",
      content: "# Notes",
    });

    const markdown = await slot.findByTestId("bb-markdown");
    const markdownBody = markdown.parentElement!;
    expect(markdownBody.style.height).toBe("480px");
    expect(slot.queryByRole("status")).toBeNull();
    expect(markdownBody.parentElement!.className).toBe(loadingCard.className);
  });

  it("rejects an invalid height without calling rpc", async () => {
    const slot = renderSlot(
      app.messageDirectives[0]!,
      {
        attributes: { file: "demo.html", height: "100vh" },
        source: '::inline-vis{file="demo.html" height="100vh"}',
        message,
        openWorkspaceFile: null,
      },
      { rpc: {} },
    );

    expect((await slot.findByRole("alert")).textContent).toMatch(
      /whole number from 120 to 2000 pixels/i,
    );
    expect(slot.container.querySelector("iframe")).toBeNull();
    expect(slot.rpcCalls).toEqual([]);
  });

  it("shows an error when rpc fails", async () => {
    const slot = renderSlot(
      app.messageDirectives[0]!,
      {
        attributes: { file: "missing.html" },
        source: '::inline-vis{file="missing.html"}',
        message,
        openWorkspaceFile: null,
      },
      {
        rpc: {
          preparePreview: () => {
            throw new Error("Preview file not found: missing.html");
          },
        },
      },
    );

    const alert = await slot.findByRole("alert");
    expect(alert.textContent).toMatch(/Preview file not found: missing\.html/);
    expect(slot.container.querySelector("iframe")).toBeNull();
  });
});
