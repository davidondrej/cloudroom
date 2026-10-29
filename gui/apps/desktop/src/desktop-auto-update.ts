import type {
  AppUpdater,
  UpdateCheckResult,
  UpdateDownloadedEvent,
  UpdateInfo,
} from "electron-updater";
import { existsSync } from "node:fs";
import type { BbDesktopInfo } from "@cloudroom/desktop-contract";
import {
  DESKTOP_AUTO_UPDATE_FEED_CONFIG,
  type DesktopAutoUpdateFeedConfig,
} from "./desktop-update-provider.js";
import {
  createDesktopUpdateScheduler,
  type DesktopUpdateService,
} from "./desktop-update-scheduler.js";

export interface DesktopAutoUpdateLogger {
  error(message: string): void;
  info(message: string): void;
  warn(message: string): void;
}

export type DesktopAutoUpdateAvailableHandler = (info: UpdateInfo) => void;
export type DesktopAutoUpdateDownloadedHandler = (
  event: UpdateDownloadedEvent,
) => void;
export type DesktopAutoUpdateNotAvailableHandler = (info: UpdateInfo) => void;

export interface DesktopAutoUpdateErrorArgs {
  error: Error;
  message: string | null;
}

export type DesktopAutoUpdateErrorHandler = (
  args: DesktopAutoUpdateErrorArgs,
) => void;

export interface DesktopAutoUpdaterAdapter {
  checkForUpdates(): Promise<UpdateCheckResult | null>;
  downloadUpdate(): Promise<Array<string>>;
  onError(handler: DesktopAutoUpdateErrorHandler): void;
  onUpdateAvailable(handler: DesktopAutoUpdateAvailableHandler): void;
  onUpdateDownloaded(handler: DesktopAutoUpdateDownloadedHandler): void;
  onUpdateNotAvailable(handler: DesktopAutoUpdateNotAvailableHandler): void;
  // Squirrel.Mac finished unpacking and verifying the zip, so quitAndInstall quits at once.
  onSquirrelReady(handler: () => void): void;
  quitAndInstall(): void;
  setAutoDownload(enabled: boolean): void;
  setAutoInstallOnAppQuit(enabled: boolean): void;
  setFeedURL(config: DesktopAutoUpdateFeedConfig): void;
  setForceDevUpdateConfig(enabled: boolean): void;
  setLogger(logger: DesktopAutoUpdateLogger): void;
  // The downloaded installer electron-updater would run, or null when none is staged.
  stagedInstallerPath(): string | null;
}

interface CreateDesktopAutoUpdateServiceArgs {
  currentVersion: string;
  enabled: boolean;
  fileExists?: (path: string) => boolean;
  forceDevUpdateConfig: boolean;
  installNeedsPassword?: boolean;
  logger: DesktopAutoUpdateLogger;
  now?: () => number;
  platform: BbDesktopInfo["platform"];
  updater: DesktopAutoUpdaterAdapter;
}

interface ShouldEnableDesktopAutoUpdateArgs {
  env: NodeJS.ProcessEnv;
  isPackaged: boolean;
}

interface ApplyUpdateAvailableArgs {
  checkedAt: string;
  version: string;
}

interface ApplyUpdateDownloadedArgs {
  checkedAt: string;
  version: string;
}

interface ApplyUpdateNotAvailableArgs {
  checkedAt: string;
  version: string;
}

export interface DesktopAutoUpdateService extends DesktopUpdateService {
  /**
   * Windows: holds off new checks and downloads until the install hands off or
   * ends, since a new download deletes the staged installer. False while a
   * download is running. Always true elsewhere.
   */
  beginInstall(): boolean;
  /** Windows: lets checks and downloads run again after an install that didn't hand off. */
  endInstall(): void;
  /** False when the install is declined (nothing downloaded). */
  installUpdate(): boolean;
  /** Windows: whether the downloaded installer is still on disk. If not, offers the download again. */
  installerReady(): boolean;
  /** The last Restart to update didn't change the version: offer the download again. */
  markInstallFailed(version: string): void;
}

function createBaseInfo(
  currentVersion: string,
  platform: BbDesktopInfo["platform"],
  autoUpdateEnabled: boolean,
  installNeedsPassword: boolean,
): BbDesktopInfo {
  return {
    autoUpdateEnabled,
    downloadState: "idle",
    ...(installNeedsPassword ? { installNeedsPassword: true } : {}),
    lastCheckedAt: null,
    latestVersion: null,
    pendingVersion: null,
    platform,
    updateAvailable: false,
    updateDownloaded: false,
    version: currentVersion,
  };
}

function formatErrorMessage(error: unknown): string {
  return error instanceof Error
    ? (error.stack ?? error.message)
    : String(error);
}

function formatCheckedAt(now: () => number): string {
  return new Date(now()).toISOString();
}

export function shouldEnableDesktopAutoUpdate(
  args: ShouldEnableDesktopAutoUpdateArgs,
): boolean {
  return args.isPackaged || args.env.BB_DESKTOP_AUTO_UPDATE === "1";
}

interface SquirrelUpdater {
  on(event: "update-downloaded", listener: () => void): unknown;
}

