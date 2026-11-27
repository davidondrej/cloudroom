import { useState } from "react";
import { Button } from "@cloudroom/shared-ui/button";
import { Icon } from "@cloudroom/shared-ui/icon";
import { BANNER_CLASS, publishBannerHeight } from "./DesktopUpdateBanner";
import { useWorktreeStorage } from "@/hooks/queries/system-queries";

const gb = (bytes: number) =>
  bytes < 1e9
    ? `${Math.round(bytes / 1e6)} MB`
    : `${(bytes / 1e9).toFixed(1)} GB`;

export function WorktreeDiskUse() {
  const storage = useWorktreeStorage().data;
  if (storage === undefined || storage.freeBytes === null) return null;
  return (
    <>
      {storage.usedBytes === null
        ? ""
        : `Worktrees use ${gb(storage.usedBytes)}. `}
      {gb(storage.freeBytes)} free on this computer.
    </>
  );
}

export function LowDiskBanner() {
  const storage = useWorktreeStorage().data;
  const [dismissed, setDismissed] = useState(false);
  if (!storage?.low || storage.freeBytes === null || dismissed) return null;
  return (
    <div
      ref={publishBannerHeight}
      role="alert"
      className={`flex shrink-0 items-center gap-3 px-4 py-2 text-sm ${BANNER_CLASS} [--banner-color:var(--destructive)]`}
    >
      <Icon name="AlertTriangle" className="size-4 shrink-0 text-destructive" />
      <span className="min-w-0 flex-1 truncate">
        <strong>
          The disk on {storage.computerName || "the computer running Cloudroom"}{" "}
          is almost full: {gb(storage.freeBytes)} free.
        </strong>{" "}
        {storage.usedBytes === null
          ? ""
          : `Worktrees use ${gb(storage.usedBytes)}. `}
        {storage.usedBytes !== null && storage.usedBytes < 1e9
          ? "Cloud threads are not affected."
          : "Archive finished threads to free space."}
      </span>
      <Button
        size="icon"
        variant="ghost"
        aria-label="Dismiss low disk warning"
        onClick={() => setDismissed(true)}
      >
        <Icon name="X" className="size-4" />
      </Button>
    </div>
  );
}
