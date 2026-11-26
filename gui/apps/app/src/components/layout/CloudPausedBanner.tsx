import { Icon } from "@cloudroom/shared-ui/icon";
import { BANNER_CLASS, publishBannerHeight } from "./DesktopUpdateBanner";
import { useCloudroomAccount } from "@/hooks/queries/cloudroom-queries";

/** "Cloud is paused" on every screen while the website's database can't answer: an outage, or planned work like a
 *  security upgrade (David, 2026-11-16). It leaves by itself when Cloud is back, so it has no close button and no
 *  end time: we never know one. Reads the account poll the sidebar already runs; never fetches. */
export function CloudPausedBanner() {
  if (!useCloudroomAccount().data?.cloudPaused) return null;
  return (
    <div
      ref={publishBannerHeight}
      role="status"
      className={`flex shrink-0 items-center justify-center gap-2.5 px-4 py-2 text-sm ${BANNER_CLASS}`}
    >
      <Icon name="Cloud" className="size-4 shrink-0 text-primary" aria-hidden />
      <span className="min-w-0 truncate">
        <strong>Cloud is paused.</strong>{" "}
        <span className="text-muted-foreground">
          Cloud threads continue by themselves when it's back. Local threads work as normal.
        </span>
      </span>
    </div>
  );
}
