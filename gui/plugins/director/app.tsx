import { useEffect, useState, type ReactNode } from "react";
import { createPortal } from "react-dom";
import { definePluginApp, experimental_ProviderModelPicker as AgentPicker, useBbNavigate } from "@get-bb/plugin-sdk/app";
import { Button } from "@cloudroom/shared-ui/button";
import { Checkbox } from "@cloudroom/shared-ui/checkbox";
import { Icon } from "@cloudroom/shared-ui/icon";
import { Input } from "@cloudroom/shared-ui/input";
import { Switch } from "@cloudroom/shared-ui/switch";
import { COLORS, ICONS, INTERVALS, Meter, Minutes, Prompt, SLOT, Tile, message, taught, timeLeft, useDirector, useSettings } from "./src/parts.js";
import { DirectorModal } from "./src/modal.js";

/** The sidebar row above Pinned. It opens the Director's thread. */
function Row() {
  const { rpc, view, refresh } = useDirector();
  const navigate = useBbNavigate();
  const [slot, setSlot] = useState<Element | null>(null);
  const [, redraw] = useState(0);
  const [opening, setOpening] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [settings, setSettings] = useState(false);

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
  // While it is being taught, the row shows how far along it is instead of the countdown.
  const learning = taught(view);
  const open = () => {
    setOpening(true);
    setError(null);
    rpc
      .call("open", null)
      .then(({ threadId: id }) => navigate.toThread(id), (cause: unknown) => setError(message(cause)))
      .finally(() => setOpening(false));
  };

  return (
    <>
      {createPortal(
        // The mark puts the row inside the plugin's own stylesheet scope.
        <div className="mb-2" data-room-plugin="director">
          <div
            className={`bb-sidebar-hover-actions-row group/director relative flex h-[var(--room-sidebar-row-height)] items-center rounded-md text-sm text-sidebar-foreground hover:bg-sidebar-accent max-md:pointer-coarse:h-[var(--room-sidebar-row-height-coarse)] ${active || settings ? "bg-sidebar-accent" : ""}`}
          >
            <button type="button" onClick={open} disabled={opening} aria-label="Open the Director" className="flex h-full min-w-0 flex-1 cursor-pointer items-center gap-2 rounded-md pl-2 pr-2.5">
              <Tile icon={config.icon} color={config.color} />
              <span className="min-w-0 flex-1 truncate text-left font-medium text-foreground">Director</span>
              <span className={`flex shrink-0 items-center group-hover/director:opacity-0 max-md:pointer-coarse:mr-9 ${settings ? "opacity-0" : ""}`}>
                {view.unread && !active ? (
                  <span className="size-1.5 rounded-full bg-primary" aria-label="New from the Director" />
                ) : (
                  <span className="font-mono text-[11px] tabular-nums text-subtle-foreground">{opening ? "…" : learning.on && learning.done < learning.goal ? `${learning.done}/${learning.goal}` : config.ping ? timeLeft(view.nextAt) : "off"}</span>
                )}
              </span>
            </button>
            {/* The same three dots a thread row shows on hover; here they open the settings. */}
            <span className="bb-sidebar-hover-actions absolute inset-y-0 right-0.5 flex items-center" data-sidebar-hover-actions-open={settings ? "true" : undefined} data-sidebar-hover-actions-mobile="always">
              <button
                type="button"
                aria-label="Director settings"
                onClick={() => setSettings(true)}
                className="flex h-7 w-7 cursor-pointer items-center justify-center rounded-md text-subtle-foreground outline-none hover:bg-state-hover hover:text-muted-foreground active:bg-state-active max-md:pointer-coarse:h-9 max-md:pointer-coarse:w-9"
              >
                <Icon name="MoreHorizontal" className="size-4" />
              </button>
            </span>
          </div>
          {error ? (
            <p className="px-2 pt-1 text-xs leading-snug text-destructive" role="alert">
              The Director could not start: {error}
            </p>
          ) : null}
        </div>,
        slot,
      )}
      {settings ? <DirectorModal onClose={() => setSettings(false)} /> : null}
    </>
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

function Settings() {
  const { view, save, run, forget, busy, error } = useSettings();
  if (view === null) return <p className="text-sm text-muted-foreground">Loading…</p>;
  const { config } = view;
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

      <Field title="Learning" hint="Until it is taught, the Director asks before it acts. It remembers each correction with the place it applies to. Lessons are saved with your Cloudroom account, so they work on every computer and from your phone.">
        <label className="mb-3 flex items-center gap-3 text-sm">
          <Switch checked={config.learning} onCheckedChange={(learning) => save({ learning })} aria-label="Learn from my corrections" />
          Learn from my corrections
        </label>
        <Meter view={view} onSkip={() => run("skip")} />
        {view.learned?.lessons.length ? (
          <ul className="mt-3 space-y-2">
            {[...view.learned.lessons].reverse().map((lesson) => (
              <li key={lesson.id} className="flex items-start gap-3 text-sm">
                <div className="min-w-0 flex-1">
                  <p className="text-foreground">“{lesson.words}”</p>
                  <p className="text-xs text-muted-foreground">
                    {lesson.scope === "general" ? "Always" : lesson.scope === "project" ? `Project ${lesson.target}` : "One thread"}
                    {lesson.meaning ? ` · ${lesson.meaning}` : ""}
                  </p>
                </div>
                <Button size="sm" variant="outline" onClick={() => forget(lesson.id)}>
                  Forget
                </Button>
              </li>
            ))}
          </ul>
        ) : null}
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
