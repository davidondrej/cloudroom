// The Director's settings modal, opened from the three dots on its sidebar row.
// One quiet surface like the chat input: settings on the left, the two prompts on the right, all visible at once.
import { useEffect, useState, type ReactNode } from "react";
import { experimental_ProviderModelPicker as AgentPicker } from "@get-bb/plugin-sdk/app";
import { Dialog, DialogContent, DialogDescription, DialogTitle } from "@cloudroom/shared-ui/dialog";
import { Switch } from "@cloudroom/shared-ui/switch";
import { COLORS, ICONS, INTERVALS, Meter, Minutes, Prompt, Tile, timeLeft, useSettings, type Config } from "./parts.js";

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

const Agent = ({ config, save }: Ready) => <AgentPicker value={config.agent} onChange={(agent) => save({ agent })} allowProviderChange align="start" />;

const Role = (props: Ready) => (
  <Prompt key={props.config.role} value={props.config.role} fallback={props.view.defaults.role} rows={7} max={4096} className={`resize-none rounded-xl ${QUIET_INPUT}`} reset="secondary" onSave={(role) => props.save({ role })} />
);
const PingMessage = (props: Ready) => (
  <Prompt key={props.config.prompt} value={props.config.prompt} fallback={props.view.defaults.prompt} rows={2} max={2000} className={`resize-none rounded-xl ${QUIET_INPUT}`} reset="secondary" onSave={(prompt) => props.save({ prompt })} />
);

const status = ({ view, config }: Ready) => (config.ping ? `Next ping in ${timeLeft(view.nextAt)}` : "The timer is off");

function Footer({ run, busy, view, error, onClose }: Ready) {
  return (
    <div className="flex flex-wrap items-center gap-2">
      <Quiet onClick={() => run("pingNow")} disabled={busy}>
        Ping now
      </Quiet>
      <Quiet onClick={() => run("fresh")} disabled={busy || view.threadId === null}>
        New Director thread
      </Quiet>
      <span className={`min-w-40 flex-1 truncate px-1 text-xs ${error ? "text-destructive" : "text-subtle-foreground"}`}>{error ?? (view.last ? `Last ping: ${view.last.text}` : "")}</span>
      <Quiet onClick={onClose}>Done</Quiet>
    </div>
  );
}

const TimerSwitch = ({ config, save }: Ready) => <Switch checked={config.ping} onCheckedChange={(ping) => save({ ping })} aria-label="Wake the Director on a timer" />;

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
      <DialogContent hideCloseButton className={`max-w-[min(920px,calc(100vw-2rem))] md:max-h-[calc(100dvh-2rem)] md:overflow-y-auto max-md:pb-[max(1rem,env(safe-area-inset-bottom))] ${SURFACE}`}>
        <div className="flex items-center gap-3.5 px-8 pb-6 pt-7 max-md:px-4 max-md:pt-2">
          <Tile icon={config.icon} color={config.color} size={40} />
          <div className="min-w-0 flex-1">
            <DialogTitle className="text-[19px] font-semibold tracking-[-0.01em] text-foreground">Director</DialogTitle>
            <DialogDescription className="text-[13px] text-muted-foreground">{status(props)}</DialogDescription>
          </div>
          <TimerSwitch {...props} />
        </div>
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
            {section("Ping every", <Interval {...props} />)}
            {section("Agent", <Agent {...props} />)}
            {section("Watches", <Watching {...props} />)}
            {section("Look", <Look {...props} />)}
          </div>
          <div className="space-y-5">
            {section("Role", <Role {...props} />)}
            {section("Ping message", <PingMessage {...props} />)}
          </div>
        </div>
        <div className="px-8 pb-6 max-md:px-4">
          <Footer {...props} />
        </div>
      </DialogContent>
    </Dialog>
  );
}
