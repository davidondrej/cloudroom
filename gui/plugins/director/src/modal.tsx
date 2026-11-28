// The Director's settings modal, opened from the three dots on its sidebar row.
// One quiet surface like the chat input: settings on the left, the two prompts on the right, all visible at once.
import { useEffect, useState, type ReactNode } from "react";
import { experimental_ProviderModelPicker as AgentPicker, useBbNavigate } from "@get-bb/plugin-sdk/app";
import { Dialog, DialogContent, DialogDescription, DialogTitle } from "@cloudroom/shared-ui/dialog";
import { Switch } from "@cloudroom/shared-ui/switch";
import { COLORS, COMPACT_MAX, COMPACT_MIN, COMPACT_PRESETS, CompactPercent, ICONS, INTERVALS, MaxThreads, Meter, Minutes, Prompt, Tile, WeakModel, timeLeft, useSettings, type Config } from "./parts.js";

type Settings = ReturnType<typeof useSettings>;
type Ready = Settings & { view: NonNullable<Settings["view"]>; config: Config; onClose(): void };

/** The chat input's surface: no border, quiet shadow. */
const SURFACE = "gap-0 border-0 bg-composer p-0 shadow-message sm:rounded-2xl";
const QUIET_INPUT = "border-0 bg-state-hover shadow-none focus-visible:ring-0";
const LABEL = "text-[13px] font-medium text-muted-foreground";

function Chip({ on, onClick, children }: { on: boolean; onClick(): void; children: ReactNode }) {
  return (
    <button
      type="button"
      aria-pressed={on}
      onClick={onClick}
      className={`h-7 cursor-pointer rounded-full px-3 text-[13px] transition-colors ${on ? "bg-foreground text-background" : "bg-state-hover text-muted-foreground hover:bg-state-active hover:text-foreground"}`}
    >
      {children}
    </button>
  );
}

function Quiet({ onClick, disabled, children }: { onClick(): void; disabled?: boolean; children: ReactNode }) {
  return (
    <button type="button" onClick={onClick} disabled={disabled} className="h-8 cursor-pointer rounded-lg bg-state-hover px-3 text-[13px] font-medium text-foreground hover:bg-state-active disabled:cursor-default disabled:opacity-50">
      {children}
    </button>
  );
}

function Interval({ config, save }: Ready) {
  return (
    <div className="flex flex-wrap items-center gap-1.5">
      {INTERVALS.map(([label, minutes]) => (
        <Chip key={minutes} on={config.minutes === minutes} onClick={() => save({ minutes })}>
          {label}
        </Chip>
      ))}
      <Minutes key={config.minutes} value={config.minutes} className={`!h-7 !w-16 rounded-full text-center text-[13px] ${QUIET_INPUT}`} onSave={(minutes) => save({ minutes })} />
      <span className="text-xs text-subtle-foreground">min</span>
    </div>
  );
}

function Watching({ view, config, save }: Ready) {
  const watched = config.projectIds;
  const all = view.projects.map((project) => project.id);
  return (
    // Many projects scroll inside their own box, so the modal stays on screen.
    <div className="flex max-h-[7.5rem] flex-wrap gap-1.5 overflow-y-auto">
      <Chip on={watched === null} onClick={() => save({ projectIds: watched === null ? all : null })}>
        All projects
      </Chip>
      {view.projects.map((project) => (
        <Chip
          key={project.id}
          on={watched === null || watched.includes(project.id)}
          onClick={() => {
            const ids = watched ?? all;
            save({ projectIds: ids.includes(project.id) ? ids.filter((id) => id !== project.id) : [...ids, project.id] });
          }}
        >
          {project.name}
        </Chip>
      ))}
      <Chip on={config.watchLoops} onClick={() => save({ watchLoops: !config.watchLoops })}>
        Loop threads
      </Chip>
    </div>
  );
}

function Look({ config, save }: Ready) {
  return (
    <div className="space-y-2.5">
      <div className="flex flex-wrap items-center gap-0.5">
        {ICONS.map((icon) => (
          <button key={icon} type="button" aria-label={icon} aria-pressed={config.icon === icon} onClick={() => save({ icon })} className="cursor-pointer rounded-lg p-1 hover:bg-state-hover aria-pressed:bg-state-active">
            <Tile icon={icon} color={config.color} size={22} />
          </button>
        ))}
      </div>
      <div className="flex flex-wrap items-center gap-1">
        {COLORS.map((color) => (
          <button key={color || "accent"} type="button" aria-label={color || "App color"} aria-pressed={config.color === color} onClick={() => save({ color })} className="cursor-pointer rounded-full p-1 hover:bg-state-hover aria-pressed:bg-state-active">
            <span className="block size-5 rounded-full" style={{ background: color || "var(--primary)" }} />
          </button>
        ))}
      </div>
    </div>
  );
}

const Agent = ({ view, config, save }: Ready) => (
  <>
    <AgentPicker value={config.agent} onChange={(agent) => save({ agent })} allowProviderChange align="start" />
    <WeakModel check={view.modelCheck} onPick={(agent) => save({ agent })} />
  </>
);

