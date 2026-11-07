import { z } from "zod";
import type { BbDesktopBrowserApi } from "./browser.js";
import { bbDesktopVersionFeedPlatformSchema } from "./version-feed.js";
import type { AppCommandId, AppShortcutInput } from "@cloudroom/domain";

const isoUtcDateTimeSchema = z.iso.datetime();

const bbDesktopDownloadStateSchema = z.enum([
  "idle",
  "downloading",
  "downloaded",
  "failed",
]);

// Your Macs on the same Cloudroom account, and which one this window shows.
const bbDesktopComputersSchema = z.object({
  list: z.array(
    z.object({
      handle: z.string(),
      name: z.string(),
      online: z.boolean(),
      self: z.boolean(),
    }),
  ),
  /** The Mac on screen, or null for this Mac. */
  viewing: z.string().nullable(),
  /** Set while this Mac stands in for the chosen Mac, which was offline. */
  fallback: z
    .object({
      handle: z.string(),
      name: z.string(),
      back: z.boolean(),
      /** Set while the app keeps trying that Mac and shows the reconnect dialog: when it gives up (ms since epoch). */
      retryUntil: z.number().nullable().optional(),
    })
    .nullable(),
});

export const bbDesktopVitalsSchema = z.object({
  battery: z.number().nullable(),
  cpuBusySince: z.number().nullable(),
  memoryRedSince: z.number().nullable(),
  hotSince: z.number().nullable(),
  diskFreeGb: z.number().nullable(),
});
export type BbDesktopVitals = z.infer<typeof bbDesktopVitalsSchema>;

export const bbDesktopInfoSchema = z.object({
  autoUpdateEnabled: z.boolean().optional(),
  computers: bbDesktopComputersSchema.optional(),
  downloadState: bbDesktopDownloadStateSchema.optional(),
  /** The last Restart to update left this version installed. */
  installFailed: z.boolean().optional(),
  /** Mac: opened from the disk image or Downloads, so it can't update itself until it's moved to Applications. */
  installNeedsMove: z.boolean().optional(),
  installNeedsPassword: z.boolean().optional(),
  lastCheckedAt: isoUtcDateTimeSchema.nullable(),
  latestVersion: z.string().min(1).nullable(),
  pendingVersion: z.string().min(1).nullable(),
  platform: bbDesktopVersionFeedPlatformSchema,
  serverDaemonLogsAvailable: z.boolean().optional(),
  updateAvailable: z.boolean(),
  updateDownloaded: z.boolean(),
  version: z.string().min(1),
  vitals: bbDesktopVitalsSchema.optional(),
});
export type BbDesktopInfo = z.infer<typeof bbDesktopInfoSchema>;

export const bbDesktopWindowStateSchema = z
  .object({
    isFullScreen: z.boolean(),
    isFocused: z.boolean().optional(),
  })
  .strict();
export type BbDesktopWindowState = z.infer<typeof bbDesktopWindowStateSchema>;

export const bbDesktopThemeSchema = z.enum(["system", "light", "dark"]);
export type BbDesktopTheme = z.infer<typeof bbDesktopThemeSchema>;

export type BbDesktopInfoChangeHandler = (info: BbDesktopInfo) => void;
export type BbDesktopInfoUnsubscribe = () => void;
export type BbDesktopWindowStateChangeHandler = (
  state: BbDesktopWindowState,
) => void;
export type BbDesktopOpenNewTabHandler = () => void;
export type BbDesktopOpenLinkHandler = (url: string) => void;
// A command, or a shortcut pressed in a focused browser page that the renderer
// resolves with its own context.
export type BbDesktopAppCommandHandler = (
  command: AppCommandId | AppShortcutInput,
) => void;
export type BbDesktopCloseWindowRequestHandler = () => boolean;

export interface BbDesktopApi extends BbDesktopInfo {
  browser: BbDesktopBrowserApi;
  checkForUpdates(): Promise<BbDesktopInfo>;
  getInfo(): Promise<BbDesktopInfo>;
  getWindowState?(): Promise<BbDesktopWindowState>;
  getZoomFactor?(): number;
  installUpdate(): Promise<void>;
  /** Mac: copies the app into Applications and reopens it from there. False when it didn't move. */
  moveToApplications?(): Promise<boolean>;
  onChange(listener: BbDesktopInfoChangeHandler): BbDesktopInfoUnsubscribe;
  onWindowStateChange?(
    listener: BbDesktopWindowStateChangeHandler,
  ): BbDesktopInfoUnsubscribe;
  onOpenNewTab?(listener: BbDesktopOpenNewTabHandler): BbDesktopInfoUnsubscribe;
  onOpenLink?(listener: BbDesktopOpenLinkHandler): BbDesktopInfoUnsubscribe;
  onTopRightWindowDrag?(
    listener: (position: string) => void,
  ): BbDesktopInfoUnsubscribe;
  onAppCommand?(listener: BbDesktopAppCommandHandler): BbDesktopInfoUnsubscribe;
  onAddImageToChat?(
    listener: (imageUrl: string) => void,
  ): BbDesktopInfoUnsubscribe;
  onCloseWindowRequest?(
    listener: BbDesktopCloseWindowRequestHandler,
  ): BbDesktopInfoUnsubscribe;
  openExternalUrl(url: string): void;
  /** Opens one of your Macs in this window; null means this Mac. */
  openComputer?(handle: string | null): Promise<void>;
  /** The reconnect dialog: true gives the lost Mac another 30 seconds, false stops trying and stays on this Mac. */
  reconnectComputer?(keepTrying: boolean): Promise<void>;
  /** Asks for a fresh list of your Macs (at most once a minute). The new list arrives through onChange. */
  refreshComputers?(): void;
  openServerDaemonLogs?(): Promise<void>;
  setTheme(theme: BbDesktopTheme): void;
  setBadgeCount?(count: number): void;
  focusWindow?(): void;
}
