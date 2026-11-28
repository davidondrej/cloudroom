import { useCallback, useEffect, useRef, useState } from "react";
import { experimental_ProviderIcon as ProviderIcon, experimental_useProviders as useProviders, useRealtime, useRpc, type StandardSchemaV1InferOutput } from "@get-bb/plugin-sdk/app";
import { Icon } from "@cloudroom/shared-ui/icon";
import { Input } from "@cloudroom/shared-ui/input";
import { Button } from "@cloudroom/shared-ui/button";
import { Textarea } from "@cloudroom/shared-ui/textarea";
import type { CHANGED as ChangedChannel, directorRpc } from "../server.js";

export type View = StandardSchemaV1InferOutput<(typeof directorRpc)["get"]["output"]>;
export type Config = View["config"];

const CHANGED: typeof ChangedChannel = "changed";
/** The app marks where the row goes; the plugin never targets the sidebar's own classes. */
export const SLOT = "[data-sidebar-top-slot]";
/** "Rank" is the Director's own icon; the rest are the app's. */
export const ICONS = ["Rank", "Target", "Zap", "Star", "Brain", "Eye", "Explore", "Workflow", "Terminal", "Globe", "Puzzle", "Coffee", "Play"];
/** The first is the default; "" is the app's own color. */
export const COLORS = ["#a78bfa", "", "#7dd3fc", "#fdba74", "#f9a8d4", "#fca5a5", "#ffffff"];
export const INTERVALS: ReadonlyArray<[label: string, minutes: number]> = [["5 min", 5], ["15 min", 15], ["1 hour", 60], ["6 hours", 360]];
export const message = (error: unknown) => (error instanceof Error ? error.message : String(error));

export function useDirector() {
  const rpc = useRpc<typeof directorRpc>();
  const [view, setView] = useState<View | null>(null);
  const refresh = useCallback(() => void rpc.call("get", null).then(setView, () => {}), [rpc]);
  useEffect(refresh, [refresh]);
  useRealtime(CHANGED, refresh);
  return { rpc, view, setView, refresh };
}

/** "42m", "2h", or "now". */
export function timeLeft(at: number): string {
  const minutes = Math.ceil((at - Date.now()) / 60_000);
  if (minutes <= 0) return "now";
  return minutes < 60 ? `${minutes}m` : `${Math.round(minutes / 60)}h`;
}

const darkness = new Map<string, boolean>();
/** True when a CSS color is dark, so the icon on it has to be light. */
function isDark(color: string): boolean {
  const known = darkness.get(color);
  if (known !== undefined) return known;
  const paint = document.createElement("canvas").getContext("2d");
  if (paint === null) return false;
  paint.fillStyle = color;
  paint.fillRect(0, 0, 1, 1);
  const [red = 0, green = 0, blue = 0] = paint.getImageData(0, 0, 1, 1).data;
  const dark = 0.299 * red + 0.587 * green + 0.114 * blue < 140;
  darkness.set(color, dark);
  return dark;
}

/** The Director's icon alone: its own (a general's star over two chevrons, drawn like the app's icons), one of the app's, or an emoji. */
export function Glyph({ icon, size }: { icon: string; size: number }) {
  if (icon === "Rank") {
    return (
      <svg xmlns="http://www.w3.org/2000/svg" width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={1.5} strokeLinecap="round" strokeLinejoin="round" className="shrink-0" aria-hidden="true">
        <path d="M12 2.5L13.23 5.8L16.76 5.95L14 8.15L14.94 11.55L12 9.6L9.06 11.55L10 8.15L7.24 5.95L10.77 5.8Z" />
        <path d="m5 14.5 7 3.25 7-3.25" />
        <path d="m5 18.25 7 3.25 7-3.25" />
      </svg>
    );
  }
  return ICONS.includes(icon) ? <Icon name={icon} style={{ width: size, height: size }} /> : <>{icon}</>;
}

/** The Director's icon in its small solid tile. */
export function Tile({ icon, color, size = 20 }: { icon: string; color: string; size?: number }) {
  const ink = color ? (isDark(color) ? "#ffffff" : "#141414") : "var(--primary-foreground)";
  return (
    <span
      className="flex shrink-0 items-center justify-center rounded-[6px]"
      style={{ width: size, height: size, background: color || "var(--primary)", color: ink, fontSize: size * 0.6 }}
      aria-hidden="true"
    >
      <Glyph icon={icon} size={size * 0.65} />
    </span>
  );
}