const Role = (props: Ready) => (
  <Prompt key={props.config.role} value={props.config.role} fallback={props.view.defaults.role} rows={7} max={4096} className={`resize-none rounded-xl ${QUIET_INPUT}`} reset="secondary" onSave={(role) => props.save({ role })} />
);
const PingMessage = (props: Ready) => (
  <Prompt key={props.config.prompt} value={props.config.prompt} fallback={props.view.defaults.prompt} rows={2} max={2000} className={`resize-none rounded-xl ${QUIET_INPUT}`} reset="secondary" onSave={(prompt) => props.save({ prompt })} />
);

function AutoCompact({ view, config, save }: Ready) {
  const supported = view.supportsAutoCompact;
  const active = supported && config.autoCompact;
  return (
    <div className="space-y-2">
      <div className="flex items-center justify-between">
        <span className={LABEL}>Auto-compact</span>
        <Switch checked={config.autoCompact} disabled={!supported} onCheckedChange={(autoCompact) => save({ autoCompact })} aria-label="Auto-compact Director context" />
      </div>
      <div className={`space-y-2 transition-opacity ${active ? "" : "opacity-40"}`}>
        <div className="flex flex-wrap items-center gap-1.5">
          {COMPACT_PRESETS.map((percent) => (
            <Chip key={percent} on={active && config.autoCompactPercent === percent} onClick={() => supported && save({ autoCompact: true, autoCompactPercent: percent })}>
              {percent}%
            </Chip>
          ))}
          <CompactPercent
            key={config.autoCompactPercent}
            value={config.autoCompactPercent}
            disabled={!supported}
            className={`!h-7 !w-14 rounded-full text-center text-[13px] ${QUIET_INPUT}`}
            onSave={(autoCompactPercent) => supported && save({ autoCompact: true, autoCompactPercent })}
          />
          <span className="text-xs text-subtle-foreground">%</span>
        </div>
        <p className="text-xs text-muted-foreground">
          {!supported
            ? "Not supported by this harness."
            : config.autoCompact
              ? `Compacts the Director's thread when context hits ${config.autoCompactPercent}% (${COMPACT_MIN}%–${COMPACT_MAX}%).`
              : "Off. The harness decides when to compact."}
        </p>
      </div>
    </div>
  );
}

function Footer({ run, scan, busy, config, view, error, onClose }: Ready) {
  const navigate = useBbNavigate();
  return (
    <div className="flex flex-wrap items-center gap-2">
      <Quiet onClick={() => run("pingNow")} disabled={busy}>
        Ping now
      </Quiet>
      <Quiet
        onClick={() =>
          scan((threadId) => {
            onClose();
            navigate.toThread(threadId);
          })
        }
        disabled={busy || !config.learning}
      >
        Scan threads
      </Quiet>
      <span className={`min-w-40 flex-1 truncate px-1 text-xs ${error ? "text-destructive" : "text-subtle-foreground"}`}>{error ?? (view.last ? `Last ping: ${view.last.text}` : "")}</span>
      <Quiet onClick={onClose}>Done</Quiet>
    </div>
  );
}

const EASE = "duration-500 ease-[cubic-bezier(0.2,0.8,0.2,1)]";
const every = (minutes: number) => (minutes === 1 ? "every minute" : minutes === 60 ? "every hour" : minutes % 60 === 0 ? `every ${minutes / 60} hours` : `every ${minutes} minutes`);

/** While off: a tinted card beside the title with a big switch. Turning it on folds the card away (David, 2026-11-27). */
function TurnOn({ config, save }: Ready) {
  const on = config.ping;
  const tint = config.color || "var(--primary)";
  return (
    <div
      inert={on}
      aria-hidden={on}
      className={`flex shrink-0 items-center gap-4 overflow-hidden rounded-xl transition-all ${EASE} ${on ? "h-10 w-0 px-0 opacity-0 max-md:hidden" : "px-6 py-5 opacity-100 max-md:w-full md:ml-8 md:h-[112px] md:w-[470px]"}`}
      style={{ background: `color-mix(in oklab, ${tint} 16%, transparent)`, boxShadow: `inset 0 0 0 1px color-mix(in oklab, ${tint} 40%, transparent)` }}
    >
      <div className="min-w-0 flex-1 md:w-[330px] md:flex-none">
        <p className="whitespace-nowrap text-[19px] font-semibold text-foreground">Turn on the Director</p>
        <p className="mt-1 text-[14px] leading-snug text-muted-foreground">It checks your stopped threads {every(config.minutes)} and unblocks the obvious ones.</p>
      </div>
      <Switch
        size="default"
        checked={on}
        onCheckedChange={(ping) => save({ ping })}
        aria-label="Turn on the Director"
        className="h-7 w-12 data-[state=unchecked]:bg-state-active [&>span]:size-6 [&>span[data-state=checked]]:translate-x-5 [&>span[data-state=unchecked]]:bg-muted-foreground"
      />
    </div>
  );
}

