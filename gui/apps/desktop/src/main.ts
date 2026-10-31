import { randomUUID } from "node:crypto";
import { accessSync, constants as fsConstants, readFileSync } from "node:fs";
import { rm } from "node:fs/promises";
import { arch, homedir, release, type as osType } from "node:os";
import { dirname, join, resolve } from "node:path";
import {
  app,
  autoUpdater as squirrelUpdater,
  BrowserWindow,
  clipboard,
  dialog,
  ipcMain,
  nativeImage,
  nativeTheme,
  net,
  powerMonitor,
  safeStorage,
  screen,
  session,
  shell,
  type Event,
  type IpcMainEvent,
  type IpcMainInvokeEvent,
  type PermissionRequest,
  type WebContents,
} from "electron";
import { autoUpdater } from "electron-updater";
import {
  APP_SURFACE_DESKTOP,
  APP_SURFACE_ENV_NAME,
} from "@cloudroom/config/app-surface";
import { applyPackagedDesktopRuntimeEnv } from "@cloudroom/config/runtime";
import type { ConnectCredential } from "@cloudroom/connect-client";
import { COMPUTER, type AppKeybindings } from "@cloudroom/domain";
import {
  bbDesktopBrowserImportCookiesRequestSchema,
  bbDesktopThemeSchema,
  type BbDesktopInfo,
  type BbDesktopWindowState,
} from "@cloudroom/desktop-contract";
import { installSocketTypeOfServiceGuard } from "@cloudroom/process-utils/socket-type-of-service";
import {
  serverMessageLenientSchema,
  type ClientMessage,
} from "@cloudroom/server-contract";
import { z } from "zod";
import {
  assertPathExists,
  resolveDesktopBridgePath,
  resolveDesktopIconPath,
  type DesktopPathContext,
} from "./app-paths.js";
import {
  ensureRoomCliShim,
  resolveBundledRoomCliPath,
} from "./room-cli-shim.js";
import { ensureLinuxDesktopEntry } from "./linux-desktop-entry.js";
import {
  resolveBbAppProcessRuntime,
  type BbAppProcess,
  type BbAppProcessExit,
  startBbAppProcess,
} from "./bb-process.js";
import { openExistingServerDialog } from "./existing-server-dialog.js";
import {
  readForeignRuntimeDetails,
  stopForeignRuntime,
} from "./foreign-runtime.js";
import {
  decideAppWindowNavigation,
  isAllowedAppPermission,
  isAppWindowMainFrame,
  isHttpOrigin,
  isSensitiveAppSender,
} from "./desktop-app-window-policy.js";
import { createLocalViewUrl, STARTUP_RETRY_CHANNEL } from "./local-view.js";
import { installApplicationMenu } from "./menu.js";
import {
  DEFAULT_APPLICATION_MENU_ACCELERATORS,
  resolveApplicationMenuAccelerators,
} from "./desktop-menu-shortcuts.js";
import {
  clearOwnedRuntimePidFile,
  reapStaleOwnedRuntime,
  writeOwnedRuntimePidFile,
} from "./owned-runtime-supervisor.js";
import {
  probeBbServer,
  waitForCompatibleServer,
  type CompatibleServerProbeResult,
  type ServerProbeResult,
} from "./server-probe.js";
import { loadRemoteServerPage } from "./remote-server-load.js";
import {
  BUILTIN_SERVER_NAME,
  createServerTargetStore,
  SERVER_TARGET_FILE_NAME,
  type ConnectServerRef,
  type ServerTargetStore,
} from "./server-target.js";
import { openServerUrlDialog } from "./server-url-dialog.js";
import {
  computerName,
  createComputersSync,
  fetchRelayCredential,
  isRelayUrl,
  listComputers,
  createRelaySessionKeeper,
  OPEN_RETRY_MS,
  openComputer,
  RELAY_URL_PATTERN,
  relayCookieOrigins,
  RELAY_CREDENTIAL_FILE_NAME,
  type ComputerList,
  type ComputersFailure,
  type ComputersSync,
  type RelaySessionKeeper,
} from "./computers.js";
import {
  createConnectCredentialCache,
  type ConnectCredentialCache,
} from "./connect-credential-cache.js";
import {
  createDesktopShutdownState,
  registerDesktopShutdownSignalHandlers,
} from "./desktop-shutdown.js";
import {
  createDesktopWindowFactory,
  type DesktopBrowserWindow,
  type DesktopBrowserWindowCreator,
  type DesktopWindowFactory,
} from "./desktop-window-factory.js";
import {
  hasLinuxWindowArgument,
  LINUX_FRAMELESS_WINDOW_ARGUMENT,
  LINUX_TRANSPARENT_WINDOW_ARGUMENT,
} from "./desktop-linux-window-options.js";
import {
  createDesktopAboutDialogOptions,
  createDesktopAboutPanelOptions,
  type DesktopAboutFacts,
} from "./desktop-about-panel.js";
import { registerDesktopContextMenu } from "./desktop-context-menu.js";
import { saveCrash, startCrashReports, watchWindowCrashes } from "./desktop-crash-report.js";
import {
  getDesktopVersion,
  resolveBbDesktopPlatform,
} from "./desktop-platform.js";
import { createDesktopUpdateService } from "./desktop-update-check.js";
import {
  createDesktopUpdateFeedUrl,
  DESKTOP_RELEASE_CHANNEL,
  DESKTOP_RELEASE_INFO,
  resolveDesktopUpdateSupport,
} from "./desktop-update-provider.js";
import type { DesktopUpdateService } from "./desktop-update-scheduler.js";
import {
  createDesktopAutoUpdateService,
  createElectronAutoUpdaterAdapter,
  shouldEnableDesktopAutoUpdate,
  type DesktopAutoUpdateLogger,
  type DesktopAutoUpdateService,
} from "./desktop-auto-update.js";
import { mergeDesktopUpdateInfo } from "./desktop-update-info.js";
import {
  reportDesktopUpdate,
  resumeThreadsAfterUpdate,
  runningLocalThreadIds,
  noteUpdateAttempt,
  saveUpdateAttempt,
  saveWindowsUpdateMarker,
  stopThreadsForUpdate,
  takeFailedWindowsUpdate,
} from "./desktop-update-resume.js";
import {
  installNeedsPassword,
  macAppLocation,
  reopenAfterExit,
  startIdleInstall,
  takeAppOwnership,
} from "./desktop-update-install.js";
import {
  BB_DESKTOP_CHECK_FOR_UPDATES_CHANNEL,
  BB_DESKTOP_GET_INFO_CHANNEL,
  BB_DESKTOP_INFO_CHANGED_CHANNEL,
  BB_DESKTOP_INSTALL_UPDATE_CHANNEL,
  BB_DESKTOP_OPEN_EXTERNAL_URL_CHANNEL,
  BB_DESKTOP_SET_THEME_CHANNEL,
  BB_DESKTOP_FOCUS_WINDOW_CHANNEL,
  BB_DESKTOP_SET_BADGE_COUNT_CHANNEL,
} from "./desktop-update-ipc.js";
import {
  BB_DESKTOP_APP_COMMAND_CHANNEL,
  BB_DESKTOP_CLOSE_WINDOW_REQUEST_CHANNEL,
  BB_DESKTOP_CLOSE_WINDOW_RESPONSE_CHANNEL,
  BB_DESKTOP_GET_WINDOW_STATE_CHANNEL,
  BB_DESKTOP_OPEN_LINK_CHANNEL,
  BB_DESKTOP_OPEN_NEW_TAB_CHANNEL,
  BB_DESKTOP_OPEN_COMPUTER_CHANNEL,
  BB_DESKTOP_OPEN_SERVER_DAEMON_LOGS_CHANNEL,
  BB_DESKTOP_TOP_RIGHT_DRAG_CHANNEL,
  BB_DESKTOP_WINDOW_STATE_CHANGED_CHANNEL,
  CLOSE_WINDOW_REQUEST_TIMEOUT_MS,
} from "./desktop-window-command-ipc.js";
import {
  createDesktopBrowserViewManager,
  type DesktopBrowserViewManager,
} from "./desktop-browser-view.js";
import { resolveDesktopBrowserAppCommand } from "./desktop-browser-shortcuts.js";
import { registerDesktopBrowserIpc } from "./desktop-browser-main-ipc.js";
import { createBrowserImportService } from "./browser-import/browser-import.js";
import { readMacAppIcon } from "./browser-import/mac-app-icon.js";
import {
  createDesktopBrowserBroker,
  type DesktopBrowserBroker,
} from "./desktop-browser-broker.js";
import { createDesktopBrowserBrokerClient } from "./desktop-browser-broker-client.js";
import { bbDesktopBrowserTabRefSchema } from "@cloudroom/desktop-contract";
import {
  BB_DESKTOP_BROWSER_TARGET_CHANNEL,
  BB_DESKTOP_BROWSER_GET_CONTROL_CHANNEL,
  BB_DESKTOP_BROWSER_RELEASE_CONTROL_CHANNEL,
  BB_DESKTOP_BROWSER_LIST_IMPORT_SOURCES_CHANNEL,
  BB_DESKTOP_BROWSER_IMPORT_COOKIES_CHANNEL,
  BB_DESKTOP_BROWSER_OPEN_FULL_DISK_ACCESS_SETTINGS_CHANNEL,
} from "./desktop-browser-ipc.js";
import { parseDesktopSystemConfig } from "./desktop-system-config.js";
import { ensurePackagedUserShellPath } from "./desktop-shell-path.js";
import { resolveDesktopReloadShortcut } from "./desktop-reload-shortcut.js";
import {
  createLogTailer,
  createLogLineBuffer,
  createLogViewerViewUrl,
  LOG_VIEWER_IPC_BATCH_INTERVAL_MS,
  LOG_VIEWER_IPC_BATCH_LINE_LIMIT,
  type LogLineBuffer,
  type LogTailer,
} from "./log-viewer.js";
import {
  LOG_VIEWER_APPEND_CHANNEL,
  LOG_VIEWER_COPY_CHANNEL,
  LOG_VIEWER_OPEN_LOGS_FOLDER_CHANNEL,
  LOG_VIEWER_SNAPSHOT_CHANNEL,
  LOG_VIEWER_VISIBLE_LINE_LIMIT,
  type LogViewerLine,
  type LogViewerCopyRequest,
  type LogViewerOpenLogsFolderResult,
} from "./log-viewer-contract.js";
import {
  ATTACH_PROBE_TIMEOUT_MS,
  DEFAULT_BB_SERVER_URL,
  PROCESS_LOG_LINE_LIMIT,
  STARTUP_POLL_INTERVAL_MS,
  STARTUP_TIMEOUT_MS,
  type RuntimeOwnership,
  type WindowStateKey,
} from "./types.js";

installSocketTypeOfServiceGuard();

const OWNED_RUNTIME_STOP_TIMEOUT_MS = 6_000;
const OWNED_RUNTIME_KILL_TIMEOUT_MS = 1_000;
const UPDATE_QUIT_TIMEOUT_MS = 60_000;
const FOREIGN_RUNTIME_STOP_TIMEOUT_MS = 15_000;
const FOREIGN_RUNTIME_KILL_TIMEOUT_MS = 3_000;
const REMOTE_SYSTEM_CONFIG_POLL_INTERVAL_MS = 5 * 60 * 1000;

interface DesktopRuntime {
  bbProcess: BbAppProcess | null;
  ownership: RuntimeOwnership;
  serverUrl: string;
  userDataPath: string | null;
}

interface LoadStartupErrorArgs {
  details: string;
  logs: string;
  retryable: boolean;
  title: string;
}

interface LoadWindowUrlArgs {
  url: string;
}

interface CreateApplicationWindowArgs {
  initialUrl: string | null;
  stateKey: WindowStateKey | null;
}

interface StartOwnedRuntimeArgs {
  bridgePath: string;
  serverUrl: string;
  userDataPath: string;
}

interface SendLogViewerSnapshotArgs {
  browserWindow: BrowserWindow;
  lines: LogViewerLine[];
  logDir: string;
}

interface LoadLogViewerWindowArgs {
  logDir: string;
  preloadPath: string;
}

type StartupRaceResult =
  | ProcessExitedStartupRaceResult
  | ServerProbeStartupRaceResult;

interface ProcessExitedStartupRaceResult {
  exit: BbAppProcessExit;
  kind: "process-exited";
}

interface ServerProbeStartupRaceResult {
  kind: "server-probe";
  result: ServerProbeResult;
}

interface ResolveDataDirFromEnvArgs {
  env: NodeJS.ProcessEnv;
  homeDir: string;
}

interface ResolveDesktopServerUrlArgs {
  env: NodeJS.ProcessEnv;
}

