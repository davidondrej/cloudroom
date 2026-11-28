import { execFile, spawn } from "node:child_process";
import { access, constants, readdir, readFile } from "node:fs/promises";
import { connect } from "node:net";
import { homedir } from "node:os";
import { join } from "node:path";
import { setTimeout as sleep } from "node:timers/promises";
import { promisify } from "node:util";
import type { BrowserControlStatus } from "./contract.js";

const run = promisify(execFile);

export interface KnownBrowser {
  bundleId: string;
  browserName: string;
  shortName: string;
  macProfile: string;
  linuxProfile: string | null;
  linuxFlatpakProfile?: string;
  linuxDesktopPatterns: RegExp[];
  linuxBins: string[];
  inspectUrl: string;
}

// Fallback order matches browser-harness (Chrome first, then Chromium/Brave/Edge/Arc/Dia/Comet).
// More specific desktop patterns (e.g. Brave Origin) must precede broader prefixes (Brave).
export const KNOWN_BROWSERS: readonly KnownBrowser[] = [
  {
    bundleId: "com.google.chrome",
    browserName: "Google Chrome",
    shortName: "Chrome",
    macProfile: "Google/Chrome",
    linuxProfile: "google-chrome",
    linuxFlatpakProfile: ".var/app/com.google.Chrome/config/google-chrome",
    linuxDesktopPatterns: [/^google-chrome(?:\.desktop|-stable\.desktop)?$/i, /^com\.google\.Chrome\.desktop$/i],
    linuxBins: ["google-chrome", "google-chrome-stable"],
    inspectUrl: "chrome://inspect/#remote-debugging",
  },
  {
    bundleId: "com.google.chrome.canary",
    browserName: "Google Chrome Canary",
    shortName: "Chrome",
    macProfile: "Google/Chrome Canary",
    linuxProfile: "google-chrome-unstable",
    linuxDesktopPatterns: [/^google-chrome-unstable/i],
    linuxBins: ["google-chrome-unstable"],
    inspectUrl: "chrome://inspect/#remote-debugging",
  },
  {
    bundleId: "org.chromium.chromium",
    browserName: "Chromium",
    shortName: "Chromium",
    macProfile: "Chromium",
    linuxProfile: "chromium",
    linuxFlatpakProfile: ".var/app/org.chromium.Chromium/config/chromium",
    linuxDesktopPatterns: [/^chromium/i, /^org\.chromium\.Chromium\.desktop$/i],
    linuxBins: ["chromium", "chromium-browser"],
    inspectUrl: "chrome://inspect/#remote-debugging",
  },
  {
    bundleId: "com.brave.browser.origin",
    browserName: "Brave Origin",
    shortName: "Brave",
    macProfile: "BraveSoftware/Brave-Origin",
    linuxProfile: "BraveSoftware/Brave-Origin",
    linuxDesktopPatterns: [/^brave-browser-origin/i],
    linuxBins: ["brave-browser-origin"],
    inspectUrl: "brave://inspect/#remote-debugging",
  },
  {
    bundleId: "com.brave.browser",
    browserName: "Brave Browser",
    shortName: "Brave",
    macProfile: "BraveSoftware/Brave-Browser",
    linuxProfile: "BraveSoftware/Brave-Browser",
    linuxFlatpakProfile: ".var/app/com.brave.Browser/config/BraveSoftware/Brave-Browser",
    linuxDesktopPatterns: [/^brave-browser/i, /^com\.brave\.Browser\.desktop$/i],
    linuxBins: ["brave-browser", "brave"],
    inspectUrl: "brave://inspect/#remote-debugging",
  },
  {
    bundleId: "com.microsoft.edgemac",
    browserName: "Microsoft Edge",
    shortName: "Edge",
    macProfile: "Microsoft Edge",
    linuxProfile: "microsoft-edge",
    linuxFlatpakProfile: ".var/app/com.microsoft.Edge/config/microsoft-edge",
    linuxDesktopPatterns: [/^microsoft-edge/i, /^com\.microsoft\.Edge\.desktop$/i],
    linuxBins: ["microsoft-edge", "microsoft-edge-stable"],
    inspectUrl: "edge://inspect/#remote-debugging",
  },
  {
    bundleId: "company.thebrowser.browser",
    browserName: "Arc",
    shortName: "Arc",
    macProfile: "Arc/User Data",
    linuxProfile: null,
    linuxDesktopPatterns: [],
    linuxBins: [],
    inspectUrl: "chrome://inspect/#remote-debugging",
  },
  {
    bundleId: "company.thebrowser.dia",
    browserName: "Dia",
    shortName: "Dia",
    macProfile: "Dia/User Data",
    linuxProfile: null,
    linuxDesktopPatterns: [],
    linuxBins: [],
    inspectUrl: "chrome://inspect/#remote-debugging",
  },
  {
    bundleId: "ai.perplexity.comet",
    browserName: "Comet",
    shortName: "Comet",
    macProfile: "Comet",
    linuxProfile: null,
    linuxDesktopPatterns: [],
    linuxBins: [],
    inspectUrl: "chrome://inspect/#remote-debugging",
  },
];

