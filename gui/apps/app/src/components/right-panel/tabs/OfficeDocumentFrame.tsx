// Word pages and PowerPoint slides, drawn by docx-preview and pptx-preview.
// Both run inside a sandboxed frame: its own origin, no network, no access
// to the app. The file goes over a private channel handed to the frame's
// first page only, so a frame that navigates away gets nothing. A broken
// file falls back to the text view.
import { useEffect, useState, type ReactNode } from "react";
import { openUrlInExternalBrowser } from "@/lib/url-open-routing";

export type OfficeDocumentFormat = "docx" | "pptx";

interface OfficeDocument {
  format: OfficeDocumentFormat;
  bytes: Uint8Array;
  /** Slide part names in the deck's saved order. */
  slideOrder: string[];
}

interface OfficeDocumentFrameProps extends OfficeDocument {
  fallback: ReactNode;
}

type FrameMessage =
  | { type: "height"; height: number }
  | { type: "error" }
  | { type: "link"; href: string };

const FRAME_POLICY =
  "default-src 'none'; script-src 'unsafe-inline'; style-src 'unsafe-inline'; img-src data: blob:; font-src data: blob:; media-src data: blob:";

// Office fonts fall back to the closest system font when missing.
const FONT_FALLBACKS = [
  ["Aptos", "Helvetica Neue", "Arial"],
  ["Aptos Display", "Helvetica Neue", "Arial"],
  ["Calibri", "Helvetica Neue", "Arial"],
  ["Calibri Light", "Helvetica Neue Light", "Helvetica Neue", "Arial"],
  ["Cambria", "Georgia"],
]
  .flatMap(([family, ...fallbacks]) =>
    [400, 700].map(
      (weight) =>
        `@font-face{font-family:"${family}";font-weight:${weight};src:${[family, ...(fallbacks ?? [])].map((name) => `local("${name}${weight === 700 ? " Bold" : ""}")`).join(",")}}`,
    ),
  )
  .join("");

const FRAME_STYLE = `${FONT_FALLBACKS}
html,body{margin:0;background:transparent;overflow:hidden;font-family:-apple-system,"Segoe UI","Helvetica Neue",Arial,sans-serif}
#root{padding:16px}
.docx-wrapper{background:transparent!important;padding:0!important}
.docx-wrapper>section.docx{margin:0 auto 16px!important;box-shadow:0 1px 3px rgba(0,0,0,.5),0 10px 30px rgba(0,0,0,.4)!important;border-radius:3px}
.slide{display:grid;grid-template-columns:26px 1fr;margin-bottom:14px}
.slide>b{font:500 11px/1 system-ui,sans-serif;color:#8a8a8a;padding-top:4px}
.slide>div{border-radius:8px;overflow:hidden;box-shadow:0 0 0 1px rgba(255,255,255,.14),0 8px 24px rgba(0,0,0,.4)}
.slide .pptx-preview-slide-wrapper{margin:0!important}`;