interface ResolveDesktopWindowUrlArgs {
  env: NodeJS.ProcessEnv;
  serverUrl: string;
}

interface ResolveDesktopUpdateFeedUrlArgs {
  env: NodeJS.ProcessEnv;
  platform: BbDesktopInfo["platform"];
}

interface SystemConfigRequestArgs {
  fetchImpl: typeof fetch;
  serverUrl: string;
}

interface SystemConfigSync {
  stop(): void;
}

const logViewerCopyRequestSchema = z
  .object({
    text: z.string(),
  })
  .strict();

let desktopWindowFactory: DesktopWindowFactory | null = null;
let desktopBrowserViewManager: DesktopBrowserViewManager | null = null;
let desktopBrowserBroker: DesktopBrowserBroker | null = null;
let desktopBrowserBrokerClient: ReturnType<
  typeof createDesktopBrowserBrokerClient
> | null = null;
let currentAppKeybindings: AppKeybindings = [];
let currentApplicationMenuAccelerators = DEFAULT_APPLICATION_MENU_ACCELERATORS;
let desktopUpdateService: DesktopUpdateService | null = null;
let desktopAutoUpdateService: DesktopAutoUpdateService | null = null;
let idleInstall: ReturnType<typeof startIdleInstall> | null = null;
let currentRuntime: DesktopRuntime | null = null;
let currentWindowUrl: string | null = null;
let logViewerLineBuffer: LogLineBuffer | null = null;
let logViewerPreloadPath: string | null = null;
let logViewerTailer: LogTailer | null = null;
let logViewerWindow: BrowserWindow | null = null;
let systemConfigSync: SystemConfigSync | null = null;
let systemConfigRefreshToken = 0;
let refreshRemoteSystemConfig: (() => void) | null = null;
const applicationWindowWebContentsIds = new Set<number>();
let bbAppLoaded = false;
let startupRetryUrl: string | null = null;
let startupRetryPending = false;
let stoppingForQuit = false;
let quitting = false;
let serverTargetStore: ServerTargetStore | null = null;
let computersSync: ComputersSync | null = null;
let relaySessionKeeper: RelaySessionKeeper | null = null;
let serverTargetGeneration = 0;
let computerList: ComputerList | null = null;
let computersSkipReason: ComputersFailure | null = null;
let relayCredentialCache: ConnectCredentialCache | null = null;
let relayCredential: ConnectCredential | null = null;
// Set while this Mac stands in for the chosen Mac because it was offline at launch.
let computerFallback: { handle: string; name: string; back: boolean } | null = null;
let thisComputerName = BUILTIN_SERVER_NAME;
let builtinServerUrl: string = DEFAULT_BB_SERVER_URL;
let desktopBridgePath: string | null = null;
let desktopUserDataPath: string | null = null;
let serverUrlDialogPreloadPath: string | null = null;
let existingServerDialogPreloadPath: string | null = null;

function resolveDesktopServerUrl(args: ResolveDesktopServerUrlArgs): string {
  const rawPort = args.env.BB_SERVER_PORT?.trim();
  if (rawPort === undefined || rawPort.length === 0) {
    return DEFAULT_BB_SERVER_URL;
  }

  const port = Number(rawPort);
  if (Number.isInteger(port) && port >= 1 && port <= 65_535) {
    return `http://127.0.0.1:${port}`;
  }

  throw new Error("BB_SERVER_PORT must be a valid TCP port");
}

function resolveDesktopWindowUrl(args: ResolveDesktopWindowUrlArgs): string {
  const rawAppUrl = args.env.BB_DESKTOP_APP_URL?.trim();
  if (rawAppUrl === undefined || rawAppUrl.length === 0) {
    return args.serverUrl;
  }
  let parsedAppUrl: URL;
  try {
    parsedAppUrl = new URL(rawAppUrl);
  } catch {
    throw new Error("BB_DESKTOP_APP_URL must be a valid URL");
  }
  if (parsedAppUrl.protocol !== "http:" && parsedAppUrl.protocol !== "https:") {
    throw new Error("BB_DESKTOP_APP_URL must be an http(s) URL");
  }
  return rawAppUrl;
}

function canReplaceAppImage(appImagePath: string): boolean {
  try {
    accessSync(
      dirname(appImagePath),
      // oxlint-disable-next-line no-bitwise
      fsConstants.W_OK | fsConstants.X_OK,
    );
    return true;
  } catch {
    return false;
  }
}

function resolveDesktopUpdateFeedUrl(
  args: ResolveDesktopUpdateFeedUrlArgs,
): string {
  const rawFeedUrl = args.env.BB_DESKTOP_VERSION_FEED_URL?.trim();
  if (rawFeedUrl === undefined || rawFeedUrl.length === 0) {
    return createDesktopUpdateFeedUrl(args.platform);
  }
  return rawFeedUrl;
}

function readDesktopAboutFacts(applicationName: string): DesktopAboutFacts {
  return {
    applicationName,
    buildDate: process.env.BB_DESKTOP_BUILD_DATE ?? "",
    channel: DESKTOP_RELEASE_CHANNEL,
    commit: process.env.BB_DESKTOP_COMMIT ?? "",
    electronVersion: process.versions.electron,
    osArch: arch(),
    osRelease: release(),
    osType: osType(),
    platform: process.platform,
    pluginSdkVersion: process.env.BB_DESKTOP_PLUGIN_SDK_VERSION ?? "",
    version: getDesktopVersion(process.env.BB_DESKTOP_VERSION),
  };
}

function installAboutPanel(applicationName: string): void {
  app.setAboutPanelOptions(
    createDesktopAboutPanelOptions(readDesktopAboutFacts(applicationName)),
  );
}

async function showAboutDialog(): Promise<void> {
  const { copyButtonId, ...messageBoxOptions } =
    createDesktopAboutDialogOptions(
      readDesktopAboutFacts(app.getName()),
      Date.now(),
    );
  const parentWindow = getFocusedApplicationWindow();
  const result =
    parentWindow === null
      ? await dialog.showMessageBox(messageBoxOptions)
      : await dialog.showMessageBox(parentWindow, messageBoxOptions);
  if (result.response === copyButtonId) {
    await clipboard.writeText(messageBoxOptions.detail);
  }
}

function getCurrentDesktopInfo(): BbDesktopInfo | null {
  const info = mergeDesktopUpdateInfo({
    autoInfo: desktopAutoUpdateService?.getInfo() ?? null,
    feedInfo: desktopUpdateService?.getInfo() ?? null,
  });
  if (info === null) {
    return null;
  }
  return {
    ...info,
    computers: describeComputers(),
    serverDaemonLogsAvailable: shouldEnableServerDaemonLogsMenu(),
  };
}

function describeComputers(): BbDesktopInfo["computers"] {
  const target = serverTargetStore?.getTarget();
  const viewing =
    computerFallback === null && target?.kind === "connect" && isRelayUrl(target.server.url)
      ? target.server.handle
      : null;
  return {
    list: (computerList?.computers ?? []).map((computer) => ({
      handle: computer.handle,
      name: computer.name,
      online: computer.live,
      self: computer.handle === computerList?.selfHandle,
    })),
    viewing,
    fallback: computerFallback && { ...computerFallback },
  };
}

function resolveApplicationWindow(
  webContents: WebContents,
): BrowserWindow | null {
  return BrowserWindow.fromWebContents(webContents);
}

function sendToApplicationRenderer(
  browserWindow: BrowserWindow,
  channel: string,
  payload: unknown,
): void {
  if (!browserWindow.webContents.isDestroyed()) {
    browserWindow.webContents.send(channel, payload);
  }
}

function registerApplicationRendererReloadShortcut(
  webContents: WebContents,
): void {
  webContents.on("before-input-event", (event, input) => {
    const shortcut = resolveDesktopReloadShortcut(input);
    if (shortcut === null) {
      return;
    }
    event.preventDefault();
    const browserWindow = resolveApplicationWindow(webContents);
    if (browserWindow !== null) {
      desktopBrowserViewManager?.prepareWindowReload(browserWindow);
    }
    if (shortcut === "force-reload") {
      webContents.reloadIgnoringCache();
    } else {
      webContents.reload();
    }
  });
}

function reloadApplicationWindows(): void {
  for (const browserWindow of BrowserWindow.getAllWindows()) {
    if (!applicationWindowWebContentsIds.has(browserWindow.webContents.id)) continue;
    desktopBrowserViewManager?.prepareWindowReload(browserWindow);
    browserWindow.webContents.reload();
  }
}

function sendDesktopInfoChanged(): void {
  const info = getCurrentDesktopInfo();
  if (info === null) {
    return;
  }
  for (const browserWindow of BrowserWindow.getAllWindows()) {
    if (applicationWindowWebContentsIds.has(browserWindow.webContents.id)) {
      sendToApplicationRenderer(
        browserWindow,
        BB_DESKTOP_INFO_CHANGED_CHANNEL,
        info,
      );
    } else {
      browserWindow.webContents.send(BB_DESKTOP_INFO_CHANGED_CHANNEL, info);
    }
  }
}

function getDesktopWindowState(
  browserWindow: Pick<BrowserWindow, "isFullScreen" | "isFocused"> | null,
): BbDesktopWindowState {
  return {
    isFullScreen: browserWindow?.isFullScreen() ?? false,
    isFocused: browserWindow?.isFocused() ?? true,
  };
}

function getSenderDesktopWindowState(
  event: IpcMainInvokeEvent,
): BbDesktopWindowState {
  return getDesktopWindowState(resolveApplicationWindow(event.sender));
}

function sendDesktopWindowStateChanged(
  browserWindow: DesktopBrowserWindow,
): void {
  sendToApplicationRenderer(
    browserWindow as BrowserWindow,
    BB_DESKTOP_WINDOW_STATE_CHANGED_CHANNEL,
    getDesktopWindowState(browserWindow as BrowserWindow),
  );
}

const hideWindowsForTests = process.env.BB_DESKTOP_HIDE_WINDOWS === "1";

// Linux launchers can exit and close the pipe behind stdout/stderr. The next
// log write then fails (EPIPE) and Electron shows a crash dialog. Logs are
// best-effort, so drop them instead.
for (const stream of [process.stdout, process.stderr]) {
  stream.on("error", () => {});
}

const desktopLogger: DesktopAutoUpdateLogger = {
  error(message) {
    process.stderr.write(`${message}\n`);
  },
  info(message) {
    process.stderr.write(`${message}\n`);
  },
  warn(message) {
    process.stderr.write(`${message}\n`);
  },
};

function resolveDataDirFromEnv(args: ResolveDataDirFromEnvArgs): string {
  const rawDataDir = args.env.BB_DATA_DIR?.trim();
  if (rawDataDir === undefined || rawDataDir.length === 0) {
    return join(args.homeDir, ".gui-cloudroom");
  }
  if (rawDataDir === "~") {
    return args.homeDir;
  }
  if (rawDataDir.startsWith("~/")) {
    return resolve(args.homeDir, rawDataDir.slice(2));
  }
  return resolve(rawDataDir);
}

function formatLogDirectory(): string {
  return join(
    resolveDataDirFromEnv({
      env: process.env,
      homeDir: homedir(),
    }),
    "logs",
  );
}

function formatExitResult(result: BbAppProcessExit): string {
  if (result.code !== null) {
    return `exit code ${result.code}`;
  }
  return result.signal === null
    ? "without an exit code"
    : `signal ${result.signal}`;
}

function createDesktopPathContext(): DesktopPathContext {
  return {
    appPath: app.getAppPath(),
    isPackaged: app.isPackaged,
    resourcesPath: process.resourcesPath,
  };
}

function shouldEnableServerDaemonLogsMenu(): boolean {
  return (
    (process.platform === "darwin" ||
      process.platform === "linux" ||
      process.platform === "win32") &&
    currentRuntime?.ownership === "spawned"
  );
}

const pendingCloseWindowRequests = new Map<number, NodeJS.Timeout>();

function requestRendererWindowClose(browserWindow: BrowserWindow): void {
  const webContentsId = browserWindow.webContents.id;
  const pending = pendingCloseWindowRequests.get(webContentsId);
  if (pending !== undefined) {
    clearTimeout(pending);
  }
  pendingCloseWindowRequests.set(
    webContentsId,
    setTimeout(() => {
      pendingCloseWindowRequests.delete(webContentsId);
      if (!browserWindow.isDestroyed()) {
        browserWindow.close();
      }
    }, CLOSE_WINDOW_REQUEST_TIMEOUT_MS),
  );
  sendToApplicationRenderer(
    browserWindow,
    BB_DESKTOP_CLOSE_WINDOW_REQUEST_CHANNEL,
    null,
  );
}