export function createElectronAutoUpdaterAdapter(
  updater: AppUpdater,
  squirrel: SquirrelUpdater,
): DesktopAutoUpdaterAdapter {
  return {
    checkForUpdates() {
      return updater.checkForUpdates();
    },
    downloadUpdate() {
      return updater.downloadUpdate();
    },
    onError(handler) {
      updater.on("error", (error, message) => {
        handler({ error, message: message ?? null });
      });
    },
    onUpdateAvailable(handler) {
      updater.on("update-available", handler);
    },
    onUpdateDownloaded(handler) {
      updater.on("update-downloaded", handler);
    },
    onUpdateNotAvailable(handler) {
      updater.on("update-not-available", handler);
    },
    onSquirrelReady(handler) {
      squirrel.on("update-downloaded", () => handler());
    },
    quitAndInstall() {
      // Windows: show only the installer's progress window, then reopen Cloudroom.
      if (process.platform === "win32") updater.quitAndInstall(false, true);
      else updater.quitAndInstall();
    },
    setAutoDownload(enabled) {
      updater.autoDownload = enabled;
    },
    setAutoInstallOnAppQuit(enabled) {
      updater.autoInstallOnAppQuit = enabled;
    },
    setFeedURL(config) {
      updater.setFeedURL(config);
    },
    setForceDevUpdateConfig(enabled) {
      updater.forceDevUpdateConfig = enabled;
    },
    setLogger(logger) {
      updater.logger = logger;
    },
    stagedInstallerPath() {
      return (updater as unknown as { installerPath?: string | null }).installerPath ?? null;
    },
  };
}

