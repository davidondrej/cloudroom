import { BbLogo } from "@/components/ui/bb-logo";
import { useBrandMark } from "@/hooks/useBrandMark";
import {
  CHROME_ROW_CLASS,
  MACOS_CHROME_CONTROL_AXIS_CLASS,
} from "@/lib/bb-desktop";
import { cn } from "@cloudroom/shared-ui/lib/utils";

/** The Cloudroom logo and name, shown in the top bar (Settings > Appearance). */
export function BrandMark() {
  return (
    <div
      data-testid="app-brand-mark"
      aria-hidden="true"
      className="pointer-events-none flex shrink-0 items-center gap-2 px-3 text-base leading-none font-semibold tracking-[-0.035em] text-foreground"
    >
      <BbLogo className="size-[1.125rem] rounded-[22%]" />
      <span>
        cloudroom
        <span className="ml-[0.08em] inline-block size-[0.18em] bg-primary" />
      </span>
    </div>
  );
}

/** For screens with no page header: the same name, centered in the top row. */
export function TopRowBrandMark({
  usesDesktopChrome,
}: {
  usesDesktopChrome: boolean;
}) {
  const [enabled] = useBrandMark();
  if (!enabled) {
    return null;
  }
  return (
    <div
      className={cn(
        CHROME_ROW_CLASS,
        "pointer-events-none absolute inset-x-0 top-0 z-10 justify-center",
        usesDesktopChrome && MACOS_CHROME_CONTROL_AXIS_CLASS,
      )}
    >
      <BrandMark />
    </div>
  );
}
