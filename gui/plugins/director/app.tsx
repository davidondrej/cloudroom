import { useCallback, useEffect, useRef, useState, type ReactNode } from "react";
import { createPortal } from "react-dom";
import {
  definePluginApp,
  experimental_ProviderModelPicker as AgentPicker,
  useBbNavigate,
  useRealtime,
  useRpc,
  type StandardSchemaV1InferOutput,
} from "@get-bb/plugin-sdk/app";
import { Button } from "@cloudroom/shared-ui/button";
import { Checkbox } from "@cloudroom/shared-ui/checkbox";
import { Icon } from "@cloudroom/shared-ui/icon";
import { Input } from "@cloudroom/shared-ui/input";
import { Switch } from "@cloudroom/shared-ui/switch";
import { Textarea } from "@cloudroom/shared-ui/textarea";
import type { CHANGED as ChangedChannel, directorRpc } from "./server.js";

type View = StandardSchemaV1InferOutput<(typeof directorRpc)["get"]["output"]>;
type Config = View["config"];

const CHANGED: typeof ChangedChannel = "changed";
/** The app marks where the row goes; the plugin never targets the sidebar's own classes. */
const SLOT = "[data-sidebar-top-slot]";
const ICONS = ["Target", "Zap", "Star", "Brain", "Eye", "Explore", "Workflow", "Terminal", "Globe", "Puzzle", "Coffee", "Play"];
const COLORS = ["", "#7dd3fc", "#c4b5fd", "#fdba74", "#f9a8d4", "#fca5a5", "#ffffff"];
const INTERVALS: ReadonlyArray<[label: string, minutes: number]> = [["5 min", 5], ["15 min", 15], ["1 hour", 60], ["6 hours", 360]];
const message = (error: unknown) => (error instanceof Error ? error.message : String(error));

function useDirector() {
  const rpc = useRpc<typeof directorRpc>();
  const [view, setView] = useState<View | null>(null);
  const refresh = useCallback(() => void rpc.call("get", null).then(setView, () => {}), [rpc]);
  useEffect(refresh, [refresh]);
  useRealtime(CHANGED, refresh);
  return { rpc, view, setView, refresh };
}

