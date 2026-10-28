import {
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
  type ReactNode,
} from "react";
import { Icon } from "@cloudroom/shared-ui/icon";
import { Skeleton } from "@cloudroom/shared-ui/skeleton";
import {
  definePluginApp,
  Markdown,
  useBbNavigate,
  useRpc,
  type PluginMessageDirectiveProps,
  type MarkdownProps,
} from "@get-bb/plugin-sdk/app";
import type { inlineVisRpcContract } from "./server.js";

type PreviewSource = "workspace" | "thread-storage";

const PREVIEW_SOURCE_CONFIG = {
  workspace: { route: "worktree/files", opensWorkspace: true },
  "thread-storage": {
    route: "thread-storage/files",
    opensWorkspace: false,
  },
} as const satisfies Record<
  PreviewSource,
  { route: string; opensWorkspace: boolean }
>;

type LoadState =
  | { status: "missing-file" }
  | { status: "invalid-height"; message: string }
  | { status: "loading"; file: string }
  | {
      status: "ready";
      kind: "html";
      file: string;
      source: PreviewSource;
      content: string;
    }
  | {
      status: "ready";
      kind: "markdown";
      file: string;
      source: PreviewSource;
      content: string;
      document: NonNullable<MarkdownProps["experimental_document"]>;
    }
  | { status: "error"; file: string; message: string };

const DEFAULT_HEIGHT_PX = 224;
const MIN_HEIGHT_PX = 120;
const MAX_HEIGHT_PX = 2_000;
const MIN_FRAME_HEIGHT_PX = 24;

const THEME_TOKENS = [
  "background",
  "foreground",
  "card",
  "muted",
  "muted-foreground",
  "subtle-foreground",
  "border",
  "primary",
  "primary-foreground",
  "accent",
  "ring",
  "success",
  "success-foreground",
  "warning",
  "warning-text",
  "destructive",
  "destructive-text",
  "attention",
  "surface-recessed",
  "surface-raised",
  "surface-selected",
  "surface-destructive",
  "surface-attention",
  "radius",
  "font-mono",
];

const CHART_COLORS = {
  dark: [
    "#bfff00",
    "oklch(0.72 0.13 250)",
    "oklch(0.72 0.16 300)",
    "oklch(0.8 0.14 80)",
    "oklch(0.77 0.11 190)",
    "oklch(0.72 0.16 15)",
  ],
  light: [
    "#4d7c0f",
    "oklch(0.53 0.15 250)",
    "oklch(0.52 0.18 300)",
    "oklch(0.6 0.14 70)",
    "oklch(0.55 0.1 190)",
    "oklch(0.55 0.18 15)",
  ],
};

const FRAME_BASE_CSS =
  "html{background:transparent;color:var(--foreground);font-family:var(--font-sans);font-size:var(--font-size);line-height:var(--line-height);-webkit-font-smoothing:antialiased;scrollbar-width:none}" +
  "html::-webkit-scrollbar{display:none}body{margin:0}code,kbd,pre,samp{font-family:var(--font-mono)}";

const FRAME_SCRIPT = `(() => {
  const theme = document.getElementById("inline-vis-theme");
  let height = 0;
  addEventListener("message", (event) => {
    const data = event.data;
    if (event.source === parent && data?.type === "inline-vis:theme" && typeof data.css === "string") theme.textContent = data.css;
  });
  addEventListener("click", (event) => {
    const link = event.target instanceof Element ? event.target.closest("a[href]") : null;
    if (!link || event.defaultPrevented) return;
    const href = link.getAttribute("href");
    if (href.startsWith("#")) {
      event.preventDefault();
      document.getElementById(href.slice(1))?.scrollIntoView();
      return;
    }
    let url;
    try { url = new URL(href, document.baseURI); } catch { return; }
    if (url.protocol !== "http:" && url.protocol !== "https:") return;
    event.preventDefault();
    parent.postMessage({ type: "inline-vis:open", url: url.href }, "*");
  });
  const report = () => {
    const root = document.documentElement;
    const next = Math.ceil(root.scrollHeight > root.clientHeight ? root.scrollHeight : root.getBoundingClientRect().height);
    if (next === height) return;
    height = next;
    parent.postMessage({ type: "inline-vis:size", height }, "*");
  };
  new ResizeObserver(report).observe(document.documentElement);
  addEventListener("load", report);
})();`;