export interface DetectedDefaultBrowser {
  bundleId: string | null;
  name: string | null;
  executablePath: string | null;
}

export interface BrowserControlDeps {
  platform?: NodeJS.Platform;
  home?: string;
  detectDefault?: () => Promise<DetectedDefaultBrowser | null>;
  probeTcp?: (port: number) => Promise<boolean>;
  probeCdpHttp?: (port: number) => Promise<boolean>;
  readFile?: (path: string) => Promise<string>;
  readdir?: (path: string) => Promise<string[]>;
  accessReadable?: (path: string) => Promise<void>;
}

function isPermError(error: unknown): boolean {
  const code = (error as NodeJS.ErrnoException | null)?.code;
  return code === "EPERM" || code === "EACCES";
}

function isMissingError(error: unknown): boolean {
  const code = (error as NodeJS.ErrnoException | null)?.code;
  return code === "ENOENT" || code === "ENOTDIR";
}

function matchMacBrowser(bundleId: string | null): KnownBrowser | null {
  if (!bundleId) return null;
  const lower = bundleId.toLowerCase();
  return KNOWN_BROWSERS.find((b) => b.bundleId === lower) ?? null;
}

function matchLinuxBrowser(desktopId: string | null): KnownBrowser | null {
  if (!desktopId) return null;
  const trimmed = desktopId.trim();
  return (
    KNOWN_BROWSERS.find((b) =>
      b.linuxDesktopPatterns.some((pattern) => pattern.test(trimmed)),
    ) ?? null
  );
}

export function profilePathsFor(
  browser: KnownBrowser,
  platform: NodeJS.Platform,
  home: string,
): string[] {
  if (platform === "darwin") {
    return [join(home, "Library", "Application Support", browser.macProfile)];
  }
  if (platform === "linux") {
    const out: string[] = [];
    if (browser.linuxProfile) out.push(join(home, ".config", browser.linuxProfile));
    if (browser.linuxFlatpakProfile) out.push(join(home, browser.linuxFlatpakProfile));
    return out;
  }
  return [];
}

// Clean env for spawning user-facing browsers: never leak ELECTRON_RUN_AS_NODE or Electron internals.
export function cleanBrowserEnv(): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {
    PATH: process.env.PATH ?? "/usr/bin:/bin",
    HOME: homedir(),
  };
  const keys = [
    "USER",
    "LOGNAME",
    "LANG",
    "LC_ALL",
    "TMPDIR",
    "DISPLAY",
    "WAYLAND_DISPLAY",
    "XDG_RUNTIME_DIR",
    "XDG_CURRENT_DESKTOP",
    "DBUS_SESSION_BUS_ADDRESS",
  ];
  for (const key of keys) {
    if (process.env[key]) env[key] = process.env[key];
  }
  return env;
}

