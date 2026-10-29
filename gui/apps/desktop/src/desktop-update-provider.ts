import {
  createBbDesktopVersionFeedFileName,
  type BbDesktopVersionFeedPlatform,
} from "@cloudroom/desktop-contract";

type DesktopReleaseChannel = "latest" | "nightly";

// BB_DESKTOP_UPDATE_BASE_URL is set only at build time, for update tests against a local feed.
export const CLOUDROOM_UPDATE_BASE_URL =
  process.env.BB_DESKTOP_UPDATE_BASE_URL ||
  "https://github.com/davidondrej/cloudroom/releases/latest/download/";

interface DesktopReleaseInfo {
  applicationName: "Cloudroom" | "Cloudroom Nightly";
  channel: DesktopReleaseChannel;
  iconFileName: "icon.png" | "icon-nightly.png";
  releaseTag: "desktop-latest" | "desktop-nightly";
  updateReleaseBaseUrl: string;
}

export function createDesktopReleaseInfo(
  channel: DesktopReleaseChannel,
): DesktopReleaseInfo {
  const nightly = channel === "nightly";
  const releaseTag = nightly ? "desktop-nightly" : "desktop-latest";

  return {
    applicationName: nightly ? "Cloudroom Nightly" : "Cloudroom",
    channel,
    iconFileName: nightly ? "icon-nightly.png" : "icon.png",
    releaseTag,
    updateReleaseBaseUrl: CLOUDROOM_UPDATE_BASE_URL,
  };
}

function resolveBuiltDesktopReleaseChannel(
  rawChannel: string | undefined,
): DesktopReleaseChannel {
  if (rawChannel === undefined || rawChannel.length === 0) {
    return "latest";
  }
  if (rawChannel === "latest" || rawChannel === "nightly") {
    return rawChannel;
  }

  throw new Error(
    `Built desktop release channel must be latest or nightly, got ${String(rawChannel)}.`,
  );
}

export const DESKTOP_RELEASE_CHANNEL = resolveBuiltDesktopReleaseChannel(
  process.env.BB_DESKTOP_RELEASE_CHANNEL,
);
export const DESKTOP_RELEASE_INFO = createDesktopReleaseInfo(
  DESKTOP_RELEASE_CHANNEL,
);
const DESKTOP_UPDATE_RELEASE_BASE_URL =
  DESKTOP_RELEASE_INFO.updateReleaseBaseUrl;

export function createDesktopUpdateFeedUrl(
  platform: BbDesktopVersionFeedPlatform,
): string {
  return `${DESKTOP_UPDATE_RELEASE_BASE_URL}${createBbDesktopVersionFeedFileName(platform)}`;
}

export interface DesktopAutoUpdateFeedConfig {
  channel: DesktopReleaseChannel;
  provider: "generic";
  url: string;
}

export const DESKTOP_AUTO_UPDATE_FEED_CONFIG: DesktopAutoUpdateFeedConfig = {
  channel: DESKTOP_RELEASE_CHANNEL,
  provider: "generic",
  url: DESKTOP_UPDATE_RELEASE_BASE_URL,
};

interface DesktopUpdateSupport {
  autoUpdate: boolean;
  versionCheck: boolean;
}

interface ResolveDesktopUpdateSupportArgs {
  canReplaceAppImage: (appImagePath: string) => boolean;
  env: NodeJS.ProcessEnv;
  platform: BbDesktopVersionFeedPlatform;
}

export function resolveDesktopUpdateSupport(
  args: ResolveDesktopUpdateSupportArgs,
): DesktopUpdateSupport {
  // The NSIS installer replaces the per-user install in place, as Squirrel.Mac does on macOS.
  if (args.platform === "macos" || args.platform === "windows") {
    return { autoUpdate: true, versionCheck: true };
  }

  const appImagePath = args.env.APPIMAGE?.trim() ?? "";
  if (appImagePath.length === 0) {
    return { autoUpdate: false, versionCheck: true };
  }

  return {
    autoUpdate: args.canReplaceAppImage(appImagePath),
    versionCheck: true,
  };
}
