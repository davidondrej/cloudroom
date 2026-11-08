import { Icon } from "@cloudroom/shared-ui/icon";
import { cn } from "@cloudroom/shared-ui/lib/utils";

// Lime in dark mode and grey in light mode, like the picker's selected check:
// the accent is too pale to read on a light background.
const SPEED_TIER_ACCENT_CLASS = "text-subtle-foreground dark:text-primary";

interface SpeedTierIconProps {
  tier: "fast" | "ultrafast";
  className?: string;
}

/**
 * One bolt for Fast. Ultrafast adds three speed streaks that fade in behind
 * the bolt and fly off to the left while its button is hovered
 * (see `.speed-tier-streak`). Each streak stops the same 2.5px short of the
 * bolt's edge, and sits on a quarter pixel so it stays sharp on 2x displays.
 */
export function SpeedTierIcon({ tier, className }: SpeedTierIconProps) {
  if (tier === "fast") {
    return (
      <span
        aria-hidden
        data-speed-tier="fast"
        className={cn(
          "inline-flex size-3.5 shrink-0",
          SPEED_TIER_ACCENT_CLASS,
          className,
        )}
      >
        <Icon name="Zap" className="size-3.5 fill-current" />
      </span>
    );
  }
  return (
    <span
      aria-hidden
      data-speed-tier="ultrafast"
      className={cn(
        "relative inline-block h-3.5 w-[1.5625rem] shrink-0",
        SPEED_TIER_ACCENT_CLASS,
        className,
      )}
    >
      <svg
        viewBox="0 0 25 14"
        fill="none"
        stroke="currentColor"
        strokeWidth={1.5}
        strokeLinecap="round"
        className="absolute inset-0 size-full [mask-image:linear-gradient(to_right,transparent,#000_45%)]"
      >
        <path className="speed-tier-streak" d="M5.98 3.25H11.98" />
        <path className="speed-tier-streak" d="M1.3 6.75H10.55" />
        <path className="speed-tier-streak" d="M7.29 10.25H13.29" />
      </svg>
      <Icon
        name="Zap"
        className="absolute top-0 right-0 size-3.5 fill-current"
      />
    </span>
  );
}
