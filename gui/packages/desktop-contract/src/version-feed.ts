import { z } from "zod";

const isoUtcDateTimeSchema = z.iso.datetime();

const roomDesktopVersionFeedFileSchema = z.object({
  url: z.string().min(1),
  sha512: z.string().min(1),
  size: z.number().int().nonnegative(),
});

export const roomDesktopVersionFeedPlatformSchema = z.enum([
  "macos",
  "linux",
  "windows",
]);
export type RoomDesktopVersionFeedPlatform = z.infer<
  typeof roomDesktopVersionFeedPlatformSchema
>;

export const roomDesktopVersionFeedSchema = z.object({
  schemaVersion: z.literal(1),
  channel: z.enum(["latest", "nightly"]),
  platform: roomDesktopVersionFeedPlatformSchema,
  version: z.string().min(1),
  releaseDate: isoUtcDateTimeSchema,
  releaseName: z.string().min(1),
  releaseNotes: z.string().nullable(),
  minimumSystemVersion: z.string().min(1).nullable(),
  files: z.array(roomDesktopVersionFeedFileSchema).min(1),
  path: z.string().min(1),
  sha512: z.string().min(1),
  stagingPercentage: z.number().min(0).max(100).nullable(),
});
export type RoomDesktopVersionFeed = z.infer<typeof roomDesktopVersionFeedSchema>;

const ROOM_DESKTOP_VERSION_FEED_FILE_NAMES = {
  linux: "desktop-version-linux.json",
  macos: "desktop-version.json",
  windows: "desktop-version-windows.json",
} as const satisfies Record<RoomDesktopVersionFeedPlatform, string>;

export function createRoomDesktopVersionFeedFileName(
  platform: RoomDesktopVersionFeedPlatform,
): string {
  return ROOM_DESKTOP_VERSION_FEED_FILE_NAMES[platform];
}
