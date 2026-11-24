import { useState } from "react";
import { Button } from "@cloudroom/shared-ui/button";
import { Icon } from "@cloudroom/shared-ui/icon";
import { publishBannerHeight } from "./DesktopUpdateBanner";
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
      className="flex shrink-0 items-center gap-3 border-b border-destructive/30 bg-destructive/10 px-4 py-2 text-sm"
    >
      <Icon name="AlertTriangle" className="size-4 shrink-0 text-destructive" />
      <span className="min-w-0 flex-1 truncate">
        <strong>Your disk is almost full: {gb(storage.freeBytes)} free.</strong>{" "}
        {storage.usedBytes === null
          ? ""
          : `Worktrees use ${gb(storage.usedBytes)}. `}
        Archive finished threads to free space.
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
