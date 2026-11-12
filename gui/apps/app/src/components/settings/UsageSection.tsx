import type { ReactNode } from "react";
import { ToggleGroup, ToggleGroupItem } from "@cloudroom/shared-ui/toggle-group";
import { SettingsSection } from "@/components/ui/settings-section.js";

// Parts every Settings → Analytics tab shares.

export function Stat({ label, value, sub }: { label: string; value: string; sub?: string }) {
  return (
    <div className="min-w-0 flex-1 border border-border px-3.5 py-3">
      <div className="text-[11px] tracking-[0.08em] text-muted-foreground uppercase">{label}</div>
      <div className="mt-1 truncate font-mono text-xl text-foreground tabular-nums">
        {value}
        {sub ? <span className="ml-2 text-xs text-muted-foreground">{sub}</span> : null}
      </div>
    </div>
  );
}

export function RangeToggle<T extends string>({ value, options, onChange, label = "Time range" }: { value: T; options: readonly { value: T; label: ReactNode }[]; onChange: (next: T) => void; label?: string }) {
  return (
    <ToggleGroup type="single" aria-label={label} value={value} onValueChange={(next) => { if (next !== "") onChange(next as T); }} className="h-8 gap-0.5 rounded-md border border-input bg-background p-0.5">
      {options.map((option) => (
        <ToggleGroupItem key={option.value} value={option.value} className="h-6 rounded-sm px-2.5 text-xs font-medium text-muted-foreground shadow-none hover:bg-state-hover hover:text-foreground data-[state=on]:bg-state-active data-[state=on]:text-foreground data-[state=on]:hover:bg-state-active">
          {option.label}
        </ToggleGroupItem>
      ))}
    </ToggleGroup>
  );
}

export const RANGE_LABEL = { "7": "7d", "30": "30d", "90": "90d", "365": "1y" } as const;
export type UsageRange = keyof typeof RANGE_LABEL;

interface UsageSectionProps<TRange extends UsageRange, TData> {
  title: string;
  description: string;
  ranges: readonly TRange[];
  range: TRange;
  onRange: (next: TRange) => void;
  /** The saved or fresh result. Undefined only before the very first load. */
  data: TData | undefined;
  failed: boolean;
  children: (data: TData) => ReactNode;
}

/** One Analytics tab: title, range toggle, and the chart once there is data to draw. */
export function UsageSection<TRange extends UsageRange, TData>({ title, description, ranges, range, onRange, data, failed, children }: UsageSectionProps<TRange, TData>) {
  return (
    <SettingsSection title={title} description={description} action={<RangeToggle value={range} options={ranges.map((value) => ({ value, label: RANGE_LABEL[value] }))} onChange={onRange} />} plain>
      {data !== undefined ? <div className="space-y-5">{children(data)}</div>
        : <p className="text-sm text-muted-foreground">{failed ? `Couldn't load ${title.toLowerCase()}.` : "Loading…"}</p>}
    </SettingsSection>
  );
}

export const sum = (values: readonly number[]) => values.reduce((total, value) => total + value, 0);
export const n = (value: number) => Math.round(value).toLocaleString("en-US");
/** 1,234,567 → "1.23M". */
export function short(value: number): string {
  for (const [unit, size] of [["B", 1e9], ["M", 1e6], ["K", 1e3]] as const) {
    if (value >= size) return `${(value / size).toFixed(value / size >= 100 ? 0 : value / size >= 10 ? 1 : 2)}${unit}`;
  }
  return n(value);
}
/** 20 → "8 PM". */
export const hourName = (hour: number) => `${hour % 12 || 12} ${hour < 12 ? "AM" : "PM"}`;

/** Day `index` of a range that starts on `startDate`, as text. Days are dated in UTC so they never shift. */
export const dayText = (startDate: string, index: number, options: Intl.DateTimeFormatOptions = { month: "short", day: "numeric" }) =>
  new Date(Date.parse(`${startDate}T00:00:00Z`) + index * 86_400_000).toLocaleDateString("en-US", { ...options, timeZone: "UTC" });
/** Axis labels counted back from today: every day for a week, every 7th for a month, then every 14th. */
export function dayTicks(startDate: string, days: number): { i: number; text: string }[] {
  const step = days <= 7 ? 1 : days <= 30 ? 7 : 14, last = days - 1;
  return Array.from({ length: days }, (_, i) => i).filter((i) => (last - i) % step === 0)
    .map((i) => ({ i, text: i === last ? "today" : dayText(startDate, i, days <= 7 ? { weekday: "short" } : undefined).toLowerCase() }));
}