function closeFocusedDetachedDevTools(): void {
  for (const browserWindow of BrowserWindow.getAllWindows()) {
    if (browserWindow.webContents.isDevToolsFocused()) {
      browserWindow.webContents.closeDevTools();
      return;
    }
  }
}

function getFocusedApplicationWindow(): BrowserWindow | null {
  const focused = BrowserWindow.getFocusedWindow();
  if (
    focused !== null &&
    !focused.isDestroyed() &&
    applicationWindowWebContentsIds.has(focused.webContents.id)
  ) {
    return focused;
  }
  for (const browserWindow of BrowserWindow.getAllWindows()) {
    if (
      !browserWindow.isDestroyed() &&
      applicationWindowWebContentsIds.has(browserWindow.webContents.id)
    ) {
      return browserWindow;
    }
  }
  return null;
}

function formatCustomServerName(url: string): string {
  try {
    const parsed = new URL(url);
    return parsed.host.length > 0 ? parsed.host : url;
  } catch {
    return url;
  }
}

function connectServerMenuId(handle: string): string {
  return `connect:${handle}`;
}

function listMenuConnectServers(): ConnectServerRef[] {
  const servers: ConnectServerRef[] = (computerList?.computers ?? [])
    .filter((computer) => computer.handle !== computerList?.selfHandle)
    .map(({ handle, name, url }) => ({ handle, name, url }));
  const selected = serverTargetStore?.getConnectServer() ?? null;
  if (
    selected !== null &&
    !servers.some((server) => server.handle === selected.handle)
  ) {
    servers.push(selected);
  }
  return servers;
}

function buildMenuServerItems(connectServers: ConnectServerRef[]): Array<{
  checked: boolean;
  id: string;
  name: string;
}> {
  const target = serverTargetStore?.getTarget() ?? { kind: "builtin" as const };
  const items = [
    {
      checked: target.kind === "builtin",
      id: "builtin",
      name: BUILTIN_SERVER_NAME,
    },
  ];
  for (const server of connectServers) {
    items.push({
      checked:
        target.kind === "connect" && target.server.handle === server.handle,
      id: connectServerMenuId(server.handle),
      name: server.name,
    });
  }
  const customUrl = serverTargetStore?.getCustomServerUrl() ?? null;
  if (customUrl !== null) {
    items.push({
      checked: target.kind === "custom",
      id: "custom",
      name: formatCustomServerName(customUrl),
    });
  }
  return items;
}

function refreshApplicationMenu(): void {
  const connectServers = listMenuConnectServers();
  installApplicationMenu({
    accelerators: currentApplicationMenuAccelerators,
    connectServersSkipReason:
      connectServers.length === 0 ? computersSkipReason : null,
    isLinux: process.platform === "linux",
    isMac: process.platform === "darwin",
    createNewWindow() {
      void createApplicationWindow({
        initialUrl: currentWindowUrl,
        stateKey: null,
      });
    },
    openAbout() {
      void showAboutDialog();
    },
    openNewTab() {
      const browserWindow = getFocusedApplicationWindow();
      if (browserWindow !== null) {
        sendToApplicationRenderer(
          browserWindow,
          BB_DESKTOP_OPEN_NEW_TAB_CHANNEL,
          null,
        );
        sendToApplicationRenderer(
          browserWindow,
          BB_DESKTOP_APP_COMMAND_CHANNEL,
          "panel.newTab",
        );
      }
    },
    openNewThread() {
      const browserWindow = getFocusedApplicationWindow();
      if (browserWindow !== null) {
        sendToApplicationRenderer(
          browserWindow,
          BB_DESKTOP_APP_COMMAND_CHANNEL,
          "thread.new",
        );
      }
    },
    archiveThread() {
      const browserWindow = getFocusedApplicationWindow();
      if (browserWindow !== null) {
        sendToApplicationRenderer(
          browserWindow,
          BB_DESKTOP_APP_COMMAND_CHANNEL,
          "thread.archive",
        );
      }
    },
    reopenClosedTab() {
      const browserWindow = getFocusedApplicationWindow();
      if (browserWindow !== null) {
        sendToApplicationRenderer(
          browserWindow,
          BB_DESKTOP_APP_COMMAND_CHANNEL,
          "panel.reopenClosedTab",
        );
      }
    },
    openSettings() {
      const browserWindow = getFocusedApplicationWindow();
      if (browserWindow !== null) {
        sendToApplicationRenderer(
          browserWindow,
          BB_DESKTOP_APP_COMMAND_CHANNEL,
          "settings.open",
        );
      }
    },
    reloadWindow(browserWindow, ignoreCache) {
      if (!(browserWindow instanceof BrowserWindow)) {
        return;
      }
      desktopBrowserViewManager?.prepareWindowReload(browserWindow);
      if (ignoreCache) {
        browserWindow.webContents.reloadIgnoringCache();
      } else {
        browserWindow.webContents.reload();
      }
    },
    closeWindowOrSideTab(browserWindow) {
      if (browserWindow === undefined) {
        closeFocusedDetachedDevTools();
        return;
      }
      if (
        !(browserWindow instanceof BrowserWindow) ||
        browserWindow === logViewerWindow
      ) {
        browserWindow.close();
        return;
      }
      requestRendererWindowClose(browserWindow);
    },
    openServerDaemonLogs() {
      void openServerDaemonLogs();
    },
    selectServer(serverId) {
      void setActiveServerTarget(serverId);
    },
    setServerUrl() {
      void openSetServerUrlDialog();
    },
    onServerMenuWillShow() {
      computersSync?.onListRequested();
    },
    serverDaemonLogsMenuEnabled: shouldEnableServerDaemonLogsMenu(),
    servers: buildMenuServerItems(connectServers),
  });
}

function setCurrentRuntime(runtime: DesktopRuntime | null): void {
  currentRuntime = runtime;
  if (runtime === null) {
    stopSystemConfigSync();
  } else {
    computersSync?.onRuntimeReady();
  }
  refreshApplicationMenu();
  if (runtime?.ownership !== "spawned") {
    closeServerDaemonLogsWindow();
  }
  sendDesktopInfoChanged();
}

function formatApiUrl(serverUrl: string): string {
  const url = new URL(serverUrl);
  url.pathname = "/api/v1/system/config";
  url.search = "";
  url.hash = "";
  return url.toString();
}

function formatRealtimeUrl(serverUrl: string): string {
  const url = new URL(serverUrl);
  url.protocol = url.protocol === "https:" ? "wss:" : "ws:";
  url.pathname = "/ws";
  url.search = "";
  url.hash = "";
  return url.toString();
}

async function fetchSystemConfig(args: SystemConfigRequestArgs) {
  const response = await args.fetchImpl(formatApiUrl(args.serverUrl));
  if (!response.ok) {
    throw new Error(
      `System config request failed with HTTP ${response.status}`,
    );
  }
  const payload: unknown = await response.json();
  return parseDesktopSystemConfig(payload);
}

function createSystemConfigSync(serverUrl: string): SystemConfigSync {
  const realtimeUrl = formatRealtimeUrl(serverUrl);
  const subscribeMessage: ClientMessage = {
    type: "subscribe",
    target: { kind: "system" },
  };
  let reconnectTimer: NodeJS.Timeout | null = null;
  let socket: WebSocket | null = null;
  let stopped = false;

  function clearReconnectTimer(): void {
    if (reconnectTimer === null) {
      return;
    }
    clearTimeout(reconnectTimer);
    reconnectTimer = null;
  }

  function scheduleReconnect(): void {
    if (stopped || reconnectTimer !== null) {
      return;
    }
    reconnectTimer = setTimeout(() => {
      reconnectTimer = null;
      connect();
    }, 1_000);
  }

  function handleMessage(event: MessageEvent): void {
    if (typeof event.data !== "string") {
      return;
    }
    try {
      const parsed = serverMessageLenientSchema.safeParse(
        JSON.parse(event.data),
      );
      if (!parsed.success) {
        return;
      }
      if (
        parsed.data.entity === "system" &&
        parsed.data.changes.includes("config-changed")
      ) {
        void refreshSystemConfig({ fetchImpl: fetch, serverUrl });
      }
    } catch {
      return;
    }
  }

  function connect(): void {
    if (stopped) {
      return;
    }
    socket = new WebSocket(realtimeUrl);
    socket.addEventListener("open", () => {
      socket?.send(JSON.stringify(subscribeMessage));
      void refreshSystemConfig({ fetchImpl: fetch, serverUrl });
    });
    socket.addEventListener("message", handleMessage);
    socket.addEventListener("close", scheduleReconnect);
    socket.addEventListener("error", () => {
      socket?.close();
    });
  }

  connect();

  return {
    stop(): void {
      stopped = true;
      clearReconnectTimer();
      socket?.close();
      socket = null;
    },
  };
}

async function refreshSystemConfig(
  args: SystemConfigRequestArgs,
): Promise<void> {
  const token = systemConfigRefreshToken + 1;
  systemConfigRefreshToken = token;
  try {
    const config = await fetchSystemConfig(args);
    if (token !== systemConfigRefreshToken) {
      return;
    }
    currentAppKeybindings = config.keybindings;
    currentApplicationMenuAccelerators = resolveApplicationMenuAccelerators(
      currentAppKeybindings,
    );
    refreshApplicationMenu();
  } catch (error) {
    if (token !== systemConfigRefreshToken) {
      return;
    }
    const message = error instanceof Error ? error.message : String(error);
    process.stderr.write(`Could not refresh system config: ${message}\n`);
  }
}

function createRemoteSystemConfigSync(serverUrl: string): SystemConfigSync {
  function refresh(): void {
    void refreshSystemConfig({
      fetchImpl: (input, init) =>
        net.fetch(input as string | Request, {
          ...init,
          credentials: "include",
        }),
      serverUrl,
    });
  }

  const timer = setInterval(refresh, REMOTE_SYSTEM_CONFIG_POLL_INTERVAL_MS);
  timer.unref();
  refreshRemoteSystemConfig = refresh;
  refresh();

  return {
    stop(): void {
      clearInterval(timer);
      refreshRemoteSystemConfig = null;
    },
  };
}

function stopSystemConfigSync(): void {
  systemConfigSync?.stop();
  systemConfigSync = null;
}

function startSystemConfigSync(serverUrl: string): void {
  systemConfigSync?.stop();
  systemConfigSync = createSystemConfigSync(serverUrl);
  void refreshSystemConfig({ fetchImpl: fetch, serverUrl });
}

function startRemoteSystemConfigSync(serverUrl: string): void {
  systemConfigSync?.stop();
  systemConfigSync = createRemoteSystemConfigSync(serverUrl);
}

const pendingOpenLinks: string[] = [];

function deliverArgvShareLink(argv: readonly string[]): void {
  if (process.platform === "darwin") return;
  const url = argv.find((arg) => arg.startsWith("cloudroom://share/"));
  if (url !== undefined) deliverOpenLink(url);
}

function deliverOpenLink(url: string): void {
  const browserWindow = getFocusedApplicationWindow();
  if (browserWindow === null || browserWindow.webContents.isLoading()) {
    pendingOpenLinks.push(url);
    return;
  }
  sendToApplicationRenderer(browserWindow, BB_DESKTOP_OPEN_LINK_CHANNEL, url);
}

function registerApplicationWindow(browserWindow: DesktopBrowserWindow): void {
  const webContentsId = browserWindow.webContents.id;
  (browserWindow as BrowserWindow).webContents.on("did-finish-load", () => {
    for (const url of pendingOpenLinks.splice(0)) {
      sendToApplicationRenderer(browserWindow as BrowserWindow, BB_DESKTOP_OPEN_LINK_CHANNEL, url);
    }
  });
  applicationWindowWebContentsIds.add(webContentsId);
  const nativeWindow = BrowserWindow.fromId(browserWindow.id);
  if (nativeWindow !== null) desktopBrowserBroker?.registerWindow(nativeWindow);
  registerApplicationRendererReloadShortcut(
    (browserWindow as BrowserWindow).webContents,
  );
  registerDesktopContextMenu({ webContents: browserWindow.webContents });
  browserWindow.on("enter-full-screen", () => {
    sendDesktopWindowStateChanged(browserWindow);
  });
  browserWindow.on("leave-full-screen", () => {
    sendDesktopWindowStateChanged(browserWindow);
  });
  (browserWindow as BrowserWindow).on("focus", () => {
    sendDesktopWindowStateChanged(browserWindow);
  });
  (browserWindow as BrowserWindow).on("blur", () => {
    sendDesktopWindowStateChanged(browserWindow);
  });
  (browserWindow as BrowserWindow).on("will-move", () => {
    const bounds = browserWindow.getBounds();
    const cursor = screen.getCursorScreenPoint();
    const x = cursor.x - bounds.x;
    const y = cursor.y - bounds.y;
    if (y < 60 && bounds.width - x < 140) {
      sendToApplicationRenderer(
        browserWindow as BrowserWindow,
        BB_DESKTOP_TOP_RIGHT_DRAG_CHANNEL,
        `${x},${y}`,
      );
    }
  });
  browserWindow.on("closed", () => {
    desktopBrowserBroker?.releaseWindow(webContentsId);
    applicationWindowWebContentsIds.delete(webContentsId);
  });
}

