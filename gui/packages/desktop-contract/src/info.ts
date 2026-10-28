import { z } from "zod";
import type { BbDesktopBrowserApi } from "./browser.js";
import { bbDesktopVersionFeedPlatformSchema } from "./version-feed.js";
import type { AppCommandId } from "@cloudroom/domain";

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
    .object({ handle: z.string(), name: z.string(), back: z.boolean() })
    .nullable(),
});

export const bbDesktopInfoSchema = z.object({
  autoUpdateEnabled: z.boolean().optional(),
  computers: bbDesktopComputersSchema.optional(),
  downloadState: bbDesktopDownloadStateSchema.optional(),
  installNeedsPassword: z.boolean().optional(),
  lastCheckedAt: isoUtcDateTimeSchema.nullable(),
  latestVersion: z.string().min(1).nullable(),
  pendingVersion: z.string().min(1).nullable(),
  platform: bbDesktopVersionFeedPlatformSchema,
  serverDaemonLogsAvailable: z.boolean().optional(),
  updateAvailable: z.boolean(),
  updateDownloaded: z.boolean(),
  version: z.string().min(1),
});
export type BbDesktopInfo = z.infer<typeof bbDesktopInfoSchema>;

export const bbDesktopWindowStateSchema = z
  .object({
    isFullScreen: z.boolean(),
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
export type BbDesktopAppCommandHandler = (command: AppCommandId) => void;
export type BbDesktopCloseWindowRequestHandler = () => boolean;

export interface BbDesktopApi extends BbDesktopInfo {
  browser: BbDesktopBrowserApi;
  checkForUpdates(): Promise<BbDesktopInfo>;
  getInfo(): Promise<BbDesktopInfo>;
  getWindowState?(): Promise<BbDesktopWindowState>;
  getZoomFactor?(): number;
  installUpdate(): Promise<void>;
  onChange(listener: BbDesktopInfoChangeHandler): BbDesktopInfoUnsubscribe;
  onWindowStateChange?(
    listener: BbDesktopWindowStateChangeHandler,
  ): BbDesktopInfoUnsubscribe;
  onOpenNewTab?(listener: BbDesktopOpenNewTabHandler): BbDesktopInfoUnsubscribe;
  onOpenLink?(listener: BbDesktopOpenLinkHandler): BbDesktopInfoUnsubscribe;
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
  openServerDaemonLogs?(): Promise<void>;
  setTheme(theme: BbDesktopTheme): void;
  setBadgeCount?(count: number): void;
  focusWindow?(): void;
}
