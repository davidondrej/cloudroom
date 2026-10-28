import { useEffect, useState } from "react";
import { Icon } from "@cloudroom/shared-ui/icon";
import { useCloudroomConnection } from "@/hooks/queries/cloudroom-queries";
import { reportUpgradePromptClick, useUpgradePromptViewed } from "@/lib/upgrade-prompt";

const SHOWN_AT_KEY = "cloudroom.tryCloudHint.shownAt";
const DAY = 86_400_000;
const MIN_DRAFT_LENGTH = 20;

export function TryCloudHint({ draftLength, onUseCloud }: { draftLength: number; onUseCloud: () => void }) {
  const connection = useCloudroomConnection().data;
  const [snoozed, setSnoozed] = useState(() => Date.now() - Number(localStorage.getItem(SHOWN_AT_KEY) ?? 0) < 3 * DAY);
  const lastCloudAt = connection?.lastCloudAt;
  const show = !snoozed && draftLength >= MIN_DRAFT_LENGTH && connection?.ready === true && !connection.cloudQueue
    && lastCloudAt !== undefined && (lastCloudAt === null || Date.now() - lastCloudAt > 2 * DAY);
  useEffect(() => {
    if (show) localStorage.setItem(SHOWN_AT_KEY, String(Date.now()));
  }, [show]);
  useUpgradePromptViewed(show ? "new_thread_cloud" : null);
  if (!show) return null;
  return (
    <div role="status" className="absolute top-full left-[-8px] z-50 mt-2.5 w-[300px] rounded-xl border border-muted-foreground/15 bg-popover p-3.5 text-[13px] leading-snug text-foreground shadow-xl">
      <span aria-hidden="true" className="absolute -top-[6px] left-5 size-2.5 rotate-45 border-t border-l border-muted-foreground/15 bg-popover" />
      <div className="flex items-center">
        <span className="flex-1 font-semibold">Run this one in Cloud?</span>
        <button type="button" aria-label="Dismiss" className="flex size-6 cursor-pointer items-center justify-center rounded text-muted-foreground hover:bg-state-hover hover:text-foreground" onClick={() => setSnoozed(true)}>
          <Icon name="X" className="size-3.5" aria-hidden="true" />
        </button>
      </div>
      <p className="mt-0.5 text-muted-foreground">It keeps going when you close your laptop.</p>
      <button
        type="button"
        className="mt-2.5 flex cursor-pointer items-center gap-1.5 rounded-md bg-primary px-2.5 py-1 text-[12.5px] font-semibold text-primary-foreground hover:opacity-90"
        onClick={() => {
          reportUpgradePromptClick("new_thread_cloud");
          setSnoozed(true);
          onUseCloud();
        }}
      >
        <Icon name="Cloud" className="size-3.5" aria-hidden="true" />
        Use Cloud
      </button>
    </div>
  );
}
