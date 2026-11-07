import { useEffect, useState } from "react";
import { isBusyThread } from "@cloudroom/client-core";
import type { ThreadListEntry } from "@cloudroom/domain";
import { Button } from "@cloudroom/shared-ui/button";
import { Icon } from "@cloudroom/shared-ui/icon";
import {
  DESKTOP_DOWNLOAD_URL,
  useDesktopUpdateInfo,
} from "@/hooks/useDesktopUpdateInfo";
import { useHostDesktopUpdate } from "@/hooks/queries/cloudroom-queries";
import { useSidebarNavigationThreadSelection } from "@/hooks/queries/sidebar-navigation-query";
import { rawStringLocalStorage } from "@/lib/browser-storage";
import { localHostStatusAtom } from "@/lib/system-config-atoms";
import { openUrlInExternalBrowser } from "@/lib/url-open-routing";
import { useAsyncAtomValue } from "@/lib/use-async-atom-value";

const DISMISSED_VERSION_KEY = "cloudroom.update-banner.dismissed-version";
const DISMISSED_AT_KEY = "cloudroom.update-banner.dismissed-at";
const REMIND_AFTER_MS = 8 * 60 * 60 * 1000;
const HEIGHT_VAR = "--bb-update-banner-height";
const GIT_FOR_WINDOWS_URL = "https://git-scm.com/downloads/win";

// Window-pinned controls (e.g. the home right-panel toggle) read this to sit below the banners.
const shownBanners = new Set<HTMLDivElement>();
function publishBannersHeight() {
  const style = document.documentElement.style;
  const height = [...shownBanners].reduce((sum, banner) => sum + banner.offsetHeight, 0);
  if (shownBanners.size) style.setProperty(HEIGHT_VAR, `${height}px`);
  else style.removeProperty(HEIGHT_VAR);
}

export function publishBannerHeight(element: HTMLDivElement | null) {
  if (!element) return;
  shownBanners.add(element);
  publishBannersHeight();
  return () => {
    shownBanners.delete(element);
    publishBannersHeight();
  };
}

const selectAnyThreadBusy = (threads: ThreadListEntry[]) =>
  threads.some(isBusyThread);

function readDismissal() {
  return {
    version: rawStringLocalStorage.getItem(DISMISSED_VERSION_KEY, ""),
    at: Number(rawStringLocalStorage.getItem(DISMISSED_AT_KEY, "0")),
  };
}

// A closed banner returns after REMIND_AFTER_MS once no agent is working; the minute poll survives Mac sleep.
function useDismissal(version: string | null | undefined) {
  const [dismissal, setDismissal] = useState(readDismissal);
  const [now, setNow] = useState(Date.now);
  const agentsIdle =
    useSidebarNavigationThreadSelection(selectAnyThreadBusy).data === false;
  const hidden = Boolean(version) && version === dismissal.version;
  const remindDue = hidden && now >= dismissal.at + REMIND_AFTER_MS;

  useEffect(() => {
    if (!hidden || remindDue) return;
    const timer = setInterval(() => setNow(Date.now()), 60_000);
    return () => clearInterval(timer);
  }, [hidden, remindDue]);

  useEffect(() => {
    if (!remindDue || !agentsIdle) return;
    rawStringLocalStorage.removeItem(DISMISSED_VERSION_KEY);
    rawStringLocalStorage.removeItem(DISMISSED_AT_KEY);
    setDismissal({ version: "", at: 0 });
  }, [remindDue, agentsIdle]);

  const dismiss = (dismissedVersion: string) => {
    const at = Date.now();
    rawStringLocalStorage.setItem(DISMISSED_VERSION_KEY, dismissedVersion);
    rawStringLocalStorage.setItem(DISMISSED_AT_KEY, String(at));
    setDismissal({ version: dismissedVersion, at });
    setNow(at);
  };
  return { hidden, dismiss };
}

export function GitForWindowsBanner({ pinned = true }: { pinned?: boolean }) {
  const status = useAsyncAtomValue(localHostStatusAtom, null);
  if (!status?.gitMissing) return null;
  return (
    <div
      ref={pinned ? publishBannerHeight : undefined}
      role="alert"
      data-testid="git-for-windows-banner"
      className="flex shrink-0 items-center gap-3 border-b border-destructive/30 bg-destructive/10 px-4 py-2 text-sm"
    >
      <Icon name="AlertTriangle" className="size-4 shrink-0 text-destructive-text" />
      <span className="min-w-0 flex-1 truncate">
        <strong>Cloudroom needs Git for Windows.</strong> Install it, then
        restart Cloudroom.
      </span>
      <Button size="sm" onClick={() => openUrlInExternalBrowser(GIT_FOR_WINDOWS_URL)}>
        Download Git
      </Button>
    </div>
  );
}