export function createDesktopAutoUpdateService(
  args: CreateDesktopAutoUpdateServiceArgs,
): DesktopAutoUpdateService {
  const now = args.now ?? (() => Date.now());
  let downloadInFlight: Promise<Array<string>> | null = null;
  let installing = false;
  const scheduler = createDesktopUpdateScheduler({
    enabled: args.enabled,
    initialInfo: createBaseInfo(
      args.currentVersion,
      args.platform,
      args.enabled,
      args.installNeedsPassword === true,
    ),
    now,
    runCheck,
  });

  function applyUpdateAvailable(applyArgs: ApplyUpdateAvailableArgs): void {
    scheduler.updateInfo({
      ...scheduler.getInfo(),
      lastCheckedAt: applyArgs.checkedAt,
      latestVersion: applyArgs.version,
      updateAvailable: true,
    });
  }

  function applyUpdateDownloaded(applyArgs: ApplyUpdateDownloadedArgs): void {
    scheduler.updateInfo({
      ...scheduler.getInfo(),
      downloadState: "downloaded",
      lastCheckedAt: applyArgs.checkedAt,
      latestVersion: applyArgs.version,
      pendingVersion: applyArgs.version,
      updateAvailable: true,
      updateDownloaded: true,
    });
  }

  function applyUpdateNotAvailable(
    applyArgs: ApplyUpdateNotAvailableArgs,
  ): void {
    scheduler.updateInfo({
      ...scheduler.getInfo(),
      downloadState: "idle",
      lastCheckedAt: applyArgs.checkedAt,
      latestVersion: applyArgs.version,
      pendingVersion: null,
      updateAvailable: false,
      updateDownloaded: false,
    });
  }

  // Nothing is staged yet, so clear pendingVersion and let Retry download it again.
  function markDownloadFailed(): void {
    const info = scheduler.getInfo();
    scheduler.updateInfo({
      ...info,
      downloadState: "failed",
      ...(info.updateDownloaded ? {} : { pendingVersion: null }),
    });
  }

  function startDownload(): void {
    if (downloadInFlight !== null || installing) {
      return;
    }
    // NSIS keeps one installer: a new download deletes the staged one, so it's no longer ready.
    scheduler.updateInfo({
      ...scheduler.getInfo(),
      downloadState: "downloading",
      ...(args.platform === "windows" ? { pendingVersion: null, updateDownloaded: false } : {}),
    });
    try {
      downloadInFlight = args.updater.downloadUpdate();
    } catch (error: unknown) {
      markDownloadFailed();
      args.logger.error(
        `Desktop auto-update download failed; preserving current update state: ${formatErrorMessage(
          error,
        )}`,
      );
      return;
    }
    void downloadInFlight
      .catch((error: unknown) => {
        markDownloadFailed();
        args.logger.error(
          `Desktop auto-update download failed; preserving current update state: ${formatErrorMessage(
            error,
          )}`,
        );
      })
      .finally(() => {
        downloadInFlight = null;
      });
  }

  async function runCheck(checkedAt: string): Promise<void> {
    if (installing) {
      return;
    }
    let result: UpdateCheckResult | null;
    try {
      result = await args.updater.checkForUpdates();
    } catch (error: unknown) {
      args.logger.error(
        `Desktop auto-update check failed; update installation remains disabled until a later check succeeds: ${formatErrorMessage(
          error,
        )}`,
      );
      scheduler.updateInfo({
        ...scheduler.getInfo(),
        lastCheckedAt: checkedAt,
      });
      return;
    }

    if (result === null) {
      return;
    }
    if (result.isUpdateAvailable) {
      applyUpdateAvailable({
        checkedAt,
        version: result.updateInfo.version,
      });
      return;
    }
    applyUpdateNotAvailable({
      checkedAt,
      version: result.updateInfo.version,
    });
  }

  if (args.enabled) {
    args.updater.setLogger(args.logger);
    args.updater.setFeedURL(DESKTOP_AUTO_UPDATE_FEED_CONFIG);
    args.updater.setAutoDownload(false);
    // Squirrel.Mac asks for a password as soon as it stages an update it can't
    // write, so stage only after the user clicks Restart to update.
    args.updater.setAutoInstallOnAppQuit(args.installNeedsPassword !== true);
    args.updater.setForceDevUpdateConfig(args.forceDevUpdateConfig);
    args.updater.onUpdateAvailable((info) => {
      applyUpdateAvailable({
        checkedAt: formatCheckedAt(now),
        version: info.version,
      });
      // Re-downloading the staged version makes Squirrel.Mac replace its
      // finished staging with a partial one, so Relaunch installs nothing.
      // Only a newer release may replace the staged update.
      if (info.version === scheduler.getInfo().pendingVersion) {
        return;
      }
      args.logger.info(
        `Desktop auto-update available: ${info.version}; downloading in background.`,
      );
      startDownload();
    });
    // On Mac, Squirrel.Mac still has to unpack and verify the zip after this.
    // A Restart before that leaves the app frozen until it finishes, so users
    // reopen it and macOS cancels the install. Show Restart only once it's ready.
    const waitForSquirrel =
      args.platform === "macos" && args.installNeedsPassword !== true;
    let stagingVersion: string | null = null;
    args.updater.onUpdateDownloaded((event) => {
      if (waitForSquirrel) {
        stagingVersion = event.version;
        args.logger.info(
          `Desktop auto-update downloaded: ${event.version}; waiting for Squirrel.Mac to stage it.`,
        );
        scheduler.updateInfo({
          ...scheduler.getInfo(),
          downloadState: "downloading",
          lastCheckedAt: formatCheckedAt(now),
          latestVersion: event.version,
          pendingVersion: event.version,
          updateAvailable: true,
          updateDownloaded: false,
        });
        return;
      }
      args.logger.info(
        `Desktop auto-update downloaded: ${event.version}; it will install on restart or quit.`,
      );
      applyUpdateDownloaded({
        checkedAt: formatCheckedAt(now),
        version: event.version,
      });
    });
    if (waitForSquirrel) {
      args.updater.onSquirrelReady(() => {
        const version = stagingVersion;
        if (version === null) {
          return;
        }
        args.logger.info(
          `Desktop auto-update staged: ${version}; it will install on restart or quit.`,
        );
        applyUpdateDownloaded({ checkedAt: formatCheckedAt(now), version });
      });
    }
    args.updater.onUpdateNotAvailable((info) => {
      args.logger.info(`Desktop auto-update not available: ${info.version}.`);
      applyUpdateNotAvailable({
        checkedAt: formatCheckedAt(now),
        version: info.version,
      });
    });
    args.updater.onError((errorArgs) => {
      const suffix = errorArgs.message === null ? "" : ` ${errorArgs.message}`;
      args.logger.error(
        `Desktop auto-update error; preserving current update state.${suffix} ${formatErrorMessage(
          errorArgs.error,
        )}`,
      );
      if (scheduler.getInfo().downloadState === "downloading") {
        markDownloadFailed();
      }
    });
  }

  return {
    ...scheduler,
    beginInstall(): boolean {
      if (args.platform !== "windows") {
        return true;
      }
      if (installing) {
        return false;
      }
      if (downloadInFlight !== null) {
        args.logger.warn("Desktop auto-update install requested while a download is replacing the installer; ignoring.");
        return false;
      }
      installing = true;
      return true;
    },
    endInstall(): void {
      installing = false;
    },
    installerReady(): boolean {
      if (args.platform !== "windows" || !scheduler.getInfo().updateDownloaded) {
        return true;
      }
      const installer = args.updater.stagedInstallerPath();
      if (installer !== null && (args.fileExists ?? existsSync)(installer)) {
        return true;
      }
      args.logger.error(`Desktop auto-update installer is missing (${installer ?? "none staged"}); offering the download again.`);
      scheduler.updateInfo({ ...scheduler.getInfo(), downloadState: "failed", pendingVersion: null, updateDownloaded: false });
      return false;
    },
    markInstallFailed(version: string): void {
      scheduler.updateInfo({
        ...scheduler.getInfo(),
        downloadState: "failed",
        latestVersion: version,
        pendingVersion: null,
        updateAvailable: true,
        updateDownloaded: false,
      });
    },
    installUpdate(): boolean {
      if (!scheduler.getInfo().updateDownloaded) {
        args.logger.warn(
          "Desktop auto-update install requested before an update was downloaded; ignoring.",
        );
        return false;
      }
      args.updater.quitAndInstall();
      return true;
    },
  };
}