async function ensureBuiltinRuntimeAttached(): Promise<boolean> {
  if (currentRuntime !== null) {
    return true;
  }
  if (desktopBridgePath === null || desktopUserDataPath === null) {
    return false;
  }

  const existingProbe = await probeBbServer({
    serverUrl: builtinServerUrl,
    timeoutMs: ATTACH_PROBE_TIMEOUT_MS,
  });

  if (existingProbe.kind === "compatible") {
    setCurrentRuntime({
      bbProcess: null,
      ownership: "attached",
      serverUrl: existingProbe.serverUrl,
      userDataPath: null,
    });
    return true;
  }

  if (existingProbe.kind === "incompatible") {
    return false;
  }

  const runtime = await startOwnedRuntime({
    bridgePath: desktopBridgePath,
    serverUrl: builtinServerUrl,
    userDataPath: desktopUserDataPath,
  });
  return runtime !== null;
}

async function retryStartup(): Promise<void> {
  if (startupRetryUrl === null || startupRetryPending) {
    return;
  }
  startupRetryPending = true;
  startupRetryUrl = null;
  try {
    await loadLoadingView();
    await applyServerTarget();
  } catch (error) {
    await loadStartupError({
      details: error instanceof Error ? error.message : String(error),
      logs: "",
      retryable: false,
      title: "Could not open Cloudroom",
    });
  } finally {
    startupRetryPending = false;
  }
}

async function applyServerTarget(): Promise<void> {
  startupRetryUrl = null;
  desktopBrowserBrokerClient?.reconnect();
  if (serverTargetStore === null) {
    return;
  }
  let target = serverTargetStore.getTarget();
  serverTargetGeneration += 1;
  const generation = serverTargetGeneration;
  const isCurrent = (): boolean => serverTargetGeneration === generation;
  setComputerFallback(null);
  relaySessionKeeper?.clear();

  if (target.kind === "custom" && new URL(target.url).hostname.endsWith(".getbb.app")) {
    desktopLogger.info(
      `[desktop] ${target.url} was a getbb.app address, which no longer works — opening ${BUILTIN_SERVER_NAME}`,
    );
    await serverTargetStore.setCustomServerUrl(null);
    target = serverTargetStore.getTarget();
  }

  // Your other Mac on cloudroom.run. If it doesn't answer, use this Mac until it's back.
  if (target.kind === "connect") {
    if (!isRelayUrl(target.server.url)) {
      desktopLogger.info(
        `[desktop] ${target.server.name} was a getbb.app address, which no longer works — opening ${BUILTIN_SERVER_NAME}`,
      );
      await serverTargetStore.setTarget("builtin");
    } else if (await openRelayComputer(target.server.handle, isCurrent)) {
      refreshApplicationMenu();
      return;
    } else {
      if (!isCurrent()) {
        return;
      }
      desktopLogger.info(
        `[desktop] ${target.server.name} did not answer — opening ${BUILTIN_SERVER_NAME} instead`,
      );
      setComputerFallback({ handle: target.server.handle, name: target.server.name, back: false });
    }
  }

  if (target.kind !== "custom") {
    const attached = await ensureBuiltinRuntimeAttached();
    if (!isCurrent()) {
      return;
    }
    if (!attached) {
      await loadStartupError({
        details:
          `Could not connect to the local Cloudroom server on this ${COMPUTER}. Check that the port is free or that a compatible Cloudroom server is running.`,
        logs: "",
        retryable: true,
        title: "Could not connect",
      });
      refreshApplicationMenu();
      return;
    }
    const localServerUrl = currentRuntime?.serverUrl ?? builtinServerUrl;
    startSystemConfigSync(localServerUrl);
    await loadBbApp(
      resolveDesktopWindowUrl({
        env: process.env,
        serverUrl: localServerUrl,
      }),
    );
  } else {
    await loadRemoteServerTarget(target.url, isCurrent);
    if (!isCurrent()) {
      return;
    }
  }
  refreshApplicationMenu();
}

function setComputerFallback(fallback: typeof computerFallback): void {
  if (fallback === null && computerFallback === null) return;
  computerFallback = fallback;
  computersSync?.setFallback(fallback !== null);
  desktopBrowserBrokerClient?.reconnect();
  sendDesktopInfoChanged();
}

async function getRelayCredential(startLocal: boolean): Promise<ConnectCredential | null> {
  if (relayCredential === null && currentRuntime === null && startLocal) await ensureBuiltinRuntimeAttached();
  // The Connect plugin owns the key. The saved copy only opens another Mac fast at launch; once the plugin answers, it wins.
  if (currentRuntime !== null) {
    const current = await fetchRelayCredential(currentRuntime.serverUrl);
    if (current !== undefined) await setRelayCredential(current);
  }
  return relayCredential;
}

/** Signed out (no key) or signed in to another account (a new address): also forget that account's other Macs. */
async function setRelayCredential(next: ConnectCredential | null): Promise<void> {
  const previous = relayCredential;
  relayCredential = next;
  if (next === null) await relayCredentialCache?.clear();
  else if (next.credential !== previous?.credential) await relayCredentialCache?.write(next);
  if (next === null || (previous !== null && previous.handle !== next.handle)) await forgetOtherMacs();
}

/** Drops the other Macs from the menus, signs this app out of them, deletes their saved data, and shows this Mac. */
async function forgetOtherMacs(): Promise<void> {
  const origins = new Set(await relayCookieOrigins(session.defaultSession.cookies));
  for (const computer of computerList?.computers ?? []) origins.add(new URL(computer.url).origin);
  const remembered = serverTargetStore?.getConnectServer();
  if (remembered) origins.add(new URL(remembered.url).origin);
  if (origins.size === 0 && computerList === null && !remembered) return;
  computerList = null;
  relaySessionKeeper?.clear();
  await Promise.all([...origins].map((origin) => session.defaultSession.clearStorageData({ origin }).catch(() => {})));
  if (await serverTargetStore?.forgetConnectServer()) void applyServerTarget();
  refreshApplicationMenu();
  sendDesktopInfoChanged();
}

async function clearRelayCredential(): Promise<void> {
  relayCredential = null;
  await relayCredentialCache?.clear();
}

async function openRelayComputer(handle: string, isCurrent: () => boolean): Promise<boolean> {
  const giveUpAt = Date.now() + OPEN_RETRY_MS;
  let retryDelayMs = 1_000;
  let credentialRetried = false;
  for (;;) {
    const credential = await getRelayCredential(true);
    if (credential === null || !isCurrent()) return false;
    const opened = await openComputer(credential, handle, session.defaultSession.cookies);
    if (opened.ok) {
      if (!isCurrent() || !(await loadRemoteServerTarget(opened.value.url, isCurrent, true))) return false;
      relaySessionKeeper?.track(handle, opened.value);
      return true;
    }
    desktopLogger.info(`[desktop] could not open Mac ${handle} (${opened.reason})`);
    if (opened.reason === "unauthorized") {
      // One more try covers a key the Connect plugin replaced since this app saved it.
      if (credentialRetried) return false;
      credentialRetried = true;
      await clearRelayCredential();
      continue;
    }
    if (Date.now() + retryDelayMs > giveUpAt) return false;
    await new Promise((resolve) => setTimeout(resolve, retryDelayMs));
    retryDelayMs = Math.min(retryDelayMs * 2, 8_000);
  }
}

/** Opens one of your Macs in this window; null or this Mac's handle means this Mac. */
async function openComputerTarget(handle: string | null): Promise<void> {
  if (serverTargetStore === null) return;
  if (handle === null || handle === computerList?.selfHandle) {
    await serverTargetStore.setTarget("builtin");
  } else {
    const computer = listMenuConnectServers().find((candidate) => candidate.handle === handle);
    if (computer === undefined) return;
    await serverTargetStore.setConnectServer(computer);
  }
  await applyServerTarget();
}

// Another Mac can answer the relay and then never finish loading. Give up and open this Mac instead.
const OTHER_MAC_LOAD_TIMEOUT_MS = 20_000;

function withTimeout<T>(promise: Promise<T>, ms: number): Promise<T> {
  promise.catch(() => {}); // Loading this Mac later aborts the stuck page; nobody needs that error.
  return Promise.race([
    promise,
    new Promise<never>((_, reject) => {
      setTimeout(() => reject(new Error(`no answer after ${ms / 1000} s`)), ms).unref();
    }),
  ]);
}

/** `otherMac`: one of your Macs on the relay. It gets a time limit and no error page, because the caller falls back to this Mac. */
async function loadRemoteServerTarget(
  serverUrl: string,
  isCurrent: () => boolean,
  otherMac = false,
): Promise<boolean> {
  const loaded = await loadRemoteServerPage({
    isCurrent,
    loadStartupError: otherMac ? async () => {} : loadStartupError,
    loadUrl: otherMac
      ? (args) => withTimeout(loadWindowUrl(args), OTHER_MAC_LOAD_TIMEOUT_MS)
      : loadWindowUrl,
    logWarning: (message) => {
      desktopLogger.warn(message);
    },
    serverUrl,
  });
  if (!loaded || !isCurrent()) {
    return loaded;
  }
  bbAppLoaded = true;
  startRemoteSystemConfigSync(serverUrl);
  return true;
}

async function setActiveServerTarget(serverId: string): Promise<void> {
  if (serverTargetStore === null) {
    return;
  }
  if (serverId.startsWith("connect:")) {
    const handle = serverId.slice("connect:".length);
    const server = listMenuConnectServers().find(
      (candidate) => candidate.handle === handle,
    );
    if (server === undefined) {
      refreshApplicationMenu();
      return;
    }
    await serverTargetStore.setConnectServer(server);
    await applyServerTarget();
    return;
  }
  if (serverId !== "builtin" && serverId !== "custom") {
    return;
  }
  const switched = await serverTargetStore.setTarget(serverId);
  if (!switched) {
    refreshApplicationMenu();
    return;
  }
  await applyServerTarget();
}

async function openSetServerUrlDialog(): Promise<void> {
  if (serverTargetStore === null || serverUrlDialogPreloadPath === null) {
    return;
  }
  const result = await openServerUrlDialog({
    initialUrl: serverTargetStore.getCustomServerUrl(),
    parentWindow: getFocusedApplicationWindow(),
    preloadPath: serverUrlDialogPreloadPath,
  });
  if (result.kind === "cancelled") {
    return;
  }
  if (
    result.kind === "clear" &&
    serverTargetStore.getCustomServerUrl() === null
  ) {
    return;
  }
  await serverTargetStore.setCustomServerUrl(
    result.kind === "set" ? result.url : null,
  );
  await applyServerTarget();
}

function sendLogViewerSnapshot(args: SendLogViewerSnapshotArgs): void {
  if (args.browserWindow.isDestroyed()) {
    return;
  }
  args.browserWindow.webContents.send(LOG_VIEWER_SNAPSHOT_CHANNEL, {
    lines: args.lines,
    logDir: args.logDir,
  });
}

function closeServerDaemonLogsWindow(): void {
  logViewerTailer?.stop();
  logViewerTailer = null;
  logViewerLineBuffer?.stop();
  logViewerLineBuffer = null;

  const browserWindow = logViewerWindow;
  logViewerWindow = null;
  if (browserWindow !== null && !browserWindow.isDestroyed()) {
    browserWindow.close();
  }
}

async function handleOpenLogsFolder(): Promise<LogViewerOpenLogsFolderResult> {
  if (!shouldEnableServerDaemonLogsMenu()) {
    throw new Error(
      "Server and daemon logs are only available for owned runtimes",
    );
  }

  const logDir = formatLogDirectory();
  const errorMessage = await shell.openPath(logDir);
  if (errorMessage.length > 0) {
    throw new Error(errorMessage);
  }
  return { path: logDir };
}

function installLogViewerIpcHandlers(): void {
  ipcMain.handle(
    LOG_VIEWER_COPY_CHANNEL,
    (_event, request: LogViewerCopyRequest) => {
      return clipboard.writeText(
        logViewerCopyRequestSchema.parse(request).text,
      );
    },
  );
  ipcMain.handle(LOG_VIEWER_OPEN_LOGS_FOLDER_CHANNEL, () =>
    handleOpenLogsFolder(),
  );
}