/** "42m", "2h", or "now". */
function timeLeft(at: number): string {
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
function Tile({ icon, color, size = 20 }: { icon: string; color: string; size?: number }) {
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

/** The sidebar row above Pinned. It opens the Director's thread. */
function Row() {
  const { rpc, view, refresh } = useDirector();
  const navigate = useBbNavigate();
  const [slot, setSlot] = useState<Element | null>(null);
  const [, redraw] = useState(0);
  const [opening, setOpening] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // The sidebar mounts and unmounts on its own; the same pass keeps the countdown fresh.
  useEffect(() => {
    const look = () => {
      setSlot(document.querySelector(SLOT));
      redraw((count) => count + 1);
    };
    look();
    const timer = window.setInterval(look, 2_000);
    return () => window.clearInterval(timer);
  }, []);

  const threadId = view?.threadId ?? null;
  const active = threadId !== null && window.location.pathname.endsWith(threadId);
  // Leaving the Director's thread means it was read, so the unread dot is asked for again.
  useEffect(() => {
    if (!active) refresh();
  }, [active, refresh]);

  if (slot === null || view === null) return null;
  const { config } = view;
  const open = () => {
    setOpening(true);
    setError(null);
    rpc
      .call("open", null)
      .then(({ threadId: id }) => navigate.toThread(id), (cause: unknown) => setError(message(cause)))
      .finally(() => setOpening(false));
  };

  return createPortal(
    <div className="mb-2">
      <button
        type="button"
        onClick={open}
        disabled={opening}
        aria-label="Open the Director"
        className={`flex h-[var(--bb-sidebar-row-height)] w-full cursor-pointer items-center gap-2 rounded-md pl-2 pr-2.5 text-sm text-sidebar-foreground hover:bg-sidebar-accent hover:text-sidebar-accent-foreground max-md:pointer-coarse:h-[var(--bb-sidebar-row-height-coarse)] ${active ? "bg-sidebar-accent" : ""}`}
      >
        <Tile icon={config.icon} color={config.color} />
        <span className="min-w-0 flex-1 truncate text-left font-medium text-foreground">Director</span>
        {view.unread && !active ? (
          <span className="size-1.5 shrink-0 rounded-full bg-primary" aria-label="New from the Director" />
        ) : (
          <span className="shrink-0 font-mono text-[11px] tabular-nums text-subtle-foreground">
            {opening ? "…" : config.ping ? timeLeft(view.nextAt) : "off"}
          </span>
        )}
      </button>
      {error ? (
        <p className="px-2 pt-1 text-xs leading-snug text-destructive" role="alert">
          The Director could not start: {error}
        </p>
      ) : null}
    </div>,
    slot,
  );
}

function Field({ title, hint, children }: { title: string; hint?: string; children: ReactNode }) {
  return (
    <div>
      <h3 className="text-sm font-medium text-foreground">{title}</h3>
      {hint ? <p className="mt-1 text-xs leading-relaxed text-muted-foreground">{hint}</p> : null}
      <div className="mt-2">{children}</div>
    </div>
  );
}

/** A text box that saves when the user leaves it. Its `key` is the saved text, so a save or reset redraws it. */
function Prompt({ value, fallback, rows, max, onSave }: { value: string; fallback: string; rows: number; max: number; onSave(next: string): void }) {
  const [draft, setDraft] = useState(value);
  const commit = (next: string) => {
    const text = next.trim() || fallback;
    setDraft(text);
    if (text !== value) onSave(text);
  };
  return (
    <div className="space-y-1.5">
      <Textarea rows={rows} maxLength={max} value={draft} onChange={(event) => setDraft(event.target.value)} onBlur={() => commit(draft)} className="font-mono text-xs" />
      {value !== fallback ? (
        <Button variant="outline" size="sm" onClick={() => commit(fallback)}>
          Reset to default
        </Button>
      ) : null}
    </div>
  );
}

/** Minutes between pings. Typed freely, saved on leaving the box or on Enter. Its `key` is the saved number. */
function Minutes({ value, onSave }: { value: number; onSave(next: number): void }) {
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
      className="h-8 w-20"
      value={draft}
      onChange={(event) => setDraft(event.target.value)}
      onBlur={commit}
      onKeyDown={(event) => {
        if (event.key === "Enter") commit();
      }}
    />
  );
}

function Settings() {
  const { rpc, view, setView, refresh } = useDirector();
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  /** Saves run one at a time, so an older answer never lands on a newer change. */
  const saves = useRef<Promise<void>>(Promise.resolve());
  /** The newest unsaved settings, so two quick changes build on each other. */
  const unsaved = useRef<Config | null>(null);

  if (view === null) return <p className="text-sm text-muted-foreground">Loading…</p>;
  const { config } = view;

  const save = (change: Partial<Config>) => {
    const next = { ...(unsaved.current ?? config), ...change };
    unsaved.current = next;
    setView({ ...view, config: next });
    setError(null);
    saves.current = saves.current
      .then(() => rpc.call("save", next))
      .then(
        (saved) => {
          if (unsaved.current === next) unsaved.current = null;
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
  const run = (method: "pingNow" | "fresh") => {
    setBusy(true);
    setError(null);
    rpc
      .call(method, null)
      .then(setView, (cause: unknown) => setError(message(cause)))
      .finally(() => setBusy(false));
  };
  const watched = config.projectIds;
  const toggleProject = (id: string, on: boolean) => {
    const ids = watched ?? view.projects.map((project) => project.id);
    save({ projectIds: on ? [...new Set([...ids, id])] : ids.filter((each) => each !== id) });
  };

  return (
    <div className="w-full space-y-6">
      <Field title="Ping" hint="Each ping checks one thread that stopped since the Director last looked. When nothing stopped, no model runs.">
        <label className="flex items-center gap-3 text-sm">
          <Switch checked={config.ping} onCheckedChange={(ping) => save({ ping })} aria-label="Wake the Director on a timer" />
          Wake the Director on a timer
        </label>
        <div className="mt-3 flex flex-wrap items-center gap-1.5">
          {INTERVALS.map(([label, minutes]) => (
            <Button key={minutes} size="sm" variant={config.minutes === minutes ? "secondary" : "outline"} onClick={() => save({ minutes })}>
              {label}
            </Button>
          ))}
          <Minutes key={config.minutes} value={config.minutes} onSave={(minutes) => save({ minutes })} />
          <span className="text-xs text-muted-foreground">minutes</span>
          <Button size="sm" variant="outline" className="ml-auto" disabled={busy} onClick={() => run("pingNow")}>
            Ping now
          </Button>
        </div>
        <p className="mt-2 text-xs text-muted-foreground" role="status">
          {view.last ? `Last ping ${new Date(view.last.at).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })}: ${view.last.text}. ` : "No ping yet. "}
          {config.ping ? `Next in ${timeLeft(view.nextAt)}.` : "The timer is off."}
        </p>
      </Field>

      <Field title="Agent" hint="The harness, model and effort the Director runs on. Changing the harness starts a new Director thread.">
        <AgentPicker value={config.agent} onChange={(agent) => save({ agent })} allowProviderChange align="start" />
      </Field>

      <Field title="What it watches" hint="Sub-agents and threads waiting on a prompt or a form are always skipped.">
        <label className="flex items-center gap-3 py-1 text-sm">
          <Checkbox checked={watched === null} onCheckedChange={(all) => save({ projectIds: all === true ? null : view.projects.map((project) => project.id) })} />
          All projects
        </label>
        {watched !== null
          ? view.projects.map((project) => (
              <label key={project.id} className="flex items-center gap-3 py-1 pl-6 text-sm">
                <Checkbox checked={watched.includes(project.id)} onCheckedChange={(on) => toggleProject(project.id, on === true)} />
                <span className="truncate">{project.name}</span>
              </label>
            ))
          : null}
        <label className="flex items-center gap-3 py-1 text-sm">
          <Checkbox checked={config.watchLoops} onCheckedChange={(on) => save({ watchLoops: on === true })} />
          Also threads that loops started
        </label>
      </Field>

      <Field title="Role" hint="The Director's standing instructions. An edit reaches it with its next ping.">
        <Prompt key={config.role} value={config.role} fallback={view.defaults.role} rows={12} max={4096} onSave={(role) => save({ role })} />
      </Field>

      <Field title="Ping message" hint="What each ping asks. The thread to check is added below it.">
        <Prompt key={config.prompt} value={config.prompt} fallback={view.defaults.prompt} rows={2} max={2000} onSave={(prompt) => save({ prompt })} />
      </Field>

      <Field title="Look" hint="The icon and color of the Director's row in the sidebar. Type an emoji to use your own icon.">
        <div className="flex flex-wrap items-center gap-1.5">
          {ICONS.map((icon) => (
            <button key={icon} type="button" aria-label={icon} aria-pressed={config.icon === icon} onClick={() => save({ icon })} className="cursor-pointer rounded-md p-1 hover:bg-state-hover aria-pressed:bg-state-active">
              <Tile icon={icon} color={config.color} size={22} />
            </button>
          ))}
          <Input
            key={config.icon}
            aria-label="Emoji icon"
            placeholder="Emoji"
            className="h-8 w-20"
            defaultValue={ICONS.includes(config.icon) ? "" : config.icon}
            onBlur={(event) => {
              const icon = event.target.value.trim();
              if (icon && icon !== config.icon) save({ icon: [...icon].slice(0, 4).join("") });
            }}
          />
        </div>
        <div className="mt-2 flex flex-wrap items-center gap-1.5">
          {COLORS.map((color) => (
            <button key={color || "accent"} type="button" aria-label={color || "App color"} aria-pressed={config.color === color} onClick={() => save({ color })} className="cursor-pointer rounded-md p-1 hover:bg-state-hover aria-pressed:bg-state-active">
              <span className="block size-5 rounded-full" style={{ background: color || "var(--primary)" }} />
            </button>
          ))}
          <Input
            key={config.color}
            aria-label="Custom color"
            placeholder="#bfff00"
            className="h-8 w-28"
            defaultValue={COLORS.includes(config.color) ? "" : config.color}
            onBlur={(event) => {
              const color = event.target.value.trim();
              if (color && color !== config.color && CSS.supports("color", color)) save({ color });
            }}
          />
        </div>
      </Field>

      <Field title="Start over" hint="Archives the Director's thread. The next ping starts a new one with a clean memory.">
        <Button size="sm" variant="outline" disabled={busy || view.threadId === null} onClick={() => run("fresh")}>
          New Director thread
        </Button>
      </Field>

      {error ? (
        <p className="text-xs text-destructive" role="alert">
          {error}
        </p>
      ) : null}
    </div>
  );
}

export default definePluginApp((app) => {
  app.slots.experimental_appOverlay({ id: "sidebar-row", component: Row });
  app.slots.settingsSection({ id: "director", component: Settings });
});