export async function detectMacDefaultBrowser(): Promise<DetectedDefaultBrowser | null> {
  try {
    const { stdout } = await run(
      "/usr/bin/osascript",
      [
        "-l",
        "JavaScript",
        "-e",
        `ObjC.import("AppKit");
(() => {
  const url = $.NSWorkspace.sharedWorkspace.URLForApplicationToOpenURL($.NSURL.URLWithString("https://example.com"));
  if (!url || url.isNil()) return "{}";
  const bundle = $.NSBundle.bundleWithURL(url);
  if (!bundle || bundle.isNil()) return "{}";
  const bundleId = bundle.bundleIdentifier && !bundle.bundleIdentifier.isNil() ? bundle.bundleIdentifier.js : null;
  const name = $.NSFileManager.defaultManager.displayNameAtPath(url.path).js.replace(/\\.app$/, "");
  const execUrl = bundle.executableURL;
  const executablePath = execUrl && !execUrl.isNil() ? execUrl.path.js : null;
  return JSON.stringify({ bundleId, name, executablePath });
})()`,
      ],
      { timeout: 10_000 },
    );
    const parsed = JSON.parse(stdout.trim() || "{}") as Partial<DetectedDefaultBrowser>;
    if (!parsed.bundleId && !parsed.name) return null;
    return {
      bundleId: parsed.bundleId ?? null,
      name: parsed.name ?? null,
      executablePath: parsed.executablePath ?? null,
    };
  } catch {
    return null;
  }
}

async function detectLinuxDefaultBrowser(): Promise<DetectedDefaultBrowser | null> {
  try {
    const { stdout } = await run("xdg-settings", ["get", "default-web-browser"], {
      timeout: 5_000,
    });
    const desktop = stdout.trim();
    if (!desktop) return null;
    return { bundleId: desktop, name: desktop.replace(/\.desktop$/i, ""), executablePath: null };
  } catch {
    return null;
  }
}

export function probeTcpPort(port: number, timeoutMs = 400): Promise<boolean> {
  return new Promise<boolean>((resolve) => {
    const socket = connect({ host: "127.0.0.1", port });
    const done = (ok: boolean) => {
      clearTimeout(timer);
      socket.destroy();
      resolve(ok);
    };
    const timer = setTimeout(() => done(false), timeoutMs);
    socket.once("connect", () => done(true));
    socket.once("error", () => done(false));
  });
}

async function probeCdpHttpPort(port: number): Promise<boolean> {
  try {
    const response = await fetch(`http://127.0.0.1:${port}/json/version`, {
      signal: AbortSignal.timeout(500),
    });
    if (!response.ok) return false;
    const body = (await response.json()) as { webSocketDebuggerUrl?: unknown };
    return typeof body.webSocketDebuggerUrl === "string" && body.webSocketDebuggerUrl.length > 0;
  } catch {
    return false;
  }
}

async function findFallbackChromiumBrowser(
  platform: NodeJS.Platform,
  home: string,
  readDir: (path: string) => Promise<string[]>,
): Promise<KnownBrowser | null> {
  for (const browser of KNOWN_BROWSERS) {
    for (const dir of profilePathsFor(browser, platform, home)) {
      try {
        await readDir(dir);
        return browser;
      } catch (error) {
        // EPERM/EACCES proves the profile folder exists (just TCC-locked).
        if (isPermError(error)) return browser;
      }
    }
  }
  return null;
}