async function loadLogViewerWindow(
  args: LoadLogViewerWindowArgs,
): Promise<void> {
  const browserWindow = new BrowserWindow({
    height: 720,
    minHeight: 520,
    minWidth: 840,
    show: false,
    title: "Cloudroom - Server & Daemon Logs",
    titleBarStyle: "default",
    webPreferences: {
      contextIsolation: true,
      nodeIntegration: false,
      preload: args.preloadPath,
      sandbox: true,
    },
    width: 1180,
  });
  const tailer = createLogTailer({
    logDir: args.logDir,
    onLines(lines) {
      logViewerLineBuffer?.append(lines);
    },
  });
  const lineBuffer = createLogLineBuffer({
    flushIntervalMs: LOG_VIEWER_IPC_BATCH_INTERVAL_MS,
    flushLineCount: LOG_VIEWER_IPC_BATCH_LINE_LIMIT,
    maxLines: LOG_VIEWER_VISIBLE_LINE_LIMIT,
    onFlush(lines) {
      if (logViewerWindow === null || logViewerWindow.isDestroyed()) {
        return;
      }
      logViewerWindow.webContents.send(LOG_VIEWER_APPEND_CHANNEL, {
        lines,
      });
    },
  });

  logViewerLineBuffer = lineBuffer;
  logViewerTailer = tailer;
  logViewerWindow = browserWindow;

  browserWindow.once("ready-to-show", () => {
    browserWindow.show();
  });
  browserWindow.on("closed", () => {
    if (logViewerTailer === tailer) {
      logViewerTailer = null;
      tailer.stop();
    }
    if (logViewerWindow === browserWindow) {
      logViewerWindow = null;
    }
    if (logViewerLineBuffer === lineBuffer) {
      logViewerLineBuffer = null;
    }
    lineBuffer.stop();
  });

  await browserWindow.loadURL(createLogViewerViewUrl({ logDir: args.logDir }));
  sendLogViewerSnapshot({
    browserWindow,
    lines: lineBuffer.lines(),
    logDir: args.logDir,
  });
  await tailer.start();
}

async function openServerDaemonLogs(): Promise<void> {
  if (!shouldEnableServerDaemonLogsMenu() || logViewerPreloadPath === null) {
    return;
  }

  if (logViewerWindow !== null && !logViewerWindow.isDestroyed()) {
    logViewerWindow.focus();
    return;
  }

  await loadLogViewerWindow({
    logDir: formatLogDirectory(),
    preloadPath: logViewerPreloadPath,
  });
}

async function loadWindowUrl(args: LoadWindowUrlArgs): Promise<void> {
  startupRetryUrl = null;
  currentWindowUrl = args.url;
  if (desktopWindowFactory === null) {
    return;
  }

  await desktopWindowFactory.loadUrl({ url: args.url });
}

// The app window may only be navigated by the main process (loadURL, which does not fire these
// events) or reloaded; its authorized loads may still redirect. Any other renderer-initiated
// navigation is blocked, so an untrusted page can never inherit this window's preload, IPC, or
// permissions. Web links are handed to the system browser instead. Installed at window creation,
// before the first load, so no window is ever unguarded.
function installAppWindowNavigationGuard(webContents: WebContents): void {
  const guard = (
    event: Event,
    targetUrl: string,
    isMainFrame: boolean,
    kind: "navigate" | "redirect",
  ): void => {
    const decision = decideAppWindowNavigation({
      kind,
      isMainFrame,
      targetUrl,
      committedUrl: webContents.getURL(),
    });
    if (decision.allow) {
      return;
    }
    event.preventDefault();
    if (decision.openExternally) {
      void shell.openExternal(targetUrl);
    }
  };
  webContents.on("will-frame-navigate", (event) => {
    guard(event, event.url, event.isMainFrame, "navigate");
  });
  webContents.on("will-redirect", (event) => {
    guard(event, event.url, event.isMainFrame, "redirect");
  });
}

function permissionRequestIsAudioOnly(details: {
  mediaTypes?: Array<"video" | "audio">;
}): boolean {
  const types = details.mediaTypes;
  return (
    types !== undefined &&
    types.length > 0 &&
    types.every((type) => type === "audio")
  );
}

// The app window uses the default session. Deny every sensitive web permission by default, and
// allow only the few the app itself needs, and only from an app window's own main frame on a real
// http(s) origin (never a sub-frame such as a sandboxed preview). The embedded browser uses its
// own partitions with their own handlers, so it is unaffected.
function installDefaultSessionPermissionHandlers(): void {
  session.defaultSession.setPermissionRequestHandler(
    (webContents, permission, callback, details) => {
      callback(
        isAllowedAppPermission({
          permission,
          isAppWindowMainFrame:
            applicationWindowWebContentsIds.has(webContents.id) &&
            (details as PermissionRequest).isMainFrame,
          originIsHttp: isHttpOrigin(webContents.mainFrame.origin),
          mediaAudioOnly:
            permission === "media" &&
            permissionRequestIsAudioOnly(
              details as { mediaTypes?: Array<"video" | "audio"> },
            ),
        }),
      );
    },
  );
  session.defaultSession.setPermissionCheckHandler(
    (webContents, permission, requestingOrigin, details) =>
      webContents !== null &&
      isAllowedAppPermission({
        permission,
        isAppWindowMainFrame:
          applicationWindowWebContentsIds.has(webContents.id) &&
          details.isMainFrame,
        originIsHttp: isHttpOrigin(requestingOrigin),
        mediaAudioOnly: permission === "media" && details.mediaType === "audio",
      }),
  );
}

// Privileged IPC must come from an app window's own main frame on a real http(s) origin, never a
// navigated-away page or an embedded (sandboxed) preview sub-frame that shares the webContents id.
function isPrivilegedAppSender(event: IpcMainEvent | IpcMainInvokeEvent): boolean {
  return isSensitiveAppSender({
    isAppWindow: applicationWindowWebContentsIds.has(event.sender.id),
    isMainFrame: event.senderFrame === event.sender.mainFrame,
    senderOrigin: event.senderFrame?.origin ?? null,
  });
}

// The startup loading/error views (a data: URL, opaque origin) legitimately read non-sensitive
// desktop info and answer close-window requests, so these channels require only an app-window
// main frame.
function isAppWindowMainFrameSender(
  event: IpcMainEvent | IpcMainInvokeEvent,
): boolean {
  return isAppWindowMainFrame({
    isAppWindow: applicationWindowWebContentsIds.has(event.sender.id),
    isMainFrame: event.senderFrame === event.sender.mainFrame,
  });
}

let loadingLogoSrc: string | null = null;

function getLoadingLogoSrc(): string {
  loadingLogoSrc ??= `data:image/png;base64,${readFileSync(
    join(app.getAppPath(), "assets", "loading-logo.png"),
  ).toString("base64")}`;
  return loadingLogoSrc;
}

async function loadLoadingView(): Promise<void> {
  bbAppLoaded = false;
  await loadWindowUrl({
    url: createLocalViewUrl({
      viewModel: {
        kind: "loading",
        logoSrc: getLoadingLogoSrc(),
        title: "Opening Cloudroom",
      },
    }),
  });
}

async function loadStartupError(args: LoadStartupErrorArgs): Promise<void> {
  bbAppLoaded = false;
  const url = createLocalViewUrl({
    viewModel: {
      details: `${args.details} Logs are under ${formatLogDirectory()}/.`,
      kind: "error",
      logText: args.logs,
      retryable: args.retryable,
      title: args.title,
    },
  });
  const loading = loadWindowUrl({ url });
  startupRetryUrl = args.retryable ? url : null;
  await loading;
}

async function loadBbApp(serverUrl: string): Promise<void> {
  bbAppLoaded = true;
  await loadWindowUrl({ url: serverUrl });
  if (shouldOpenDevTools()) {
    desktopWindowFactory?.openDevTools();
  }
}

function shouldOpenDevTools(): boolean {
  return process.env.BB_DESKTOP_OPEN_DEVTOOLS === "1";
}

async function createApplicationWindow(
  args: CreateApplicationWindowArgs,
): Promise<DesktopBrowserWindow | null> {
  if (desktopWindowFactory === null) {
    return null;
  }

  const browserWindow = await desktopWindowFactory.createWindow({
    initialUrl: args.initialUrl,
    stateKey: args.stateKey,
  });
  if (bbAppLoaded && shouldOpenDevTools()) {
    browserWindow.webContents.openDevTools({ mode: "detach" });
  }
  return browserWindow;
}

async function stopOwnedRuntime(): Promise<void> {
  const runtime = currentRuntime;
  if (runtime === null || runtime.ownership !== "spawned") {
    setCurrentRuntime(null);
    return;
  }

  setCurrentRuntime(null);
  try {
    await runtime.bbProcess?.stop({
      killSignal: "SIGKILL",
      killTimeoutMs: OWNED_RUNTIME_KILL_TIMEOUT_MS,
      signal: "SIGTERM",
      timeoutMs: OWNED_RUNTIME_STOP_TIMEOUT_MS,
    });
  } finally {
    if (runtime.userDataPath !== null) {
      await clearOwnedRuntimePidFile({ userDataPath: runtime.userDataPath });
    }
  }
}

function handleBeforeQuit(event: Event): void {
  quitting = true;
  if (stoppingForQuit) {
    return;
  }

  event.preventDefault();
  stoppingForQuit = true;
  void finishQuit().finally(() => {
    app.quit();
  });
}

async function finishQuit(): Promise<void> {
  desktopBrowserBrokerClient?.stop();
  desktopBrowserBroker?.dispose();
  stopSystemConfigSync();
  desktopUpdateService?.stop();
  desktopAutoUpdateService?.stop();
  idleInstall?.stop();
  desktopBrowserViewManager?.destroyAll();
  await desktopWindowFactory?.persistOpenWindows();
  await stopOwnedRuntime();
}

// electron-updater's "96.0.0" as Cloudroom's "v96".
function displayVersion(version: string): string {
  return `v${version.replace(/\.0\.0$/u, "")}`;
}

function appUpdateNeedsPassword(): boolean {
  return (
    process.platform === "darwin" &&
    app.isPackaged &&
    installNeedsPassword(process.execPath)
  );
}

