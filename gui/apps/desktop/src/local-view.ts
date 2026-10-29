import { stripVTControlCharacters } from "node:util";
import { escapeHtmlText } from "@cloudroom/domain";

export const STARTUP_RETRY_CHANNEL = "bb-desktop:retry-startup";

export type LocalViewModel = LoadingViewModel | StartupErrorViewModel;

interface LoadingViewModel {
  kind: "loading";
  logoSrc: string;
  title: string;
}

interface StartupErrorViewModel {
  details: string;
  kind: "error";
  logText: string;
  retryable: boolean;
  title: string;
}

interface CreateLocalViewUrlArgs {
  viewModel: LocalViewModel;
}

function formatPlainLogText(value: string): string {
  return stripVTControlCharacters(value).replace(/\r\n?/gu, "\n");
}

function renderLoadingView(viewModel: LoadingViewModel): string {
  return `
    <main class="shell" role="status">
      <img class="loading-logo" src="${escapeHtmlText(viewModel.logoSrc)}" alt="">
      <div class="loading-floor"></div>
      <h1>${escapeHtmlText(viewModel.title)}</h1>
      <div class="loading-dots"><i></i><i></i><i></i></div>
    </main>
  `;
}

function renderErrorView(viewModel: StartupErrorViewModel): string {
  const logText = formatPlainLogText(viewModel.logText);
  const logs =
    logText.trim().length > 0 ? `<pre>${escapeHtmlText(logText)}</pre>` : "";
  const retry = viewModel.retryable
    ? '<button type="button" data-testid="bb-startup-retry">Try again</button>'
    : "";
  return `
    <main class="shell shell-error">
      <h1>${escapeHtmlText(viewModel.title)}</h1>
      <p>${escapeHtmlText(viewModel.details)}</p>
      ${retry}
      ${logs}
    </main>
  `;
}

function renderLocalView(viewModel: LocalViewModel): string {
  const body =
    viewModel.kind === "loading"
      ? renderLoadingView(viewModel)
      : renderErrorView(viewModel);
  return `<!doctype html>
<html>
<head>
  <meta charset="utf-8">
  <meta http-equiv="Content-Security-Policy" content="default-src 'none'; img-src data:; style-src 'unsafe-inline'">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>Cloudroom</title>
  <style>
    :root {
      color-scheme: light dark;
      font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
      --loading-bg: #f4eedf;
      --loading-fg: #0a0a0a;
      --loading-depth: #0a0a0a;
      --loading-floor: rgb(10 10 10 / 12%);
      --loading-dot: #0a0a0a;
      --loading-dot-idle: #0a0a0a;
    }

    @media (prefers-color-scheme: dark) {
      :root {
        --loading-bg: #0b0b0b;
        --loading-fg: #ededed;
        --loading-depth: #2e2e2e;
        --loading-floor: rgb(255 255 255 / 7%);
        --loading-dot: #bfff00;
        --loading-dot-idle: #3a3a3a;
      }
    }

    body {
      align-items: center;
      background: Canvas;
      color: CanvasText;
      display: flex;
      height: 100vh;
      justify-content: center;
      margin: 0;
    }

    .titlebar-drag-region {
      app-region: drag;
      -webkit-app-region: drag;
      background: transparent;
      border: 0;
      height: 28px;
      left: 0;
      position: fixed;
      right: 0;
      top: 0;
      user-select: none;
      z-index: 10;
    }

    button,
    a,
    input,
    textarea,
    select,
    summary,
    pre {
      app-region: no-drag;
      -webkit-app-region: no-drag;
    }

    .shell {
      max-width: 680px;
      padding: 32px;
      text-align: center;
    }

    .shell-error {
      text-align: left;
    }

    h1 {
      font-size: 22px;
      font-weight: 600;
      letter-spacing: 0;
      line-height: 1.25;
      margin: 16px 0 8px;
    }

    p {
      color: color-mix(in srgb, CanvasText 74%, transparent);
      font-size: 14px;
      line-height: 1.5;
      margin: 0;
    }

    button {
      background: CanvasText;
      border: 0;
      border-radius: 6px;
      color: Canvas;
      cursor: pointer;
      font: inherit;
      font-size: 14px;
      font-weight: 600;
      margin: 18px 0 0;
      padding: 8px 14px;
    }

    pre {
      background: color-mix(in srgb, CanvasText 8%, transparent);
      border-radius: 6px;
      font-family: ui-monospace, SFMono-Regular, Menlo, monospace;
      font-size: 12px;
      line-height: 1.45;
      margin: 18px 0 0;
      max-height: 260px;
      overflow: auto;
      padding: 12px;
      white-space: pre-wrap;
    }

    .loading-view {
      background: var(--loading-bg);
      color: var(--loading-fg);
    }

    .loading-view h1 {
      font-size: 26px;
      font-weight: 800;
      letter-spacing: -0.03em;
      margin: 30px 0 0;
    }

    .loading-logo {
      animation: loading-bob 0.8s ease-in-out infinite alternate;
      box-shadow: 1px 1px 0 var(--loading-depth), 2px 2px 0 var(--loading-depth), 3px 3px 0 var(--loading-depth), 4px 4px 0 var(--loading-depth), 5px 5px 0 var(--loading-depth), 6px 6px 0 var(--loading-depth), 7px 7px 0 var(--loading-depth), 8px 8px 0 var(--loading-depth), 9px 9px 0 var(--loading-depth), 10px 10px 0 var(--loading-depth);
      display: block;
      height: 120px;
      margin: 0 auto;
      width: 120px;
    }

    .loading-floor {
      animation: loading-floor 0.8s ease-in-out infinite alternate;
      background: var(--loading-floor);
      height: 8px;
      margin: 26px auto 0;
      width: 100px;
    }

    .loading-dots {
      display: flex;
      gap: 8px;
      justify-content: center;
      margin-top: 16px;
    }

    .loading-dots i {
      animation: loading-dot 1.2s steps(1) infinite;
      border: 2px solid var(--loading-dot-idle);
      box-sizing: border-box;
      height: 10px;
      width: 10px;
    }

    .loading-dots i:nth-child(2) {
      animation-delay: -0.8s;
    }

    .loading-dots i:nth-child(3) {
      animation-delay: -0.4s;
    }

    @keyframes loading-bob {
      from {
        transform: translate(-5px, 0);
      }
      to {
        transform: translate(-5px, -10px);
      }
    }

    @keyframes loading-floor {
      to {
        opacity: 0.6;
        transform: scaleX(0.8);
      }
    }

    @keyframes loading-dot {
      0% {
        background: var(--loading-dot);
        border-color: var(--loading-dot);
      }
      66% {
        background: transparent;
        border-color: var(--loading-dot-idle);
      }
    }

    @media (prefers-reduced-motion: reduce) {
      .loading-view * {
        animation: none;
      }
    }
  </style>
</head>
<body class="${viewModel.kind}-view">
<div class="titlebar-drag-region" data-testid="bb-local-view-window-drag-region" aria-hidden="true"></div>
${body}
</body>
</html>`;
}

export function createLocalViewUrl(args: CreateLocalViewUrlArgs): string {
  return `data:text/html;charset=utf-8,${encodeURIComponent(
    renderLocalView(args.viewModel),
  )}`;
}