// App-wide notice: Restart once the in-app update is ready; the website link only when the app can't update itself.
export function DesktopUpdateBanner() {
  const { desktopApi, desktopInfo } = useDesktopUpdateInfo();
  const host = useHostDesktopUpdate(desktopApi === null);
  const [clicked, setRestarting] = useState(false);
  const restarting = clicked || host?.restarting === true;
  // One key for the updater's "139.0.0" and the website's or other windows' "v139", so a dismissal sticks.
  const version = (
    host?.version ??
    desktopInfo?.pendingVersion ??
    desktopInfo?.latestVersion
  )?.replace(/^(\d+)\.0\.0$/u, "v$1");
  const dismissal = useDismissal(version);
  const ready =
    host !== null ||
    (desktopInfo?.updateDownloaded === true && desktopApi !== null);
  const cannotSelfUpdate =
    desktopInfo?.autoUpdateEnabled !== true ||
    desktopInfo.downloadState === "failed";
  // The last Restart to update left the old version: say so, and offer the website too.
  const failed = desktopInfo?.installFailed === true;
  if (
    (host === null && !desktopInfo?.updateAvailable) ||
    !version ||
    dismissal.hidden ||
    (!ready && !cannotSelfUpdate && !failed)
  ) {
    return null;
  }

  const dismiss = () => dismissal.dismiss(version);
  // A failed download (e.g. Wi-Fi still off after sleep) retries in-app; the website is only for apps that can't self-update.
  const download = () => {
    if (
      !failed &&
      desktopInfo?.autoUpdateEnabled === true &&
      desktopApi !== null
    ) {
      void desktopApi.checkForUpdates().catch(() => undefined);
      return;
    }
    openUrlInExternalBrowser(DESKTOP_DOWNLOAD_URL);
  };
  const restart = () => {
    if (host !== null) {
      host.restart();
      return;
    }
    setRestarting(true);
    void desktopApi
      ?.installUpdate()
      .catch(() => undefined)
      .finally(() => setRestarting(false));
  };

  return (
    <div
      ref={publishBannerHeight}
      role="status"
      data-testid="desktop-update-banner"
      className="flex shrink-0 items-center gap-3 border-b border-primary/30 bg-primary/10 px-4 py-2 text-sm"
    >
      <Icon name="Download" className="size-4 shrink-0 text-primary" />
      <span className="min-w-0 flex-1 truncate">
        {failed ? (
          <>
            <strong>The last update didn't install.</strong>{" "}
            {ready ? "Restart to try again, or download" : "Download"} the new
            version from the website.
          </>
        ) : ready ? (
          <>
            <strong>A new version of Cloudroom is ready.</strong> Restart to
            update.{" "}
            {desktopInfo?.installNeedsPassword
              ? "Enter your Mac password once, and future updates install by themselves."
              : "Running agents resume automatically."}
          </>
        ) : desktopInfo?.installNeedsMove ? (
          <>
            <strong>Cloudroom {version} is available.</strong> Move Cloudroom
            to your Applications folder and open it from there, so it can
            update itself.
          </>
        ) : (
          <>
            <strong>Cloudroom {version} is available.</strong> You have{" "}
            {desktopInfo?.version}. Download it to get the latest fixes.
          </>
        )}
      </span>
      {ready ? (
        <Button size="sm" disabled={restarting} onClick={restart}>
          {!restarting
            ? "Restart to update"
            : desktopInfo?.installNeedsPassword
              ? "Waiting for password…"
              : "Restarting…"}
        </Button>
      ) : null}
      {!ready || failed ? (
        <Button
          size="sm"
          variant={ready ? "outline" : "default"}
          onClick={download}
        >
          Download
        </Button>
      ) : null}
      <Button
        size="icon"
        variant="ghost"
        aria-label="Dismiss update notice"
        onClick={dismiss}
      >
        <Icon name="X" className="size-4" />
      </Button>
    </div>
  );
}