export async function inspectBrowserControl(
  deps: BrowserControlDeps = {},
): Promise<BrowserControlStatus> {
  const platform = deps.platform ?? process.platform;
  const home = deps.home ?? homedir();
  const readText = deps.readFile ?? ((path: string) => readFile(path, "utf8"));
  const readDir = deps.readdir ?? ((path: string) => readdir(path));
  const checkReadable = deps.accessReadable ?? ((path: string) => access(path, constants.R_OK));
  const tcpProbe = deps.probeTcp ?? probeTcpPort;
  const httpProbe = deps.probeCdpHttp ?? probeCdpHttpPort;

  if (platform !== "darwin" && platform !== "linux") {
    return {
      supported: false,
      browserName: "Browser",
      shortName: "Browser",
      bundleId: null,
      isDefault: false,
      inspectUrl: "chrome://inspect/#remote-debugging",
      fullDiskAccess: null,
      remoteDebugging: null,
      ready: false,
      reason: "Browser control is only available on macOS and Linux.",
    };
  }

  const detected = deps.detectDefault
    ? await deps.detectDefault()
    : platform === "darwin"
      ? await detectMacDefaultBrowser()
      : await detectLinuxDefaultBrowser();

  let browser =
    platform === "darwin"
      ? matchMacBrowser(detected?.bundleId ?? null)
      : matchLinuxBrowser(detected?.bundleId ?? null);
  let isDefault = browser !== null;

  if (!browser) {
    browser = await findFallbackChromiumBrowser(platform, home, readDir);
    isDefault = false;
  }

  if (!browser) {
    const unsupportedName = detected?.name || "Your default browser";
    return {
      supported: false,
      browserName: unsupportedName,
      shortName: unsupportedName,
      bundleId: detected?.bundleId ?? null,
      isDefault: Boolean(detected?.name),
      inspectUrl: "chrome://inspect/#remote-debugging",
      fullDiskAccess: null,
      remoteDebugging: null,
      ready: false,
      reason: `${unsupportedName} doesn't support background browser control. Use Chrome, Brave, Edge, Arc, Dia, or Comet.`,
    };
  }

  const profileDirs = profilePathsFor(browser, platform, home);
  let fullDiskAccess: boolean | null = null;
  let activePortText: string | null = null;
  let activePortBlocked = false;
  let sawReadableDir = false;

  for (const profileDir of profileDirs) {
    try {
      activePortText = await readText(join(profileDir, "DevToolsActivePort"));
      if (platform === "darwin") fullDiskAccess = true;
      sawReadableDir = true;
      break;
    } catch (error) {
      if (isPermError(error)) {
        activePortBlocked = true;
        if (platform === "darwin") fullDiskAccess = false;
        break;
      }
      if (platform === "darwin") {
        try {
          await readDir(profileDir);
          sawReadableDir = true;
          try {
            await checkReadable(join(profileDir, "Local State"));
            fullDiskAccess = true;
          } catch (localStateError) {
            if (isPermError(localStateError)) {
              activePortBlocked = true;
              fullDiskAccess = false;
            } else {
              fullDiskAccess = true;
            }
          }
          break;
        } catch (dirError) {
          if (isPermError(dirError)) {
            activePortBlocked = true;
            fullDiskAccess = false;
            break;
          }
          if (!isMissingError(dirError)) break;
        }
      }
    }
  }

  if (platform === "darwin" && fullDiskAccess === null && !sawReadableDir) {
    try {
      await readDir(join(home, "Library", "Safari"));
      fullDiskAccess = true;
    } catch (safariError) {
      fullDiskAccess = isPermError(safariError) ? false : null;
    }
  }

  let remoteDebugging: boolean | null = false;
  let fallbackPortLive = false;

  if (activePortText) {
    const firstLine = activePortText.split(/\r?\n/, 1)[0]?.trim() ?? "";
    const port = Number.parseInt(firstLine, 10);
    if (Number.isInteger(port) && port > 0 && port <= 65_535) {
      remoteDebugging = await tcpProbe(port);
    }
  }

  if (remoteDebugging !== true) {
    for (const port of [9222, 9223]) {
      if (await httpProbe(port)) {
        remoteDebugging = true;
        fallbackPortLive = true;
        break;
      }
    }
  }

  // If macOS blocked reading DevToolsActivePort and fallback ports aren't open, we cannot know
  // whether the user already toggled remote debugging on.
  if (remoteDebugging !== true && (activePortBlocked || fullDiskAccess === false)) {
    remoteDebugging = null;
  }

  const ready =
    remoteDebugging === true &&
    (platform !== "darwin" || fullDiskAccess !== false || fallbackPortLive);
  const reason = ready
    ? null
    : activePortBlocked || fullDiskAccess === false
      ? `macOS blocks ${browser.shortName}'s debug port without Full Disk Access.`
      : `Turn on remote debugging at ${browser.inspectUrl}.`;

  return {
    supported: true,
    browserName: browser.browserName,
    shortName: browser.shortName,
    bundleId: browser.bundleId,
    isDefault,
    inspectUrl: browser.inspectUrl,
    fullDiskAccess,
    remoteDebugging,
    ready,
    reason,
  };
}

