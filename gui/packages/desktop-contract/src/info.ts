import { z } from "zod";
import type { RoomDesktopBrowserApi } from "./browser.js";
import { roomDesktopVersionFeedPlatformSchema } from "./version-feed.js";
import type { AppCommandId, AppShortcutInput } from "@cloudroom/domain";

const isoUtcDateTimeSchema = z.iso.datetime();

const roomDesktopDownloadStateSchema = z.enum([
  "idle",
  "downloading",
  "downloaded",
  "failed",
]);

// Your Macs on the same Cloudroom account, and which one this window shows.
const roomDesktopComputersSchema = z.object({
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
  /** Set while this Mac stands in for the chosen Mac, which could not be reached. `back`: it is online again. */
  fallback: z
    .object({
      handle: z.string(),
      name: z.string(),
      back: z.boolean(),
    })
    .nullable(),
});

export const roomDesktopVitalsSchema = z.object({
  battery: z.number().nullable(),
  cpuBusySince: z.number().nullable(),
  memoryRedSince: z.number().nullable(),
  hotSince: z.number().nullable(),
  diskFreeGb: z.number().nullable(),
  // For the Cloud card's pictures (docs/scopes/laptop-hints.md). Each is sent only while its limit is hit.
  /** CPU use in percent over the last 5 minutes, oldest first. */
  cpu: z.array(z.number()).nullable().default(null),
  /** macOS memory pressure (1 normal, 2 warning, 4 critical) over the last 5 minutes, oldest first. */
  memory: z.array(z.number()).nullable().default(null),
  /** How hot, out of 4: 3 is macOS "serious", 4 is "critical". */
  heat: z.number().nullable().default(null),
  diskTotalGb: z.number().nullable().default(null),
  /** The last sleep or quit of 10+ minutes that stopped working Local agents, and which threads those were. */
  pause: z.object({ why: z.enum(["sleep", "quit"]), from: z.number(), to: z.number(), threads: z.array(z.string()) }).nullable().default(null),
});
export type RoomDesktopVitals = z.infer<typeof roomDesktopVitalsSchema>;

export const roomDesktopInfoSchema = z.object({
  autoUpdateEnabled: z.boolean().optional(),
  computers: roomDesktopComputersSchema.optional(),
  downloadState: roomDesktopDownloadStateSchema.optional(),
  /** The last Restart to update left this version installed. */
  installFailed: z.boolean().optional(),
  /** Mac: opened from the disk image or Downloads, so it can't update itself until it's moved to Applications. */
  installNeedsMove: z.boolean().optional(),
  installNeedsPassword: z.boolean().optional(),
  lastCheckedAt: isoUtcDateTimeSchema.nullable(),
  latestVersion: z.string().min(1).nullable(),
  pendingVersion: z.string().min(1).nullable(),
  platform: roomDesktopVersionFeedPlatformSchema,
  serverDaemonLogsAvailable: z.boolean().optional(),
  updateAvailable: z.boolean(),
  updateDownloaded: z.boolean(),
  version: z.string().min(1),
  vitals: roomDesktopVitalsSchema.optional(),
});
export type RoomDesktopInfo = z.infer<typeof roomDesktopInfoSchema>;

export const roomDesktopWindowStateSchema = z
  .object({
    isFullScreen: z.boolean(),
    isFocused: z.boolean().optional(),
  })
  .strict();
export type RoomDesktopWindowState = z.infer<typeof roomDesktopWindowStateSchema>;

export const roomDesktopThemeSchema = z.enum(["system", "light", "dark"]);
export type RoomDesktopTheme = z.infer<typeof roomDesktopThemeSchema>;

export type RoomDesktopInfoChangeHandler = (info: RoomDesktopInfo) => void;
export type RoomDesktopInfoUnsubscribe = () => void;
export type RoomDesktopWindowStateChangeHandler = (
  state: RoomDesktopWindowState,
) => void;
export type RoomDesktopOpenNewTabHandler = () => void;
export type RoomDesktopOpenLinkHandler = (url: string) => void;
// A command, or a shortcut pressed in a focused browser page that the renderer
// resolves with its own context.
export type RoomDesktopAppCommandHandler = (
  command: AppCommandId | AppShortcutInput,
) => void;
export type RoomDesktopCloseWindowRequestHandler = () => boolean;

export interface BbDesktopApi extends RoomDesktopInfo {
  browser: RoomDesktopBrowserApi;
  checkForUpdates(): Promise<RoomDesktopInfo>;
  getInfo(): Promise<RoomDesktopInfo>;
  getWindowState?(): Promise<RoomDesktopWindowState>;
  getZoomFactor?(): number;
  installUpdate(): Promise<void>;
  /** Mac: copies the app into Applications and reopens it from there. False when it didn't move. */
  moveToApplications?(): Promise<boolean>;
  onChange(listener: RoomDesktopInfoChangeHandler): RoomDesktopInfoUnsubscribe;
  onWindowStateChange?(
    listener: RoomDesktopWindowStateChangeHandler,
  ): RoomDesktopInfoUnsubscribe;
  onOpenNewTab?(listener: RoomDesktopOpenNewTabHandler): RoomDesktopInfoUnsubscribe;
  onOpenLink?(listener: RoomDesktopOpenLinkHandler): RoomDesktopInfoUnsubscribe;
  onTopRightWindowDrag?(
    listener: (position: string) => void,
  ): RoomDesktopInfoUnsubscribe;
  onAppCommand?(listener: RoomDesktopAppCommandHandler): RoomDesktopInfoUnsubscribe;
  onAddImageToChat?(
    listener: (imageUrl: string) => void,
  ): RoomDesktopInfoUnsubscribe;
  onCloseWindowRequest?(
    listener: RoomDesktopCloseWindowRequestHandler,
  ): RoomDesktopInfoUnsubscribe;
  openExternalUrl(url: string): void;
  /** Opens one of your Macs in this window; null means this Mac. */
  openComputer?(handle: string | null): Promise<void>;
  /** "Use this Mac" while the Mac on screen can't be reached: shows this Mac, and the other Mac stays your pick. */
  showThisComputer?(): Promise<void>;
  /** Asks for a fresh list of your Macs (at most once a minute). The new list arrives through onChange. */
  refreshComputers?(): void;
  openServerDaemonLogs?(): Promise<void>;
  setTheme(theme: RoomDesktopTheme): void;
  setBadgeCount?(count: number): void;
  focusWindow?(): void;
}