/** A text box that saves when the user leaves it. Its `key` is the saved text, so a save or reset redraws it. */
export function Prompt({ value, fallback, rows, max, className = "", reset = "outline", onSave }: { value: string; fallback: string; rows: number; max: number; className?: string; reset?: "outline" | "secondary"; onSave(next: string): void }) {
  const [draft, setDraft] = useState(value);
  const commit = (next: string) => {
    const text = next.trim() || fallback;
    setDraft(text);
    if (text !== value) onSave(text);
  };
  return (
    <div className="space-y-1.5">
      <Textarea rows={rows} maxLength={max} value={draft} onChange={(event) => setDraft(event.target.value)} onBlur={() => commit(draft)} className={`font-mono text-xs ${className}`} />
      {value !== fallback ? (
        <Button variant={reset} size="sm" onClick={() => commit(fallback)}>
          Reset to default
        </Button>
      ) : null}
    </div>
  );
}

/** Minutes between pings. Typed freely, saved on leaving the box or on Enter. Its `key` is the saved number. */
export function Minutes({ value, className = "", onSave }: { value: number; className?: string; onSave(next: number): void }) {
  const [draft, setDraft] = useState(String(value));
  const commit = () => {
    const typed = Math.round(Number(draft));
    const minutes = draft.trim() === "" || Number.isNaN(typed) ? value : Math.min(1440, Math.max(1, typed));
    setDraft(String(minutes));
    if (minutes !== value) onSave(minutes);
  };
  return (
    <Input
      type="number"
      min={1}
      max={1440}
      aria-label="Minutes between pings"
      className={`h-8 w-20 ${className}`}
      value={draft}
      onChange={(event) => setDraft(event.target.value)}
      onBlur={commit}
      onKeyDown={(event) => {
        if (event.key === "Enter") commit();
      }}
    />
  );
}

export const MAX_THREADS_MIN = 1;
export const MAX_THREADS_MAX = 20;

/** Compact − N + stepper for how many stopped threads a ping can check and unblock at once. */
export function MaxThreads({ value, onSave }: { value: number; onSave(next: number): void }) {
  const step = (delta: number) => {
    const next = Math.min(MAX_THREADS_MAX, Math.max(MAX_THREADS_MIN, value + delta));
    if (next !== value) onSave(next);
  };
  return (
    <span className="inline-flex h-7 items-center rounded-full bg-state-hover px-1">
      <button
        type="button"
        aria-label="Decrease max threads per ping"
        disabled={value <= MAX_THREADS_MIN}
        onClick={() => step(-1)}
        className="flex size-5 cursor-pointer items-center justify-center rounded-full text-sm leading-none text-muted-foreground hover:bg-state-active hover:text-foreground disabled:cursor-default disabled:opacity-40 disabled:hover:bg-transparent disabled:hover:text-muted-foreground"
      >
        −
      </button>
      <span className="min-w-6 text-center font-medium tabular-nums text-foreground">{value}</span>
      <button
        type="button"
        aria-label="Increase max threads per ping"
        disabled={value >= MAX_THREADS_MAX}
        onClick={() => step(1)}
        className="flex size-5 cursor-pointer items-center justify-center rounded-full text-sm leading-none text-muted-foreground hover:bg-state-active hover:text-foreground disabled:cursor-default disabled:opacity-40 disabled:hover:bg-transparent disabled:hover:text-muted-foreground"
      >
        +
      </button>
    </span>
  );
}

/** What a settings surface needs: the view, a save that queues, and the two actions. */
export function useSettings() {
  const { rpc, view, setView, refresh } = useDirector();
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  /** Saves run one at a time, so an older answer never lands on a newer change. */
  const saves = useRef<Promise<void>>(Promise.resolve());
  /** The newest unsaved settings, so two quick changes build on each other. */
  const unsaved = useRef<Config | null>(null);

  const save = (change: Partial<Config>) => {
    if (view === null) return;
    const next = { ...(unsaved.current ?? view.config), ...change };
    unsaved.current = next;
    setView({ ...view, config: next });
    setError(null);
    saves.current = saves.current
      .then(() => rpc.call("save", next))
      .then(
        (saved) => {
          // A newer change is still on its way; its own answer redraws the form.
          if (unsaved.current !== next) return;
          unsaved.current = null;
          setView(saved);
        },
        (cause: unknown) => {
          // A refused save must not stay in the form, or every later save would carry it.
          unsaved.current = null;
          setError(message(cause));
          refresh();
        },
      );
  };
  const forget = (id: string) => {
    setError(null);
    rpc.call("forget", { id }).then(setView, (cause: unknown) => setError(message(cause)));
  };
  /** Runs after the saves still on their way, so a ping right after an edit uses it. */
  const run = (method: "pingNow" | "skip") => {
    setBusy(true);
    setError(null);
    saves.current
      .then(() => rpc.call(method, null))
      .then(setView, (cause: unknown) => setError(message(cause)))
      .finally(() => setBusy(false));
  };
  return { view, save, run, forget, busy, error };
}