async function installDownloadedUpdate(): Promise<void> {
  if (desktopAutoUpdateService === null) {
    return;
  }
  if (!desktopAutoUpdateService.getInfo().updateDownloaded) {
    desktopAutoUpdateService.installUpdate();
    return;
  }
  // Before anything stops: a newer download may have deleted the staged installer.
  if (!desktopAutoUpdateService.installerReady()) {
    return;
  }
  const appImagePath = process.env.APPIMAGE?.trim() ?? "";
  if (
    process.platform === "linux" &&
    (appImagePath.length === 0 || !canReplaceAppImage(appImagePath))
  ) {
    desktopLogger.error(
      `Desktop update install skipped: ${appImagePath || "this build"} cannot be replaced in place. The runtime stays up; download the new AppImage instead.`,
    );
    return;
  }
  if (appUpdateNeedsPassword()) {
    const ownership = await takeAppOwnership(process.execPath);
    desktopLogger.info(`Taking ownership of the Cloudroom app before updating: ${ownership}.`);
    if (ownership === "canceled") {
      throw new Error("The password prompt was canceled, so the update wasn't installed.");
    }
  }
  // A window left frozen while the app quits gets reopened, and macOS then
  // cancels the install ("App Still Running"), so hide it right away.
  if (process.platform === "darwin") {
    for (const window of BrowserWindow.getAllWindows()) window.hide();
  }
  // Windows: no check or download may replace the staged installer while the backend stops.
  if (!desktopAutoUpdateService.beginInstall()) {
    return;
  }
  const reopens =
    process.platform === "darwin" &&
    app.isPackaged &&
    reopenAfterExit(process.execPath, process.pid);
  let handedOff = false;
  const attemptDir = resolveDataDirFromEnv({ env: process.env, homeDir: homedir() });
  try {
    const pendingVersion = desktopAutoUpdateService.getInfo().pendingVersion;
    if (process.platform === "win32" && pendingVersion) {
      await saveWindowsUpdateMarker(
        app.getPath("userData"),
        getDesktopVersion(process.env.BB_DESKTOP_VERSION),
        pendingVersion,
      ).catch((error: unknown) => {
        desktopLogger.error(`Saving the update marker failed: ${String(error)}`);
      });
    }
    if (process.platform === "darwin" && pendingVersion) {
      // Where the app runs and whether this user can replace it are the usual
      // reasons Squirrel.Mac never installs, so the failure report carries them.
      await saveUpdateAttempt(
        attemptDir,
        getDesktopVersion(process.env.BB_DESKTOP_VERSION),
        displayVersion(pendingVersion),
        { location: macAppLocation(process.execPath), needs_password: installNeedsPassword(process.execPath) },
      ).catch((error: unknown) => {
        desktopLogger.error(`Saving the update attempt failed: ${String(error)}`);
      });
      autoUpdater.once("error", (error: Error) => {
        void noteUpdateAttempt(attemptDir, { updater_error: String(error?.message ?? error).slice(0, 300) }).catch(() => {});
      });
    }
    if (currentRuntime?.ownership === "spawned") {
      await stopThreadsForUpdate({
        logger: desktopLogger,
        serverUrl: currentRuntime.serverUrl,
        userDataPath: app.getPath("userData"),
      }).catch((error: unknown) => {
        desktopLogger.error(`Stopping threads for the update failed: ${String(error)}`);
      });
    }
    quitting = true;
    stoppingForQuit = true;
    await finishQuit();
    if (process.platform === "win32") {
      // electron-updater quits as soon as it asks Windows to start the NSIS installer,
      // so a failed start would leave Cloudroom closed (BB #5528). Reopen this version.
      autoUpdater.once("error", (error: Error) => {
        desktopLogger.error(`The update installer didn't start; reopening Cloudroom: ${String(error?.message ?? error)}`);
        autoUpdater.autoInstallOnAppQuit = false;
        app.relaunch();
        app.exit(0);
      });
      session.defaultSession.flushStorageData();
      app.once("before-quit", (event) => event.preventDefault());
      setTimeout(() => app.exit(0), UPDATE_QUIT_TIMEOUT_MS);
    }
    handedOff = desktopAutoUpdateService.installUpdate();
  } finally {
    // Windows: the backend may already be stopped, so an install that didn't hand off reopens this version.
    if (process.platform === "win32" && !handedOff) {
      desktopAutoUpdateService.endInstall();
      if (stoppingForQuit) {
        desktopLogger.error("The update didn't start after Cloudroom stopped; reopening Cloudroom.");
        autoUpdater.autoInstallOnAppQuit = false;
        app.relaunch();
        app.exit(0);
      }
    }
    // The server is already stopped, so never stay hidden if Squirrel.Mac
    // hangs: exit, and reopenAfterExit brings Cloudroom back.
    if (reopens) {
      setTimeout(() => {
        desktopLogger.error("The update didn't quit Cloudroom in time; exiting so it reopens.");
        void noteUpdateAttempt(attemptDir, { quit_timeout: true }).catch(() => {}).finally(() => app.exit(0));
      }, UPDATE_QUIT_TIMEOUT_MS);
    }
  }
  if (process.platform === "win32" && handedOff) await new Promise<never>(() => {});
}

function registerDesktopUpdateIpc(): void {
  ipcMain.handle(BB_DESKTOP_GET_INFO_CHANNEL, (event) => {
    if (!isAppWindowMainFrameSender(event)) return null;
    return getCurrentDesktopInfo();
  });
  ipcMain.handle(BB_DESKTOP_GET_WINDOW_STATE_CHANNEL, (event) => {
    if (!isAppWindowMainFrameSender(event)) return null;
    return getSenderDesktopWindowState(event);
  });
  ipcMain.handle(BB_DESKTOP_OPEN_SERVER_DAEMON_LOGS_CHANNEL, async (event) => {
    if (!isPrivilegedAppSender(event)) return;
    await openServerDaemonLogs();
  });
  ipcMain.handle(BB_DESKTOP_OPEN_COMPUTER_CHANNEL, async (event, handle: unknown) => {
    if (!isPrivilegedAppSender(event)) return;
    await openComputerTarget(typeof handle === "string" ? handle : null);
  });
  ipcMain.handle(BB_DESKTOP_CHECK_FOR_UPDATES_CHANNEL, async (event) => {
    if (!isPrivilegedAppSender(event)) return null;
    await Promise.all([
      desktopUpdateService?.checkForUpdates() ?? Promise.resolve(null),
      desktopAutoUpdateService?.checkForUpdates() ?? Promise.resolve(null),
    ]);
    return getCurrentDesktopInfo();
  });
  ipcMain.handle(BB_DESKTOP_INSTALL_UPDATE_CHANNEL, (event) => {
    if (!isPrivilegedAppSender(event)) return;
    return installDownloadedUpdate();
  });
  ipcMain.on(BB_DESKTOP_SET_THEME_CHANNEL, (event, payload: unknown) => {
    if (!isPrivilegedAppSender(event)) return;
    const parsed = bbDesktopThemeSchema.safeParse(payload);
    if (!parsed.success) {
      return;
    }
    nativeTheme.themeSource = parsed.data;
  });
  ipcMain.on(BB_DESKTOP_SET_BADGE_COUNT_CHANNEL, (event, payload: unknown) => {
    if (!isPrivilegedAppSender(event)) return;
    const parsed = z.number().int().nonnegative().safeParse(payload);
    if (parsed.success) app.setBadgeCount(parsed.data);
  });
  ipcMain.on(BB_DESKTOP_FOCUS_WINDOW_CHANNEL, (event) => {
    if (!isPrivilegedAppSender(event)) return;
    const window = BrowserWindow.fromWebContents(event.sender);
    if (!window) return;
    if (window.isMinimized()) window.restore();
    // Sign-in finishes in the browser, so the app must take focus from it.
    app.focus({ steal: true });
    window.focus();
  });
  ipcMain.on(STARTUP_RETRY_CHANNEL, (event, ...payload: unknown[]) => {
    if (
      payload.length !== 0 ||
      startupRetryUrl === null ||
      !applicationWindowWebContentsIds.has(event.sender.id) ||
      event.senderFrame !== event.sender.mainFrame ||
      event.senderFrame?.url !== startupRetryUrl
    ) {
      return;
    }
    void retryStartup();
  });

  ipcMain.on(BB_DESKTOP_CLOSE_WINDOW_RESPONSE_CHANNEL, (event, payload) => {
    if (!isAppWindowMainFrameSender(event)) return;
    const pending = pendingCloseWindowRequests.get(event.sender.id);
    if (pending !== undefined) {
      clearTimeout(pending);
      pendingCloseWindowRequests.delete(event.sender.id);
    }
    if (payload === false) {
      resolveApplicationWindow(event.sender)?.close();
    }
  });
  ipcMain.on(
    BB_DESKTOP_OPEN_EXTERNAL_URL_CHANNEL,
    (event, payload: unknown) => {
      if (!isPrivilegedAppSender(event)) return;
      if (typeof payload !== "string") {
        return;
      }
      let parsed: URL;
      try {
        parsed = new URL(payload);
      } catch {
        return;
      }
      if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
        return;
      }
      void shell.openExternal(parsed.toString());
    },
  );
}

interface DesktopBrowserWindowLifecycleArgs {
  browserWindow: BrowserWindow;
  manager: DesktopBrowserViewManager;
}

const WINDOW_RESIZE_SETTLE_MS = 200;

function registerDesktopBrowserWindowLifecycle({
  browserWindow,
  manager,
}: DesktopBrowserWindowLifecycleArgs): void {
  const hostWebContentsId = browserWindow.webContents.id;
  let resizeSettleTimer: NodeJS.Timeout | null = null;
  const endWindowResize = () => {
    if (resizeSettleTimer !== null) {
      clearTimeout(resizeSettleTimer);
      resizeSettleTimer = null;
    }
    if (!browserWindow.isDestroyed()) {
      manager.endWindowResize(browserWindow);
    }
  };
  browserWindow.on("resize", () => {
    manager.beginWindowResize(browserWindow);
    if (resizeSettleTimer !== null) {
      clearTimeout(resizeSettleTimer);
    }
    resizeSettleTimer = setTimeout(endWindowResize, WINDOW_RESIZE_SETTLE_MS);
  });
  browserWindow.on("resized", endWindowResize);
  browserWindow.once("closed", () => {
    if (resizeSettleTimer !== null) {
      clearTimeout(resizeSettleTimer);
      resizeSettleTimer = null;
    }
    manager.releaseWindow(hostWebContentsId);
  });
}

async function startOwnedRuntime(
  args: StartOwnedRuntimeArgs,
): Promise<DesktopRuntime | null> {
  if (process.argv.includes("--attach-only")) {
    await loadStartupError({
      details: `Start the shared backend at ${args.serverUrl}, then reopen Cloudroom Dev. No backend was started and no history was changed.`,
      logs: "",
      retryable: false,
      title: "Shared backend unavailable",
    });
    return null;
  }
  const bbProcess = startBbAppProcess({
    bridgePath: args.bridgePath,
    cwd: homedir(),
    env: {
      ...process.env,
      [APP_SURFACE_ENV_NAME]: APP_SURFACE_DESKTOP,
      BB_DESKTOP_VERSION: process.env.BB_DESKTOP_VERSION,
      BB_DESKTOP_UPDATE_NEEDS_PASSWORD: appUpdateNeedsPassword() ? "1" : undefined,
    },
    logLineLimit: PROCESS_LOG_LINE_LIMIT,
    runtime: resolveBbAppProcessRuntime({
      env: process.env,
      isPackaged: app.isPackaged,
      platform: process.platform,
      processExecPath: process.execPath,
    }),
  });
  const runtime: DesktopRuntime = {
    bbProcess,
    ownership: "spawned",
    serverUrl: args.serverUrl,
    userDataPath: args.userDataPath,
  };
  await writeOwnedRuntimePidFile({
    bridgePath: args.bridgePath,
    pid: bbProcess.pid,
    serverUrl: args.serverUrl,
    userDataPath: args.userDataPath,
  });
  setCurrentRuntime(runtime);

  void bbProcess.exit.then((exit) => {
    void clearOwnedRuntimePidFile({ userDataPath: args.userDataPath });
    if (quitting || currentRuntime !== runtime) {
      return;
    }
    setCurrentRuntime(null);
    saveCrash({ what: "backend", reason: formatExitResult(exit), exit_code: exit.code, logs: bbProcess.logs.text().split("\n").slice(-20).join("\n") });
    void loadStartupError({
      details: `The Cloudroom backend stopped with ${formatExitResult(
        exit,
      )}.`,
      logs: bbProcess.logs.text(),
      retryable: false,
      title: "Cloudroom stopped",
    });
  });

  const raceResult = await Promise.race<StartupRaceResult>([
    waitForCompatibleServer({
      intervalMs: STARTUP_POLL_INTERVAL_MS,
      serverUrl: args.serverUrl,
      timeoutMs: STARTUP_TIMEOUT_MS,
    }).then((result) => ({
      kind: "server-probe",
      result,
    })),
    bbProcess.exit.then((exit) => ({
      exit,
      kind: "process-exited",
    })),
  ]);

  if (raceResult.kind === "process-exited") {
    await loadStartupError({
      details: `The Cloudroom backend exited before it was ready with ${formatExitResult(
        raceResult.exit,
      )}.`,
      logs: bbProcess.logs.text(),
      retryable: false,
      title: "Could not start Cloudroom",
    });
    setCurrentRuntime(null);
    return null;
  }

  if (raceResult.result.kind === "compatible") {
    void resumeThreadsAfterUpdate({
      logger: desktopLogger,
      serverUrl: runtime.serverUrl,
      userDataPath: args.userDataPath,
    }).catch((error: unknown) => {
      desktopLogger.error(`Resuming threads after the update failed: ${String(error)}`);
    });
    return runtime;
  }

  await loadStartupError({
    details:
      raceResult.result.kind === "incompatible"
        ? `Port ${args.serverUrl} is responding, but it does not look like Cloudroom: ${raceResult.result.reason}.`
        : `Timed out waiting for Cloudroom at ${args.serverUrl}: ${raceResult.result.reason}.`,
    logs: bbProcess.logs.text(),
    retryable: false,
    title: "Could not start Cloudroom",
  });
  await stopOwnedRuntime();
  return null;
}

interface InitializeRuntimeArgs {
  bridgePath: string;
  serverUrl: string;
  userDataPath: string;
}

function shouldAskBeforeAttaching(): boolean {
  if (
    process.argv.includes("--attach-only") ||
    !app.isPackaged ||
    existingServerDialogPreloadPath === null
  ) {
    return false;
  }
  if (process.env.BB_DESKTOP_ATTACH_WITHOUT_PROMPT === "1") {
    return false;
  }
  return (process.env.BB_DESKTOP_APP_URL ?? "").trim().length === 0;
}