async function resolveMacBrowserApp(
  bundleId: string,
): Promise<{ executablePath: string | null; running: boolean }> {
  try {
    const { stdout } = await run(
      "/usr/bin/osascript",
      [
        "-l",
        "JavaScript",
        "-e",
        `ObjC.import("AppKit");
(() => {
  const bid = ${JSON.stringify(bundleId)};
  const url = $.NSWorkspace.sharedWorkspace.URLForApplicationWithBundleIdentifier(bid);
  const bundle = url && !url.isNil() ? $.NSBundle.bundleWithURL(url) : null;
  const execUrl = bundle && !bundle.isNil() ? bundle.executableURL : null;
  const executablePath = execUrl && !execUrl.isNil() ? execUrl.path.js : null;
  const apps = $.NSRunningApplication.runningApplicationsWithBundleIdentifier(bid);
  let running = false;
  if (apps && !apps.isNil()) {
    for (let i = 0; i < apps.count; i++) {
      if (!apps.objectAtIndex(i).isTerminated) { running = true; break; }
    }
  }
  return JSON.stringify({ executablePath, running });
})()`,
      ],
      { timeout: 10_000, env: cleanBrowserEnv() },
    );
    const parsed = JSON.parse(stdout.trim() || "{}") as {
      executablePath?: string | null;
      running?: boolean;
    };
    return {
      executablePath: parsed.executablePath ?? null,
      running: Boolean(parsed.running),
    };
  } catch {
    return { executablePath: null, running: false };
  }
}

export async function openBrowserInspectPage(status: BrowserControlStatus): Promise<void> {
  if (!status.supported) return;
  const env = cleanBrowserEnv();
  if (process.platform === "darwin") {
    const bundleId = status.bundleId;
    if (!bundleId) return;
    const { executablePath, running } = await resolveMacBrowserApp(bundleId);
    // Cold-start through LaunchServices (`open -b`) so the browser isn't owned as Cloudroom's child.
    if (!running) {
      await run("/usr/bin/open", ["-b", bundleId], { env }).catch(() => {});
      await sleep(800);
    }
    if (executablePath) {
      const child = spawn(executablePath, [status.inspectUrl], {
        detached: true,
        stdio: "ignore",
        env,
      });
      child.on("error", () => {});
      child.unref();
      return;
    }
    if (running) {
      await run("/usr/bin/open", ["-b", bundleId], { env }).catch(() => {});
    }
    return;
  }
  if (process.platform === "linux") {
    const browser = KNOWN_BROWSERS.find((b) => b.bundleId === status.bundleId);
    for (const bin of browser?.linuxBins ?? []) {
      const found = await run("which", [bin], { env }).then(
        ({ stdout }) => stdout.trim(),
        () => "",
      );
      if (found) {
        const child = spawn(found, [status.inspectUrl], {
          detached: true,
          stdio: "ignore",
          env,
        });
        child.on("error", () => {});
        child.unref();
        return;
      }
    }
  }
}
