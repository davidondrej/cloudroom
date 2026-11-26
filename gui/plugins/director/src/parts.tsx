import { useCallback, useEffect, useRef, useState } from "react";
import { useRealtime, useRpc, type StandardSchemaV1InferOutput } from "@get-bb/plugin-sdk/app";
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
export const ICONS = ["Target", "Zap", "Star", "Brain", "Eye", "Explore", "Workflow", "Terminal", "Globe", "Puzzle", "Coffee", "Play"];
export const COLORS = ["", "#7dd3fc", "#c4b5fd", "#fdba74", "#f9a8d4", "#fca5a5", "#ffffff"];
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

/** The Director's icon in its small solid tile. */
export function Tile({ icon, color, size = 20 }: { icon: string; color: string; size?: number }) {
  const ink = color ? (isDark(color) ? "#ffffff" : "#141414") : "var(--primary-foreground)";
  return (
    <span
      className="flex shrink-0 items-center justify-center rounded-[6px]"
      style={{ width: size, height: size, background: color || "var(--primary)", color: ink, fontSize: size * 0.6 }}
      aria-hidden="true"
    >
      {ICONS.includes(icon) ? <Icon name={icon} style={{ width: size * 0.65, height: size * 0.65 }} /> : icon}
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
    const minutes = draft.trim() === "" || Number.isNaN(typed) ? value : Math.min(1440, Math.max(5, typed));
    setDraft(String(minutes));
    if (minutes !== value) onSave(minutes);
  };
  return (
    <Input
      type="number"
      min={5}
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
  const run = (method: "pingNow" | "fresh" | "skip") => {
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
