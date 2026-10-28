const DESKTOP_RELEASE_CHANNEL_ENV_NAME = "BB_DESKTOP_RELEASE_CHANNEL";

export const CLOUDROOM_UPDATE_BASE_URL =
  "https://github.com/davidondrej/cloudroom-gui/releases/latest/download/";

export function resolveDesktopReleaseChannel(env) {
  const rawChannel = env[DESKTOP_RELEASE_CHANNEL_ENV_NAME]?.trim();
  if (rawChannel === undefined || rawChannel.length === 0) {
    return "latest";
  }
  if (rawChannel === "latest" || rawChannel === "nightly") {
    return rawChannel;
  }

  throw new Error(
    `${DESKTOP_RELEASE_CHANNEL_ENV_NAME} must be latest or nightly, got ${rawChannel}.`,
  );
}

export function resolveDesktopBuildPlatform(nodePlatform) {
  if (nodePlatform === "darwin") {
    return "macos";
  }
  if (nodePlatform === "linux") {
    return "linux";
  }
  if (nodePlatform === "win32") {
    return "windows";
  }

  throw new Error(
    `Desktop builds support darwin, linux, and win32 only, got ${nodePlatform}.`,
  );
}

export function createDesktopReleaseConfig(channel) {
  if (channel === "nightly") {
    return {
      appId: "dev.cloudroom.gui.nightly",
      applicationName: "Cloudroom Nightly",
      artifactName: "gui-cloudroom-nightly-${version}-${arch}.${ext}",
      iconFileName: "icon-nightly.png",
      linuxDesktopName: "cloudroom-nightly.desktop",
      // The Linux binary name must differ from stable so both channels can be
      // installed at once without one shadowing the other on PATH.
      linuxExecutableName: "gui-cloudroom-nightly",
      macIconPath: "assets/icon-nightly.icns",
      releaseTag: "desktop-nightly",
      updateMetadataFileNames: {
        linux: "nightly-linux.yml",
        macos: "nightly-mac.yml",
        windows: "nightly.yml",
      },
      // electron-builder names the per-user install folder after the package:
      // %LOCALAPPDATA%\Programs\Cloudroom-Nightly.
      windowsInstallName: "Cloudroom-Nightly",
    };
  }

  return {
    appId: "dev.cloudroom.gui",
    applicationName: "Cloudroom",
    artifactName: "${productName}-${version}-${arch}.${ext}",
    iconFileName: "icon.png",
    linuxDesktopName: "cloudroom.desktop",
    linuxExecutableName: "gui-cloudroom",
    macIconPath: "assets/icon.icns",
    releaseTag: "desktop-latest",
    updateMetadataFileNames: {
      linux: "latest-linux.yml",
      macos: "latest-mac.yml",
      windows: "latest.yml",
    },
    windowsInstallName: "Cloudroom",
  };
}