// Runs inside the frame. Kept as plain ES2017 so it needs no build step.
function frameMain() {
  const root = document.getElementById("root") as HTMLElement;
  let port: MessagePort | null = null;
  const post = (message: FrameMessage) => port?.postMessage(message);
  let fit = () => {};
  const reportHeight = () =>
    post({
      type: "height",
      height: document.documentElement.getBoundingClientRect().height,
    });
  const refit = () => {
    fit();
    reportHeight();
  };
  addEventListener("resize", refit);
  new ResizeObserver(reportHeight).observe(root);
  document.addEventListener("click", (event) => {
    const link = (event.target as Element).closest("a");
    if (!link) return;
    event.preventDefault();
    if (/^(https?:|mailto:)/i.test(link.href))
      post({ type: "link", href: link.href });
  });

  async function renderDocx(bytes: Uint8Array) {
    const lib = (window as unknown as { docx: DocxLib }).docx;
    // docx-preview empties the style container, so give it its own.
    const styles = document.getElementById("docx-styles") as HTMLElement;
    await lib.renderAsync(new Blob([bytes.slice()]), root, styles, {
      breakPages: true,
      // Keep the page breaks Word saved, so pages match Word.
      ignoreLastRenderedPageBreak: false,
      inWrapper: true,
    });
    const pages = Array.from(
      root.querySelectorAll<HTMLElement>("section.docx"),
    );
    if (pages.length === 0) throw new Error("no pages");
    for (const page of pages) {
      // Files without page setup (pandoc, scripts) get a Letter page.
      if (!page.style.width) {
        page.style.width = "8.5in";
        page.style.minHeight = "11in";
        page.style.padding = "1in";
        page.style.boxSizing = "border-box";
      }
    }
    // Symbol-font bullets live in the Private Use Area; draw real ones.
    for (const style of Array.from(document.querySelectorAll("style"))) {
      style.textContent = (style.textContent ?? "")
        .replace(//g, "•")
        .replace(//g, "▪");
    }
    fit = () => {
      root.style.zoom = "1";
      const widest = Math.max(...pages.map((page) => page.offsetWidth));
      const zoom = Math.min(1, (root.clientWidth - 32) / widest);
      root.style.zoom = String(zoom);
    };
  }

  async function renderPptx(bytes: Uint8Array, slideOrder: string[]) {
    const lib = (window as unknown as { pptxPreview: PptxLib }).pptxPreview;
    const holder = document.createElement("div");
    let width = 960;
    let height = 540;
    let viewer = lib.init(holder, { width, height });
    await viewer.preview(bytes.slice().buffer);
    const size = viewer.pptx;
    if (
      size?.width &&
      size.height &&
      Math.abs(size.height / size.width - height / width) > 0.01
    ) {
      height = Math.round((width * size.height) / size.width);
      holder.innerHTML = "";
      viewer = lib.init(holder, { width, height });
      await viewer.preview(bytes.slice().buffer);
    }
    let slides = Array.from(
      holder.querySelectorAll<HTMLElement>(".pptx-preview-slide-wrapper"),
    );
    if (slides.length === 0) throw new Error("no slides");
    // The library orders slides by file name; use the deck's saved order.
    const names = (viewer.pptx?.slides ?? []).map((slide) => slide.name);
    const byName = new Map(names.map((name, index) => [name, slides[index]]));
    const ordered = slideOrder
      .map((name) => byName.get(name))
      .filter((slide): slide is HTMLElement => slide !== undefined);
    if (names.length === slides.length && ordered.length === slides.length)
      slides = ordered;
    const frames = slides.map((slide, index) => {
      const row = document.createElement("div");
      row.className = "slide";
      const number = document.createElement("b");
      number.textContent = String(index + 1);
      const frame = document.createElement("div");
      const inner = document.createElement("div");
      inner.style.cssText = `width:${width}px;height:${height}px;position:relative`;
      inner.appendChild(slide);
      frame.appendChild(inner);
      row.append(number, frame);
      root.appendChild(row);
      return { frame, inner };
    });
    fit = () => {
      const zoom = (root.clientWidth - 32 - 26) / width;
      for (const { frame, inner } of frames) {
        frame.style.width = `${width * zoom}px`;
        frame.style.height = `${height * zoom}px`;
        inner.style.zoom = String(zoom);
      }
    };
  }

  async function render(file: OfficeDocument) {
    root.replaceChildren();
    try {
      await (file.format === "docx"
        ? renderDocx(file.bytes)
        : renderPptx(file.bytes, file.slideOrder));
      refit();
    } catch {
      post({ type: "error" });
    }
  }

  // The app hands over one private port, once; everything else is ignored.
  addEventListener("message", (event: MessageEvent) => {
    const offered = event.ports[0];
    if (port || event.source !== parent || !offered) return;
    port = offered;
    port.onmessage = (message: MessageEvent<OfficeDocument>) =>
      void render(message.data);
  });
}

interface DocxLib {
  renderAsync(
    data: Blob,
    body: HTMLElement,
    styles: HTMLElement,
    options: Record<string, boolean>,
  ): Promise<unknown>;
}

interface PptxLib {
  init(
    dom: HTMLElement,
    options: { width: number; height: number },
  ): {
    preview(buffer: ArrayBuffer): Promise<unknown>;
    pptx?: { width?: number; height?: number; slides?: { name: string }[] };
  };
}

async function loadLibraries(format: OfficeDocumentFormat): Promise<string[]> {
  if (format === "pptx") {
    const pptx =
      await import("../../../../node_modules/pptx-preview/dist/pptx-preview.umd.js?raw");
    return [pptx.default];
  }
  const [jszip, docx] = await Promise.all([
    import("../../../../node_modules/jszip/dist/jszip.min.js?raw"),
    import("../../../../node_modules/docx-preview/dist/docx-preview.min.js?raw"),
  ]);
  return [jszip.default, docx.default];
}

function buildFrameDocument(libraries: string[]): string {
  const scripts = [...libraries, `(${frameMain.toString()})()`]
    .map(
      (code) => `<script>${code.replace(/<\/script/gi, "<\\/script")}</script>`,
    )
    .join("");
  return `<!doctype html><html><head><meta charset="utf-8"><meta http-equiv="Content-Security-Policy" content="${FRAME_POLICY}"><style>${FRAME_STYLE}</style></head><body><div id="docx-styles"></div><div id="root"></div>${scripts}</body></html>`;
}

function isFrameMessage(value: unknown): value is FrameMessage {
  if (typeof value !== "object" || value === null) return false;
  const message = value as Record<string, unknown>;
  return (
    (message.type === "height" && typeof message.height === "number") ||
    message.type === "error" ||
    (message.type === "link" && typeof message.href === "string")
  );
}

export default function OfficeDocumentFrame({
  format,
  bytes,
  slideOrder,
  fallback,
}: OfficeDocumentFrameProps) {
  const [frameDocument, setFrameDocument] = useState<{
    format: OfficeDocumentFormat;
    html: string;
  } | null>(null);
  const [channel, setChannel] = useState<{
    frame: HTMLIFrameElement;
    port: MessagePort;
  } | null>(null);
  const [loadFailed, setLoadFailed] = useState(false);
  const [failedBytes, setFailedBytes] = useState<Uint8Array | null>(null);
  const [height, setHeight] = useState(0);

  useEffect(() => {
    let active = true;
    loadLibraries(format)
      .then((libraries) => {
        if (active)
          setFrameDocument({ format, html: buildFrameDocument(libraries) });
      })
      .catch(() => {
        if (active) setLoadFailed(true);
      });
    return () => {
      active = false;
    };
  }, [format]);

  // Send the file, and every new version of it, over the private channel.
  useEffect(() => {
    if (!channel) return;
    const onMessage = (event: MessageEvent<unknown>) => {
      const message = event.data;
      if (!isFrameMessage(message)) return;
      if (message.type === "height") setHeight(Math.ceil(message.height));
      if (message.type === "error") setFailedBytes(bytes);
      if (message.type === "link" && /^(https?:|mailto:)/i.test(message.href))
        openUrlInExternalBrowser(message.href);
    };
    channel.port.addEventListener("message", onMessage);
    channel.port.start();
    channel.port.postMessage({ format, bytes, slideOrder });
    return () => channel.port.removeEventListener("message", onMessage);
  }, [bytes, channel, format, slideOrder]);

  useEffect(() => () => channel?.port.close(), [channel]);

  if (loadFailed || failedBytes === bytes) return fallback;
  if (frameDocument?.format !== format) return null;
  return (
    <iframe
      key={format}
      title={format === "docx" ? "Word document" : "Slides"}
      sandbox="allow-scripts"
      srcDoc={frameDocument.html}
      onLoad={(event) => {
        const frame = event.currentTarget;
        // Only the first page of this frame is ours; a later load means it
        // navigated away, so it gets no channel.
        if (channel?.frame === frame) return;
        const { port1, port2 } = new MessageChannel();
        frame.contentWindow?.postMessage(null, "*", [port2]);
        setChannel({ frame, port: port1 });
      }}
      className="block w-full border-0"
      // Same color scheme as the frame's page, so the frame stays transparent.
      style={{ height, colorScheme: "normal" }}
    />
  );
}
