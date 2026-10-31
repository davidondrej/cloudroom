import { useEffect, useState } from "react";
import { COMPUTER } from "@cloudroom/domain";
import { Icon, type IconName } from "@cloudroom/shared-ui/icon";
import { useCloudroomConnection } from "@/hooks/queries/cloudroom-queries";
import { LAPTOP_HINT_PROMPT, laptopHintKind, useLaptopHint, type LaptopHint } from "@/lib/laptop-hints";
import { reportUpgradePromptClick, useUpgradePromptViewed } from "@/lib/upgrade-prompt";

const SHOWN_AT_KEY = "cloudroom.tryCloudHint.shownAt";
const DAY = 86_400_000;
const MIN_DRAFT_LENGTH = 20;
const OWN_MACHINE = `In Cloud this one gets its own machine, so your ${COMPUTER} stays fast.`;

function laptopCopy(hint: LaptopHint, battery: number | null, diskFreeGb: number | null, drops: number): { icon: IconName; title: string; body: string } {
  switch (hint) {
    case "battery": return { icon: "Battery", title: `${battery}% battery left`, body: `Run this one in Cloud. It won't drain your battery, and keeps going if your ${COMPUTER} dies.` };
    case "memory": return { icon: "Memory", title: `Your ${COMPUTER} is low on memory`, body: OWN_MACHINE };
    case "heat": return { icon: "Memory", title: `Your ${COMPUTER} is running hot`, body: OWN_MACHINE };
    case "cpu": return { icon: "Memory", title: `Your ${COMPUTER} is maxed out`, body: OWN_MACHINE };
    case "disk": return { icon: "HardDrive", title: `Only ${diskFreeGb} GB left on your ${COMPUTER}`, body: "A Cloud thread uses none of your disk." };
    case "network": return { icon: "WifiOff", title: "Your internet is patchy", body: `It dropped ${drops} times in 15 min. In Cloud this agent keeps working through it.` };
  }
}

export function TryCloudHint({ draftLength, github, onUseCloud }: { draftLength: number; github: boolean; onUseCloud: () => void }) {
  const connection = useCloudroomConnection().data;
  const [closed, setClosed] = useState(false);
  const [laptopSeen, setLaptopSeen] = useState(false);
  const laptop = useLaptopHint("new-thread", { enabled: !closed && draftLength >= MIN_DRAFT_LENGTH, github });
  if (laptop.hint && !laptopSeen) setLaptopSeen(true);
  const [snoozed, setSnoozed] = useState(() => Date.now() - Number(localStorage.getItem(SHOWN_AT_KEY) ?? 0) < 3 * DAY);
  const lastCloudAt = connection?.lastCloudAt;
  const show = !closed && !laptopSeen && !snoozed && draftLength >= MIN_DRAFT_LENGTH && connection?.ready === true && !connection.cloudQueue
    && lastCloudAt !== undefined && (lastCloudAt === null || Date.now() - lastCloudAt > 2 * DAY);
  useEffect(() => {
    if (show || laptop.hint) localStorage.setItem(SHOWN_AT_KEY, String(Date.now()));
  }, [show, laptop.hint]);
  const where = laptop.hint ? LAPTOP_HINT_PROMPT[laptopHintKind(laptop.hint)] : show ? "new_thread_cloud" : null;
  useUpgradePromptViewed(where);
  if (!where) return null;
  const copy = laptop.hint
    ? laptopCopy(laptop.hint, laptop.vitals?.battery ?? null, laptop.vitals?.diskFreeGb ?? null, laptop.drops)
    : { icon: null, title: "Run this one in Cloud?", body: "It keeps going when you close your laptop." };
  const close = () => {
    setClosed(true);
    if (laptop.hint) laptop.dismiss();
    else setSnoozed(true);
  };
  return (
    <div role="status" className="absolute top-full left-[-8px] z-50 mt-2.5 w-[300px] rounded-xl border border-muted-foreground/15 bg-popover p-3.5 text-[13px] leading-snug text-foreground shadow-xl">
      <span aria-hidden="true" className="absolute -top-[6px] left-5 size-2.5 rotate-45 border-t border-l border-muted-foreground/15 bg-popover" />
      <div className="flex items-center gap-1.5">
        {copy.icon && <Icon name={copy.icon} className="size-3.5 shrink-0 text-warning-text" aria-hidden="true" />}
        <span className="flex-1 font-semibold">{copy.title}</span>
        <button type="button" aria-label="Dismiss" className="flex size-6 cursor-pointer items-center justify-center rounded text-muted-foreground hover:bg-state-hover hover:text-foreground" onClick={close}>
          <Icon name="X" className="size-3.5" aria-hidden="true" />
        </button>
      </div>
      <p className="mt-0.5 text-muted-foreground">{copy.body}</p>
      <button
        type="button"
        className="mt-2.5 flex cursor-pointer items-center gap-1.5 rounded-md bg-primary px-2.5 py-1 text-[12.5px] font-semibold text-primary-foreground hover:opacity-90"
        onClick={() => {
          reportUpgradePromptClick(where);
          close();
          onUseCloud();
        }}
      >
        <Icon name="Cloud" className="size-3.5" aria-hidden="true" />
        Use Cloud
      </button>
    </div>
  );
}