/** How well taught the Director is, in numbers and one sentence. */
export function taught(view: View) {
  const known = view.learned;
  if (!view.config.learning) return { on: false, done: 0, goal: 50, note: "Off. It acts on its own and remembers no corrections." };
  if (known === null) return { on: false, done: 0, goal: 50, note: "Sign in to Cloudroom to teach the Director. Lessons are saved with your account." };
  const done = Math.min(known.reviewed, known.goal);
  const note = view.waiting ? "It is waiting for your answer in its thread." : done < known.goal ? "It asks before it acts. Approve or correct it in its thread." : "Taught. It acts on its own and still learns from your corrections.";
  return { on: true, done, goal: known.goal, note: `${note} ${known.approved} right first time, ${known.lessons.length} lesson${known.lessons.length === 1 ? "" : "s"}.` };
}

/** The meter: "12 / 50 turns taught", a bar, and what it means right now. `onSkip` stops waiting for an answer. */
export function Meter({ view, onSkip }: { view: View; onSkip(): void }) {
  const { on, done, goal, note } = taught(view);
  return (
    <div>
      <div className="flex items-baseline gap-2">
        <span className={`text-[22px] font-semibold leading-none tabular-nums tracking-[-0.02em] ${on ? "text-foreground" : "text-subtle-foreground"}`}>
          {done} / {goal}
        </span>
        <span className="text-[13px] text-muted-foreground">turns taught</span>
      </div>
      <div className="mt-2.5 h-1.5 overflow-hidden rounded-full bg-state-active" role="progressbar" aria-label="Turns taught" aria-valuemin={0} aria-valuemax={goal} aria-valuenow={done}>
        <div className="h-full rounded-full transition-[width] duration-500" style={{ width: `${(100 * done) / goal}%`, background: view.config.color || "var(--primary)" }} />
      </div>
      <p className="mt-2 text-xs leading-relaxed text-muted-foreground">
        {note}
        {view.waiting ? (
          <button type="button" onClick={onSkip} className="ml-1.5 cursor-pointer font-medium text-foreground underline-offset-2 hover:underline">
            Skip it
          </button>
        ) : null}
      </p>
    </div>
  );
}

/** A red alert under the model picker when the Director's model is too weak or an older version (David, 2026-11-27). */
export function WeakModel({ check, onPick }: { check: View["modelCheck"]; onPick(agent: Config["agent"]): void }) {
  const { providers } = useProviders();
  if (check === null || check.problem === null) return null;
  const picks = check.picks.flatMap((pick) => {
    const provider = providers.find((each) => each.id === pick.agent.providerId);
    return provider ? [{ ...pick, provider }] : [];
  });
  return (
    <div className="mt-2.5 flex items-start gap-2.5 rounded-xl px-3.5 py-3" style={{ background: "color-mix(in oklab, var(--destructive) 14%, transparent)" }} role="alert">
      <span className="mt-0.5 shrink-0 text-destructive">
        <Icon name="AlertTriangle" className="size-4" />
      </span>
      <div className="min-w-0 space-y-2">
        <p className="text-[13px] font-semibold text-foreground">
          {check.name} is too {check.problem === "old" ? "old" : "weak"} to be your Director.
        </p>
        <p className="text-xs text-muted-foreground">Use a frontier model:</p>
        <div className="flex flex-wrap gap-1.5">
          {picks.map(({ name, agent, provider }) => (
            <button key={name} type="button" onClick={() => onPick(agent)} className="flex h-7 cursor-pointer items-center gap-1.5 rounded-full bg-state-hover px-2.5 text-[13px] text-foreground hover:bg-state-active">
              <ProviderIcon providerKind="agent" provider={provider} className="size-3.5 shrink-0" aria-hidden />
              {name}
            </button>
          ))}
        </div>
      </div>
    </div>
  );
}
