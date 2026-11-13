import { Icon } from "@cloudroom/shared-ui/icon";
import { cn } from "@cloudroom/shared-ui/lib/utils";

// Lime in dark mode and grey in light mode, like the picker's selected check:
// the accent is too pale to read on a light background.
const SPEED_TIER_ACCENT_CLASS = "text-subtle-foreground dark:text-primary";

interface SpeedTierIconProps {
  tier: "fast" | "ultrafast";
  className?: string;
}

export function SpeedTierIcon({ tier, className }: SpeedTierIconProps) {
  return (
    <span
      aria-hidden
      data-speed-tier={tier}
      className={cn("inline-flex shrink-0", SPEED_TIER_ACCENT_CLASS, className)}
    >
      <Icon name="Zap" className="size-3.5 fill-current" />
      {tier === "ultrafast" ? (
        <Icon name="Zap" className="-ml-1.5 size-3.5 fill-current" />
      ) : null}
    </span>
  );
}