async function waitForServerToStop(serverUrl: string): Promise<boolean> {
  const deadline = Date.now() + FOREIGN_RUNTIME_STOP_TIMEOUT_MS;
  while (Date.now() <= deadline) {
    const probe = await probeBbServer({
      serverUrl,
      timeoutMs: ATTACH_PROBE_TIMEOUT_MS,
    });
    if (probe.kind === "unavailable") {
      return true;
    }
    await new Promise<void>((resolvePromise) => {
      setTimeout(resolvePromise, STARTUP_POLL_INTERVAL_MS);
    });
  }
  return false;
}

type ExistingServerDecision = "attach" | "quit" | "start-fresh";

async function decideOnExistingServer(
  probe: CompatibleServerProbeResult,
): Promise<ExistingServerDecision> {
  if (!shouldAskBeforeAttaching()) {
    return "attach";
  }

  const preloadPath = existingServerDialogPreloadPath;
  if (preloadPath === null) {
    return "attach";
  }

  const details = await readForeignRuntimeDetails({
    dataDir: probe.dataDir,
    serverUrl: probe.serverUrl,
  });
  const choice = await openExistingServerDialog({
    details,
    parentWindow: getFocusedApplicationWindow(),
    preloadPath,
    serverUrl: probe.serverUrl,
  });

  if (choice === "quit") {
    return "quit";
  }
  if (choice === "connect" || details === null) {
    return "attach";
  }

  const stopResult = await stopForeignRuntime({
    details,
    killTimeoutMs: FOREIGN_RUNTIME_KILL_TIMEOUT_MS,
    timeoutMs: FOREIGN_RUNTIME_STOP_TIMEOUT_MS,
  });
  if (stopResult.kind === "unverified") {
    await loadStartupError({
      details:
        `The Cloudroom at ${probe.serverUrl} records process ${String(stopResult.pid)}, but that ` +
        "process no longer matches the record. Cloudroom did not stop it. Stop it yourself, then open Cloudroom again.",
      logs: "",
      retryable: false,
      title: "Could not stop the running Cloudroom",
    });
    return "quit";
  }
  if (stopResult.kind === "still-running") {
    await loadStartupError({
      details: `Cloudroom could not stop process ${String(stopResult.pid)}, even after SIGKILL.`,
      logs: "",
      retryable: false,
      title: "Could not stop the running Cloudroom",
    });
    return "quit";
  }
  if (stopResult.kind === "replaced") {
    await loadStartupError({
      details:
        `Another Cloudroom started at ${probe.serverUrl} while the question was open, so Cloudroom stopped nothing. ` +
        "Open Cloudroom again to see the copy that runs now.",
      logs: "",
      retryable: false,
      title: "Could not stop the running Cloudroom",
    });
    return "quit";
  }
  if (!(await waitForServerToStop(probe.serverUrl))) {
    await loadStartupError({
      details: `The Cloudroom at ${probe.serverUrl} stopped, but the address is still in use.`,
      logs: "",
      retryable: false,
      title: "Could not stop the running Cloudroom",
    });
    return "quit";
  }
  return "start-fresh";
}

async function initializeRuntime(args: InitializeRuntimeArgs): Promise<void> {
  const existingProbe = await probeBbServer({
    serverUrl: args.serverUrl,
    timeoutMs: ATTACH_PROBE_TIMEOUT_MS,
  });

  if (existingProbe.kind === "compatible") {
    const decision = await decideOnExistingServer(existingProbe);
    if (decision === "quit") {
      app.quit();
      return;
    }
    if (decision === "start-fresh") {
      await loadLoadingView();
      const freshRuntime = await startOwnedRuntime({
        bridgePath: args.bridgePath,
        serverUrl: args.serverUrl,
        userDataPath: args.userDataPath,
      });
      if (freshRuntime !== null) {
        await loadBbApp(freshRuntime.serverUrl);
        startSystemConfigSync(freshRuntime.serverUrl);
        refreshApplicationMenu();
      }
      return;
    }

    setCurrentRuntime({
      bbProcess: null,
      ownership: "attached",
      serverUrl: existingProbe.serverUrl,
      userDataPath: null,
    });
    await loadBbApp(
      resolveDesktopWindowUrl({
        env: process.env,
        serverUrl: existingProbe.serverUrl,
      }),
    );
    startSystemConfigSync(existingProbe.serverUrl);
    refreshApplicationMenu();
    return;
  }

  if (existingProbe.kind === "incompatible") {
    await loadStartupError({
      details: `Port ${args.serverUrl} is already in use, but it is not a compatible Cloudroom server: ${existingProbe.reason}.`,
      logs: "",
      retryable: false,
      title: "Port conflict",
    });
    return;
  }

  const runtime = await startOwnedRuntime({
    bridgePath: args.bridgePath,
    serverUrl: args.serverUrl,
    userDataPath: args.userDataPath,
  });
  if (runtime !== null) {
    await loadBbApp(runtime.serverUrl);
    startSystemConfigSync(runtime.serverUrl);
    refreshApplicationMenu();
  }
}