const measuredHeights = new Map<string, number>();

function encodePathSegments(file: string): string {
  return file.split("/").map(encodeURIComponent).join("/");
}

function buildPreviewUrl(
  threadId: string,
  file: string,
  source: PreviewSource,
): string {
  const route = PREVIEW_SOURCE_CONFIG[source].route;
  return `/api/v1/threads/${encodeURIComponent(threadId)}/${route}/${encodePathSegments(file)}`;
}

function parsePreviewHeight(value: string | undefined): number | null {
  const normalized = value?.trim() ?? "";
  if (normalized.length === 0) return DEFAULT_HEIGHT_PX;
  if (!/^\d+$/.test(normalized)) return null;
  const height = Number(normalized);
  return Number.isSafeInteger(height) &&
    height >= MIN_HEIGHT_PX &&
    height <= MAX_HEIGHT_PX
    ? height
    : null;
}

function isHtmlFile(file: string): boolean {
  return /\.html?$/i.test(file);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function frameThemeCss(element: Element): string {
  const style = getComputedStyle(element);
  const scheme = style.getPropertyValue("color-scheme").includes("dark")
    ? "dark"
    : "light";
  const value = (name: string) =>
    style
      .getPropertyValue(name)
      .trim()
      .replace(/[;{}<>]/g, "");
  const sans = value("--font-sans").replace(/,?\s*sans-serif$/, "");
  const variables = [
    ...THEME_TOKENS.map((name) => `--${name}:${value(`--${name}`)}`),
    ...CHART_COLORS[scheme].map(
      (color, index) => `--chart-${index + 1}:${color}`,
    ),
    `--font-sans:${sans ? `${sans}, ` : ""}-apple-system, BlinkMacSystemFont, "Segoe UI", system-ui, sans-serif`,
    `--font-size:${style.fontSize}`,
    `--line-height:${style.lineHeight}`,
  ];
  return `:root{color-scheme:${scheme};${variables.join(";")}}${FRAME_BASE_CSS}`;
}

function buildFrameDocument(
  html: string,
  baseUrl: string,
  themeCss: string,
): string {
  const base = baseUrl.replace(/"/g, "%22");
  return `<!doctype html><base href="${base}"><style id="inline-vis-theme">${themeCss}</style><script>${FRAME_SCRIPT}</script>${html}`;
}

function PreviewCard({
  file,
  action,
  children,
}: {
  file: string;
  action: ReactNode;
  children: ReactNode;
}) {
  return (
    <div className="my-2 overflow-hidden rounded-lg border border-border bg-background">
      <div className="flex items-center gap-2 border-b border-border px-3 py-1.5 text-xs text-muted-foreground">
        <div className="flex min-w-0 flex-1 items-center gap-2">
          <span className="shrink-0 font-semibold">inline-vis</span>
          <span className="truncate opacity-70">{file}</span>
        </div>
        {action}
      </div>
      {children}
    </div>
  );
}

function OpenInSidebarButton({
  file,
  onOpen,
  className = "",
}: {
  file: string;
  onOpen: () => void;
  className?: string;
}) {
  return (
    <button
      type="button"
      aria-label={`Open ${file} in sidebar`}
      title="Open in sidebar"
      className={`inline-flex size-5 shrink-0 cursor-pointer items-center justify-center rounded-md text-muted-foreground hover:bg-state-hover hover:text-foreground focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring ${className}`}
      onClick={onOpen}
    >
      <Icon name="ExternalLink" aria-hidden className="size-3" />
    </button>
  );
}

function frameHeight(contentHeight: number, maxHeight: number | null) {
  return Math.min(
    maxHeight ?? MAX_HEIGHT_PX,
    Math.max(MIN_FRAME_HEIGHT_PX, Math.ceil(contentHeight)),
  );
}

function HtmlFrame({
  url,
  file,
  content,
  heightKey,
  initialHeight,
  maxHeight,
  onOpenInSidebar,
}: {
  url: string;
  file: string;
  content: string;
  heightKey: string;
  initialHeight: number;
  maxHeight: number | null;
  onOpenInSidebar: (() => void) | null;
}) {
  const navigate = useBbNavigate();
  const boxRef = useRef<HTMLDivElement>(null);
  const frameRef = useRef<HTMLIFrameElement>(null);
  const [srcDoc, setSrcDoc] = useState<string | null>(null);
  const [contentHeight, setContentHeight] = useState(initialHeight);

  useLayoutEffect(() => {
    setSrcDoc(
      buildFrameDocument(
        content,
        new URL(url, window.location.href).href,
        frameThemeCss(boxRef.current!),
      ),
    );
  }, [content, url]);

  useEffect(() => {
    const onMessage = (event: MessageEvent) => {
      const frame = frameRef.current;
      if (!frame || event.source !== frame.contentWindow) return;
      const data: unknown = event.data;
      if (!isRecord(data)) return;
      if (
        data.type === "inline-vis:size" &&
        typeof data.height === "number" &&
        Number.isFinite(data.height)
      ) {
        measuredHeights.set(heightKey, data.height);
        setContentHeight(data.height);
      } else if (
        data.type === "inline-vis:open" &&
        typeof data.url === "string" &&
        document.activeElement === frame &&
        navigator.userActivation?.isActive !== false
      ) {
        navigate.openUrl(data.url);
      }
    };
    const themeObserver = new MutationObserver(() => {
      const box = boxRef.current;
      if (!box) return;
      frameRef.current?.contentWindow?.postMessage(
        { type: "inline-vis:theme", css: frameThemeCss(box) },
        "*",
      );
    });
    window.addEventListener("message", onMessage);
    themeObserver.observe(document.documentElement, {
      attributes: true,
      attributeFilter: ["class"],
    });
    return () => {
      window.removeEventListener("message", onMessage);
      themeObserver.disconnect();
    };
  }, [heightKey, navigate]);

  return (
    <div
      ref={boxRef}
      className="group relative my-4"
      style={{ height: frameHeight(contentHeight, maxHeight) }}
    >
      {srcDoc === null ? null : (
        <iframe
          ref={frameRef}
          title={`inline-vis: ${file}`}
          srcDoc={srcDoc}
          sandbox="allow-scripts"
          className="block size-full border-0 bg-transparent"
        />
      )}
      {onOpenInSidebar === null ? null : (
        <OpenInSidebarButton
          file={file}
          onOpen={onOpenInSidebar}
          className="absolute top-1 right-1 bg-background opacity-0 group-hover:opacity-100 focus-visible:opacity-100 pointer-coarse:opacity-100"
        />
      )}
    </div>
  );
}

function InlineVisDirective({
  attributes,
  source,
  message,
  openWorkspaceFile,
}: PluginMessageDirectiveProps) {
  const rpc = useRpc<typeof inlineVisRpcContract>();
  const fileAttr = attributes.file?.trim() ?? "";
  const sourceAttr = attributes.source;
  const heightAttr = attributes.height;
  const previewHeight = parsePreviewHeight(heightAttr);
  const heightError =
    previewHeight === null
      ? `inline-vis height must be a whole number from ${MIN_HEIGHT_PX} to ${MAX_HEIGHT_PX} pixels.`
      : null;
  const html = isHtmlFile(fileAttr);
  const maxHeight = heightAttr?.trim() ? previewHeight : null;
  const heightKey = `${message.threadId}:${sourceAttr ?? "workspace"}:${fileAttr}`;
  const initialHeight =
    measuredHeights.get(heightKey) ?? previewHeight ?? DEFAULT_HEIGHT_PX;
  const [state, setState] = useState<LoadState>(() =>
    heightError
      ? { status: "invalid-height", message: heightError }
      : fileAttr
        ? { status: "loading", file: fileAttr }
        : { status: "missing-file" },
  );

  useEffect(() => {
    if (heightError) {
      setState({ status: "invalid-height", message: heightError });
      return;
    }
    if (!fileAttr) {
      setState({ status: "missing-file" });
      return;
    }
    let cancelled = false;
    setState({ status: "loading", file: fileAttr });

    void (async () => {
      try {
        const result = await rpc.call("preparePreview", {
          threadId: message.threadId,
          file: fileAttr,
          ...(sourceAttr === undefined ? {} : { source: sourceAttr }),
        });
        if (cancelled) return;
        setState({ status: "ready", ...result });
      } catch (error) {
        if (cancelled) return;
        setState({
          status: "error",
          file: fileAttr,
          message: error instanceof Error ? error.message : String(error),
        });
      }
    })();

    return () => {
      cancelled = true;
    };
  }, [fileAttr, heightError, message.threadId, rpc, sourceAttr]);

  if (state.status === "missing-file") {
    return (
      <div
        role="alert"
        className="my-2 rounded-md border border-border bg-muted px-3 py-2 text-sm text-muted-foreground"
        title={source}
      >
        inline-vis requires a file attribute, e.g.{" "}
        <code>::inline-vis{'{file="demo.html"}'}</code>
      </div>
    );
  }

  if (state.status === "invalid-height") {
    return (
      <div
        role="alert"
        className="my-2 rounded-md border border-border bg-muted px-3 py-2 text-sm text-muted-foreground"
        title={source}
      >
        {state.message}
      </div>
    );
  }

  if (state.status === "loading") {
    const skeleton = (
      <div
        role="status"
        aria-busy="true"
        aria-label={`Loading visualization ${state.file}`}
        style={{
          height: html
            ? frameHeight(initialHeight, maxHeight)
            : (previewHeight ?? DEFAULT_HEIGHT_PX),
        }}
        className={html ? "my-4 w-full" : "w-full p-3"}
      >
        <Skeleton className="size-full" />
      </div>
    );
    return html ? (
      skeleton
    ) : (
      <PreviewCard
        file={state.file}
        action={
          openWorkspaceFile === null ? null : (
            <span aria-hidden className="size-5 shrink-0" />
          )
        }
      >
        {skeleton}
      </PreviewCard>
    );
  }

  if (state.status === "error") {
    return (
      <div
        role="alert"
        className="my-2 rounded-md border border-destructive/40 bg-destructive/10 px-3 py-2 text-sm text-destructive"
        title={source}
      >
        Failed to load {state.file}: {state.message}
      </div>
    );
  }

  const readyFile = state.file;
  const openInSidebar =
    !PREVIEW_SOURCE_CONFIG[state.source].opensWorkspace ||
    openWorkspaceFile === null
      ? null
      : () => {
          openWorkspaceFile(readyFile);
        };

  if (state.kind === "html") {
    return (
      <HtmlFrame
        url={buildPreviewUrl(message.threadId, state.file, state.source)}
        file={state.file}
        content={state.content}
        heightKey={heightKey}
        initialHeight={initialHeight}
        maxHeight={maxHeight}
        onOpenInSidebar={openInSidebar}
      />
    );
  }

  return (
    <PreviewCard
      file={state.file}
      action={
        openInSidebar === null ? null : (
          <OpenInSidebarButton file={state.file} onOpen={openInSidebar} />
        )
      }
    >
      <div
        style={{ height: previewHeight ?? DEFAULT_HEIGHT_PX }}
        className="overflow-auto p-3"
      >
        <Markdown
          content={state.content}
          experimental_document={state.document}
        />
      </div>
    </PreviewCard>
  );
}

export default definePluginApp((app) => {
  app.slots.messageDirective({
    id: "inline-vis",
    component: InlineVisDirective,
  });
});