/** Under the title: "Off", or once on a small neutral switch and the countdown. */
function Status({ config, save, view }: Ready) {
  const on = config.ping;
  return (
    <DialogDescription className="relative h-6 text-[13px] leading-6 text-muted-foreground">
      <span aria-hidden={on} className={`absolute inset-0 transition-opacity ${EASE} ${on ? "opacity-0" : ""}`}>
        Off
      </span>
      <span inert={!on} aria-hidden={!on} className={`absolute left-0 top-0 flex h-6 items-center gap-2 whitespace-nowrap transition-[opacity,transform] ${EASE} ${on ? "" : "translate-x-6 opacity-0"}`}>
        <Switch
          checked={on}
          onCheckedChange={(ping) => save({ ping })}
          aria-label="Wake the Director on a timer"
          className="data-[state=checked]:border-transparent data-[state=checked]:bg-state-active [&>span[data-state=checked]]:bg-muted-foreground"
        />
        <span className="text-subtle-foreground">Next ping in {timeLeft(view.nextAt)}</span>
      </span>
    </DialogDescription>
  );
}

const section = (label: string, control: ReactNode) => (
  <div className="space-y-2">
    <span className={LABEL}>{label}</span>
    <div>{control}</div>
  </div>
);

export function DirectorModal({ onClose }: { onClose(): void }) {
  const settings = useSettings();
  const [, tick] = useState(0);
  // Keeps the countdown fresh while the modal is open.
  useEffect(() => {
    const timer = window.setInterval(() => tick((count) => count + 1), 5_000);
    return () => window.clearInterval(timer);
  }, []);
  if (settings.view === null) return null;
  const props: Ready = { ...settings, view: settings.view, config: settings.view.config, onClose };
  const { config } = props;
  return (
    <Dialog
      open
      onOpenChange={(open) => {
        if (open) return;
        // Escape or a click outside first saves the text box being typed in.
        if (document.activeElement instanceof HTMLElement) document.activeElement.blur();
        onClose();
      }}
    >
      {/* At any zoom it leaves at least 7% of the window free above and below; the title and buttons stay put and only the middle scrolls. */}
      <DialogContent hideCloseButton className={`flex max-w-[min(920px,calc(100vw-2rem))] flex-col md:max-h-[calc(100dvh-max(4rem,14dvh))] md:overflow-hidden max-md:pb-[max(1rem,env(safe-area-inset-bottom))] ${SURFACE}`}>
        <div className="flex shrink-0 items-center gap-3.5 px-8 pb-6 pt-7 max-md:flex-wrap max-md:px-4 max-md:pt-2">
          <Tile icon={config.icon} color={config.color} size={40} />
          <div className="min-w-0 shrink-0">
            <DialogTitle className="text-[19px] font-semibold tracking-[-0.01em] text-foreground">Director</DialogTitle>
            <Status {...props} />
          </div>
          <TurnOn {...props} />
        </div>
        {/* While off, the settings stay usable but faint, so it is clear nothing runs. */}
        <div className={`transition-opacity ${EASE} ${config.ping ? "" : "opacity-25"} md:min-h-0 md:flex-1 md:overflow-y-auto md:pt-1 md:[mask-image:linear-gradient(to_bottom,transparent,black_16px,black_calc(100%-28px),transparent)]`}>
          <div className="mx-8 mb-6 flex items-start gap-6 rounded-xl bg-state-hover px-5 py-4 max-md:mx-4">
            <div className="min-w-0 flex-1">
              <Meter view={props.view} onSkip={() => props.run("skip")} />
            </div>
            <label className="flex shrink-0 items-center gap-2.5 text-[13px] font-medium text-muted-foreground">
              Learning
              <Switch checked={config.learning} onCheckedChange={(learning) => props.save({ learning })} aria-label="Learn from my corrections" />
            </label>
          </div>
          <div className="grid grid-cols-1 gap-x-10 gap-y-5 px-8 pb-6 max-md:px-4 md:grid-cols-2">
            <div className="space-y-5">
              {section(
                "Ping every",
                <>
                  <Interval {...props} />
                  <div className="mt-2.5 flex items-center gap-2 text-[13px] text-muted-foreground">
                    <span>Unblock up to</span>
                    <MaxThreads value={config.maxThreads} onSave={(maxThreads) => props.save({ maxThreads })} />
                    <span>{config.maxThreads === 1 ? "thread" : "threads"}</span>
                  </div>
                </>,
              )}
              {section("Agent", <Agent {...props} />)}
              {section("Watches", <Watching {...props} />)}
              {section("Look", <Look {...props} />)}
            </div>
            <div className="space-y-5">
              {section("Role", <Role {...props} />)}
              {section("Ping message", <PingMessage {...props} />)}
              <AutoCompact {...props} />
            </div>
          </div>
        </div>
        <div className="shrink-0 border-t border-border/50 px-8 py-4 max-md:px-4">
          <Footer {...props} />
        </div>
      </DialogContent>
    </Dialog>
  );
}