async function runDesktopApp(): Promise<void> {
  if (app.isPackaged) {
    applyPackagedDesktopRuntimeEnv({ env: process.env, homeDir: homedir() });
  }
  ensurePackagedUserShellPath({
    env: process.env,
    isPackaged: app.isPackaged,
    logger: desktopLogger,
    platform: process.platform,
  });

  if (process.platform === "darwin") {
    process.env.CURL_SSL_BACKEND ??= "secure-transport";
  }
  if (app.isPackaged && process.platform === "darwin") {
    process.env.PATH = `${join(process.resourcesPath, "git", "bin")}:${process.env.PATH ?? "/usr/bin:/bin"}`;
  }

  const applicationName = app.isPackaged
    ? DESKTOP_RELEASE_INFO.applicationName
    : "Cloudroom Dev";
  app.setName(applicationName);
  installAboutPanel(applicationName);

  if (!app.requestSingleInstanceLock()) {
    app.quit();
    return;
  }

  app.on("second-instance", (_event, argv) => {
    deliverArgvShareLink(argv);
    if (desktopWindowFactory?.focusFirstWindow() === true) {
      return;
    }
    void createApplicationWindow({
      initialUrl: currentWindowUrl,
      stateKey: null,
    });
  });
  // cloudroom:// links bring the app forward. Share links also go to the app, which copies the shared thread.
  app.on("open-url", (event, url) => {
    event.preventDefault();
    if (url.startsWith("cloudroom://share/")) deliverOpenLink(url);
    desktopWindowFactory?.focusFirstWindow();
  });
  if (
    app.isPackaged &&
    process.platform === "win32" &&
    DESKTOP_RELEASE_INFO.channel === "latest"
  ) {
    app.setAsDefaultProtocolClient("cloudroom");
  }
  deliverArgvShareLink(process.argv);
  app.on("before-quit", handleBeforeQuit);
  app.on("window-all-closed", () => {
    if (process.platform !== "darwin") {
      app.quit();
    }
  });
  app.on("activate", () => {
    if (desktopWindowFactory?.hasOpenWindows() === false) {
      void createApplicationWindow({
        initialUrl: currentWindowUrl,
        stateKey: null,
      });
    }
  });
  app.on("did-become-active", () => {
    void desktopUpdateService?.checkAfterActive();
    void desktopAutoUpdateService?.checkAfterActive();
    refreshRemoteSystemConfig?.();
  });
  app.on("browser-window-created", (_event, browserWindow) => {
    if (desktopBrowserViewManager === null) {
      return;
    }
    registerDesktopBrowserWindowLifecycle({
      browserWindow,
      manager: desktopBrowserViewManager,
    });
  });
  registerDesktopShutdownSignalHandlers({
    exitProcess(code) {
      process.exitCode = code;
    },
    processEvents: process,
    quitApplication() {
      app.quit();
    },
    state: createDesktopShutdownState(),
    async stopOwnedRuntime() {
      quitting = true;
      await stopOwnedRuntime();
    },
  });

  await app.whenReady();
  installDefaultSessionPermissionHandlers();
  if (app.isPackaged) {
    await session.defaultSession.clearCache();
  }

  const paths = createDesktopPathContext();
  const appImagePath = process.env.APPIMAGE?.trim() ?? "";
  if (
    paths.isPackaged &&
    (process.platform === "darwin" || process.platform === "linux")
  ) {
    void ensureRoomCliShim({
      appImagePath: process.platform === "linux" ? appImagePath : undefined,
      cliPath: resolveBundledRoomCliPath(paths.appPath),
      homeDir: homedir(),
    })
      .then((result) => {
        if (result.kind !== "unchanged") {
          desktopLogger.info(
            `[desktop] ${result.shimPath}: ${result.kind === "skipped" ? `left alone (${result.reason})` : result.kind}`,
          );
        }
      })
      .catch((error: unknown) => {
        desktopLogger.warn(
          `[desktop] Could not update the room-cli shim: ${error instanceof Error ? error.message : String(error)}`,
        );
      });
  }
  const iconPath = resolveDesktopIconPath({
    packagedIconFileName: DESKTOP_RELEASE_INFO.iconFileName,
    paths,
  });
  const bridgePath = resolveDesktopBridgePath({ paths });
  const resolvedLogViewerPreloadPath = join(
    paths.appPath,
    "dist",
    "log-viewer-preload.cjs",
  );
  const preloadPath = join(paths.appPath, "dist", "preload.cjs");
  const resolvedExistingServerDialogPreloadPath = join(
    paths.appPath,
    "dist",
    "existing-server-dialog-preload.cjs",
  );
  const resolvedServerUrlDialogPreloadPath = join(
    paths.appPath,
    "dist",
    "server-url-dialog-preload.cjs",
  );
  const serverUrl = resolveDesktopServerUrl({ env: process.env });
  builtinServerUrl = serverUrl;
  desktopBridgePath = bridgePath;
  const desktopVersion = getDesktopVersion(process.env.BB_DESKTOP_VERSION);
  const desktopPlatform = resolveBbDesktopPlatform(process.platform);
  const desktopUpdateFeedUrl = resolveDesktopUpdateFeedUrl({
    env: process.env,
    platform: desktopPlatform,
  });
  const userDataPath = app.getPath("userData");
  desktopUserDataPath = userDataPath;

  assertPathExists({ label: "bb-app bridge", path: bridgePath });
  assertPathExists({
    label: "existing server dialog preload script",
    path: resolvedExistingServerDialogPreloadPath,
  });
  assertPathExists({
    label: "log viewer preload script",
    path: resolvedLogViewerPreloadPath,
  });
  assertPathExists({ label: "preload script", path: preloadPath });
  assertPathExists({
    label: "server URL dialog preload script",
    path: resolvedServerUrlDialogPreloadPath,
  });
  assertPathExists({ label: "app icon", path: iconPath });
  if (paths.isPackaged) {
    const cacheRoot =
      process.platform === "darwin"
        ? join(homedir(), "Library", "Caches")
        : process.env.XDG_CACHE_HOME?.trim() || join(homedir(), ".cache");
    void rm(join(cacheRoot, "@bbdesktop-updater"), { force: true, recursive: true }).catch(
      () => undefined,
    );
  }
  if (paths.isPackaged && process.platform === "linux" && appImagePath.length > 0) {
    void ensureLinuxDesktopEntry({
      appImagePath,
      applicationName: DESKTOP_RELEASE_INFO.applicationName,
      dataHome: process.env.XDG_DATA_HOME?.trim() || join(homedir(), ".local", "share"),
      desktopName: process.env.CHROME_DESKTOP ?? "",
      iconPath,
    })
      .then((result) => {
        if (result.kind !== "unchanged") {
          desktopLogger.info(`[desktop] Linux launcher entry: ${JSON.stringify(result)}`);
        }
      })
      .catch((error: unknown) => {
        desktopLogger.warn(
          `[desktop] Could not install the Linux launcher entry: ${error instanceof Error ? error.message : String(error)}`,
        );
      });
  }

  if (hideWindowsForTests) {
    app.dock?.hide();
  } else if (
    process.platform === "darwin" &&
    app.dock !== undefined &&
    !paths.isPackaged
  ) {
    app.dock.setIcon(iconPath);
  }
  await reapStaleOwnedRuntime({
    signal: "SIGTERM",
    timeoutMs: 5_000,
    userDataPath,
  });

  serverTargetStore = createServerTargetStore({
    storagePath: join(userDataPath, SERVER_TARGET_FILE_NAME),
  });
  await serverTargetStore.load();
  await createConnectCredentialCache({
    encryption: safeStorage,
    fileName: "connect-credential.bin",
    userDataPath,
  }).clear();
  relayCredentialCache = createConnectCredentialCache({
    encryption: safeStorage,
    fileName: RELAY_CREDENTIAL_FILE_NAME,
    userDataPath,
  });
  relayCredential = await relayCredentialCache.read();
  thisComputerName = await computerName();
  relaySessionKeeper = createRelaySessionKeeper({
    async renew(handle) {
      const credential = await getRelayCredential(false);
      if (credential === null) return { ok: false, reason: "no-credential" };
      return openComputer(credential, handle, session.defaultSession.cookies);
    },
    onRecovered() {
      desktopLogger.info("[desktop] signed in to the other Mac again — reloading");
      reloadApplicationWindows();
    },
    onLost() {
      desktopLogger.info("[desktop] could not sign in to the other Mac again — reopening it");
      void applyServerTarget();
    },
  });
  // "Sign in required" from the Mac on screen: its sign-in expired or "Sign out all phones" ended it.
  session.defaultSession.webRequest.onCompleted({ urls: [RELAY_URL_PATTERN] }, (details) => {
    if (details.statusCode === 401) {
      void relaySessionKeeper?.onSignInRequired(details.url, details.resourceType === "mainFrame");
    }
  });
  computersSync = createComputersSync({
    async fetchList() {
      const credential = await getRelayCredential(false);
      if (credential === null) return { ok: false, reason: "no-credential" };
      const result = await listComputers(credential, thisComputerName);
      if (!result.ok && result.reason === "unauthorized") await clearRelayCredential();
      return result;
    },
    onResult(result) {
      computersSkipReason = result.ok ? null : result.reason;
      if (result.ok) {
        computerList = result.value;
        const selected = serverTargetStore?.getConnectServer() ?? null;
        const synced = result.value.computers.find(
          (computer) => computer.handle === selected?.handle,
        );
        if (synced !== undefined) {
          void serverTargetStore?.refreshConnectServer({
            handle: synced.handle,
            name: synced.name,
            url: synced.url,
          });
        }
        const fallback = computerFallback;
        if (fallback !== null && !fallback.back) {
          const back = result.value.computers.some(
            (computer) => computer.handle === fallback.handle && computer.live,
          );
          if (back) computerFallback = { ...fallback, back };
        }
      }
      refreshApplicationMenu();
      sendDesktopInfoChanged();
    },
  });
  const desktopUpdateSupport = resolveDesktopUpdateSupport({
    canReplaceAppImage,
    env: process.env,
    platform: desktopPlatform,
  });
  desktopUpdateService = createDesktopUpdateService({
    channel: DESKTOP_RELEASE_CHANNEL,
    currentVersion: desktopVersion,
    enabled: false,
    feedUrl: desktopUpdateFeedUrl,
    logger: desktopLogger,
    platform: desktopPlatform,
  });
  const updateNeedsPassword = appUpdateNeedsPassword();
  if (updateNeedsPassword) {
    desktopLogger.warn(
      "This user can't write the Cloudroom app, so the next Restart to update asks for a password once.",
    );
  }
  desktopAutoUpdateService = createDesktopAutoUpdateService({
    currentVersion: desktopVersion,
    enabled:
      desktopUpdateSupport.autoUpdate &&
      shouldEnableDesktopAutoUpdate({
        env: process.env,
        isPackaged: app.isPackaged,
      }),
    forceDevUpdateConfig:
      !app.isPackaged && process.env.BB_DESKTOP_AUTO_UPDATE === "1",
    installNeedsPassword: updateNeedsPassword,
    logger: desktopLogger,
    platform: desktopPlatform,
    updater: createElectronAutoUpdaterAdapter(autoUpdater, squirrelUpdater),
  });
  desktopUpdateService.subscribe(() => {
    sendDesktopInfoChanged();
  });
  if (process.platform === "win32") {
    void takeFailedWindowsUpdate(userDataPath, desktopVersion)
      .then((version) => {
        if (version === null) return;
        desktopLogger.error(`Restart to update didn't install ${version}; offering the download again.`);
        desktopAutoUpdateService?.markInstallFailed(version);
      })
      .catch(() => undefined);
  }
  desktopAutoUpdateService.subscribe(() => {
    sendDesktopInfoChanged();
  });
  // A password prompt must never pop up unattended, so skip idle and remote-window installs.
  if (process.platform === "darwin" && !updateNeedsPassword) {
    idleInstall = startIdleInstall({
      isUpdateDownloaded: () =>
        desktopAutoUpdateService?.getInfo().updateDownloaded === true,
      systemIdleSeconds: () => powerMonitor.getSystemIdleTime(),
      hasRunningThreads: async () =>
        currentRuntime?.ownership === "spawned" &&
        (await runningLocalThreadIds(currentRuntime.serverUrl)).length > 0,
      report: async (installAt) => {
        const version = desktopAutoUpdateService?.getInfo().pendingVersion;
        if (currentRuntime?.ownership !== "spawned" || !version) return false;
        return reportDesktopUpdate(currentRuntime.serverUrl, displayVersion(version), installAt);
      },
      install: async () => {
        desktopLogger.info("Installing the downloaded update: this Mac was idle, or a window asked to restart.");
        await installDownloadedUpdate();
      },
    });
  }
  registerDesktopUpdateIpc();
  desktopBrowserViewManager = createDesktopBrowserViewManager({
    dispatchAppCommand({ command, hostWebContentsId }) {
      const browserWindow = BrowserWindow.getAllWindows().find(
        (candidate) => candidate.webContents.id === hostWebContentsId,
      );
      if (browserWindow === undefined) {
        return;
      }
      sendToApplicationRenderer(
        browserWindow,
        BB_DESKTOP_APP_COMMAND_CHANNEL,
        command,
      );
    },
    focusHostWebContents(hostWebContentsId) {
      const browserWindow = BrowserWindow.getAllWindows().find(
        (candidate) => candidate.webContents.id === hostWebContentsId,
      );
      if (browserWindow !== undefined) {
        browserWindow.webContents.focus();
      }
    },
    resolveAppCommand(input) {
      return resolveDesktopBrowserAppCommand({
        input,
        isMac: process.platform === "darwin",
        keybindings: currentAppKeybindings,
      });
    },
  });
  registerDesktopBrowserIpc(desktopBrowserViewManager, isPrivilegedAppSender);
  const browserImportService =
    process.platform === "win32"
      ? undefined
      : createBrowserImportService({
          context: { platform: process.platform, home: homedir() },
          resolveIcon: (appPath) => readMacAppIcon(appPath),
          log(message, details) {
            desktopLogger.info(
              `[desktop] ${message}${details ? ` ${JSON.stringify(details)}` : ""}`,
            );
          },
        });
  desktopBrowserBroker = createDesktopBrowserBroker({
    manager: desktopBrowserViewManager,
    product: `Chrome/${process.versions.chrome}`,
    browserImport: browserImportService,
  });
  ipcMain.handle(
    BB_DESKTOP_BROWSER_LIST_IMPORT_SOURCES_CHANNEL,
    async (event) => {
      if (!browserImportService || !isPrivilegedAppSender(event)) return null;
      return { sources: await browserImportService.listSources() };
    },
  );
  ipcMain.handle(
    BB_DESKTOP_BROWSER_IMPORT_COOKIES_CHANNEL,
    async (event, payload: unknown) => {
      const parsed =
        bbDesktopBrowserImportCookiesRequestSchema.safeParse(payload);
      if (
        !browserImportService ||
        !parsed.success ||
        !isPrivilegedAppSender(event)
      )
        return null;
      const manager = desktopBrowserViewManager;
      if (!manager) return null;
      return browserImportService.importCookies(
        {
          sourceId: parsed.data.sourceId,
          sourceProfileDirectory: parsed.data.sourceProfileDirectory,
        },
        manager.profileSession(parsed.data.profile),
      );
    },
  );
  ipcMain.on(
    BB_DESKTOP_BROWSER_OPEN_FULL_DISK_ACCESS_SETTINGS_CHANNEL,
    (event) => {
      if (!isPrivilegedAppSender(event) || process.platform !== "darwin")
        return;
      void shell.openExternal(
        "x-apple.systempreferences:com.apple.preference.security?Privacy_AllFiles",
      );
    },
  );
  ipcMain.handle(BB_DESKTOP_BROWSER_TARGET_CHANNEL, (event) => {
    return isPrivilegedAppSender(event)
      ? (desktopBrowserBroker?.getTarget(event.sender.id) ?? null)
      : null;
  });
  ipcMain.handle(
    BB_DESKTOP_BROWSER_GET_CONTROL_CHANNEL,
    (event, payload: unknown) => {
      const parsed = bbDesktopBrowserTabRefSchema.safeParse(payload);
      return parsed.success && isPrivilegedAppSender(event)
        ? (desktopBrowserBroker?.getControl(
            event.sender.id,
            parsed.data.tabId,
          ) ?? null)
        : null;
    },
  );
  ipcMain.on(
    BB_DESKTOP_BROWSER_RELEASE_CONTROL_CHANNEL,
    (event, payload: unknown) => {
      const parsed = bbDesktopBrowserTabRefSchema.safeParse(payload);
      if (parsed.success && isPrivilegedAppSender(event))
        desktopBrowserBroker?.takeOver(event.sender.id, parsed.data.tabId);
    },
  );
  desktopBrowserBrokerClient = createDesktopBrowserBrokerClient({
    broker: desktopBrowserBroker,
    dataDir: resolveDataDirFromEnv({ env: process.env, homeDir: homedir() }),
    homeDir: homedir(),
    getServerUrl() {
      const target = serverTargetStore?.getTarget();
      if (target?.kind === "connect" && computerFallback === null) return target.server.url;
      if (target?.kind === "custom") return target.url;
      return currentRuntime?.serverUrl ?? builtinServerUrl;
    },
  });
  if (desktopUpdateSupport.versionCheck) {
    desktopUpdateService.start();
  }
  if (desktopUpdateSupport.autoUpdate) {
    desktopAutoUpdateService.start();
  } else {
    desktopLogger.info(
      "Desktop auto-install is disabled: only the Linux AppImage build can replace itself. Version checks still report new releases.",
    );
  }

  startCrashReports(
    resolveDataDirFromEnv({ env: process.env, homeDir: homedir() }),
    getDesktopVersion(process.env.BB_DESKTOP_VERSION),
    () => quitting,
  );
  const browserWindowCreator: DesktopBrowserWindowCreator = {
    create(options) {
      const window = new BrowserWindow(options);
      // Install before the factory loads the first URL, so no window is ever unguarded.
      installAppWindowNavigationGuard(window.webContents);
      watchWindowCrashes(window.webContents);
      return window;
    },
  };
  logViewerPreloadPath = resolvedLogViewerPreloadPath;
  serverUrlDialogPreloadPath = resolvedServerUrlDialogPreloadPath;
  existingServerDialogPreloadPath = resolvedExistingServerDialogPreloadPath;
  desktopWindowFactory = createDesktopWindowFactory({
    browserWindowCreator,
    createWindowStateKey() {
      return `window-${randomUUID()}`;
    },
    displayWorkAreas: null,
    hideWindows: hideWindowsForTests,
    icon: nativeImage.createFromPath(iconPath),
    isLinuxTransparent: hasLinuxWindowArgument({
      argument: LINUX_TRANSPARENT_WINDOW_ARGUMENT,
      argv: process.argv,
      platform: process.platform,
    }),
    isMac: process.platform === "darwin",
    isWindows: process.platform === "win32",
    isLinuxFrameless: hasLinuxWindowArgument({
      argument: LINUX_FRAMELESS_WINDOW_ARGUMENT,
      argv: process.argv,
      platform: process.platform,
    }),
    isQuitting() {
      return quitting;
    },
    // Only web and mail links. A cloudroom:// link clicked in the app would come straight back to it.
    openExternalUrl(openArgs) {
      if (/^(https?|mailto):/i.test(openArgs.url)) void shell.openExternal(openArgs.url);
    },
    registerWindow: registerApplicationWindow,
    preloadPath,
    userDataPath,
  });
  installLogViewerIpcHandlers();

  refreshApplicationMenu();
  await loadLoadingView();
  await desktopWindowFactory.restoreSavedWindows({
    initialUrl: currentWindowUrl,
  });
  if (serverTargetStore.getTarget().kind === "builtin") {
    await initializeRuntime({ bridgePath, serverUrl, userDataPath });
  } else {
    await applyServerTarget();
    computersSync.syncNow().catch(() => {});
  }
}

void runDesktopApp().catch((error) => {
  const message =
    error instanceof Error ? (error.stack ?? error.message) : String(error);
  process.stderr.write(`${message}\n`);
  void loadStartupError({
    details: message,
    logs: "",
    retryable: false,
    title: "Could not open Cloudroom",
  });
});
