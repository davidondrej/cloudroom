import { useId, useState, type CSSProperties } from "react";
import { cn } from "@cloudroom/shared-ui/lib/utils";

// The wave chart on Settings → Analytics: Cloud Credits and Tokens share it.

export function smooth(values: number[], sigma: number) {
  const reach = Math.ceil(sigma * 3);
  return values.map((_, i) => {
    let sum = 0, weight = 0;
    for (let o = -reach; o <= reach; o++) {
      const v = values[i + o];
      if (v === undefined) continue;
      const k = Math.exp(-(o * o) / (2 * sigma * sigma));
      sum += v * k; weight += k;
    }
    return sum / weight;
  });
}
/** Monotone cubic through the points, so the wave never dips below zero. */
export function curve(points: [number, number][]) {
  const k = points.length, dx: number[] = [], m: number[] = [], t: number[] = [];
  for (let i = 0; i < k - 1; i++) { dx[i] = points[i + 1]![0] - points[i]![0]; m[i] = (points[i + 1]![1] - points[i]![1]) / dx[i]!; }
  t[0] = m[0]!; t[k - 1] = m[k - 2]!;
  for (let i = 1; i < k - 1; i++) t[i] = m[i - 1]! * m[i]! <= 0 ? 0 : (m[i - 1]! + m[i]!) / 2;
  let d = `M${points[0]![0]},${points[0]![1]}`;
  for (let i = 0; i < k - 1; i++) {
    const [x0, y0] = points[i]!, [x1, y1] = points[i + 1]!, h = dx[i]! / 3;
    d += ` C${x0 + h},${y0 + t[i]! * h} ${x1 - h},${y1 - t[i + 1]! * h} ${x1},${y1}`;
  }
  return d;
}

const Dot = ({ style }: { style?: CSSProperties }) => <span className="pointer-events-none absolute -mt-[5px] -ml-[5px] size-2.5 rounded-full border-2 border-background bg-primary" style={style} />;

export interface WavePoint { value: number; top: { name: string; value: number }[] }
interface WavePlotProps {
  /** Two points or more. */
  points: WavePoint[];
  sigma: number;
  format: (value: number) => string;
  /** Follows the hovered point's number: "credits", "written". */
  unit: string;
  /** The hovered point's heading. */
  when: (index: number) => string;
  labels: { i: number; text: string }[];
  /** Vertical guide lines. */
  marks?: number[];
  standouts: { at: number; name: string; detail: string }[];
}

/** The wave: the biggest bursts named, and hover shows a point's number and its top threads. */
export function WavePlot({ points, sigma, format, unit, when, labels, marks = [], standouts }: WavePlotProps) {
  const [hover, setHover] = useState<number | null>(null), gradient = useId(), last = points.length - 1;
  const values = smooth(points.map((point) => point.value), sigma), peak = Math.max(...values) * 1.3;
  const x = (i: number) => (i / last) * 100, y = (v: number) => 100 - (v / peak) * 100;
  const line = curve(values.map((v, i) => [x(i) * 10, y(v)]));
  const focus = hover === null ? null : points[hover]!;
  return (
    <div>
      <div
        className="relative mt-14 h-52 cursor-crosshair"
        onMouseMove={(event) => {
          const box = event.currentTarget.getBoundingClientRect();
          setHover(Math.min(last, Math.max(0, Math.round(((event.clientX - box.left) / box.width) * last))));
        }}
        onMouseLeave={() => setHover(null)}
      >
        {marks.map((i) => <span key={i} className="absolute inset-y-0 w-px bg-border/50" style={{ left: `${x(i)}%` }} />)}
        <svg aria-hidden viewBox="0 0 1000 100" preserveAspectRatio="none" className="absolute inset-0 size-full overflow-visible">
          <defs>
            <linearGradient id={gradient} x1="0" y1="0" x2="0" y2="1">
              <stop offset="0" stopColor="var(--primary)" stopOpacity="0.45" />
              <stop offset="1" stopColor="var(--primary)" stopOpacity="0.05" />
            </linearGradient>
          </defs>
          <path d={`${line} L1000,100 L0,100 Z`} fill={`url(#${gradient})`} />
          <path d={line} fill="none" stroke="var(--primary)" strokeWidth={1.5} vectorEffect="non-scaling-stroke" />
        </svg>
        {hover === null
          ? standouts.map((note) => (
              <div key={note.at} className="pointer-events-none absolute" style={{ left: `${x(note.at)}%`, top: `${y(values[note.at]!)}%` }}>
                <Dot />
                <span className="absolute bottom-2 left-0 h-7 w-px bg-muted-foreground/50" />
                <span className={cn("absolute bottom-10 font-mono text-xs whitespace-nowrap text-muted-foreground", x(note.at) > 50 ? "-right-2 text-right" : "-left-2")}>
                  <span className="block text-foreground">{note.name}</span>
                  {note.detail}
                </span>
              </div>
            ))
          : null}
        <Dot style={{ left: "100%", top: `${y(values[last]!)}%` }} />
        {hover !== null && focus ? (
          <>
            <span className="pointer-events-none absolute inset-y-0 w-px bg-muted-foreground/60" style={{ left: `${x(hover)}%` }} />
            <Dot style={{ left: `${x(hover)}%`, top: `${y(values[hover]!)}%` }} />
            <div
              className="pointer-events-none absolute top-1 z-10 min-w-52 rounded-md border border-border bg-popover px-3 py-2.5 text-xs text-popover-foreground shadow-md"
              style={x(hover) > 75 ? { right: `calc(${100 - x(hover)}% + 12px)` } : { left: `calc(${x(hover)}% + 12px)` }}
            >
              <div className="text-muted-foreground">{when(hover)}</div>
              <div className="mt-0.5 mb-1.5 font-mono text-base text-foreground tabular-nums">{format(focus.value)} {unit}</div>
              {focus.top.map((thread, i) => (
                <div key={i} className="flex justify-between gap-4 leading-6">
                  <span className="max-w-64 truncate">{thread.name}</span>
                  <span className="font-mono tabular-nums">{format(thread.value)}</span>
                </div>
              ))}
            </div>
          </>
        ) : null}
      </div>
      <div className="relative mt-2 h-4 font-mono text-[11px] text-muted-foreground">
        {labels.map((label) => (
          <span key={label.i} className="absolute whitespace-nowrap" style={{ left: `${x(label.i)}%`, transform: `translateX(${x(label.i) < 4 ? 0 : x(label.i) > 96 ? -100 : -50}%)` }}>{label.text}</span>
        ))}
      </div>
    </div>
  );
}
