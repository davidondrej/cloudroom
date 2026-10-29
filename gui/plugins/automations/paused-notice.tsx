import { useEffect, useState } from "react";
import { createRoot } from "react-dom/client";
import { Button } from "@cloudroom/shared-ui/button";
import { Icon } from "@cloudroom/shared-ui/icon";
import type { PausedLoop } from "./src/paused";

// A card in the top-right corner of every window when a loop's own failures paused it (ADR 0338): the reason, the
// failed runs, Open loop, and Resume. It asks this plugin's server once a minute while the window shows; the server
// reads the website at most every 15 minutes. Closing a card hides that pause on this Mac.
const LOOPS_PATH = "/plugins/automations/automations";
const SEEN_KEY = "cloudroom.loops.pausedSeen";
const POLL_MS = 60_000;
const MAX_CARDS = 3;

async function rpc(method: string, input: unknown = null): Promise<unknown> {
  const response = await fetch(`/api/v1/plugins/automations/rpc/${method}`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(input),
  });
  const body = (await response.json().catch(() => null)) as {
    ok?: boolean;
    result?: unknown;
    error?: string | { message?: string };
  } | null;
  if (!response.ok || body?.ok !== true)
    throw new Error(
      typeof body?.error === "string"
        ? body.error
        : (body?.error?.message ?? "Loops are unavailable."),
    );
  return body.result;
}

const readSeen = (): string[] => {
  try {
    const seen: unknown = JSON.parse(localStorage.getItem(SEEN_KEY) ?? "[]");
    return Array.isArray(seen)
      ? seen.filter((key) => typeof key === "string")
      : [];
  } catch {
    return [];
  }
};

/** Opens a route in the app's router without a reload. */
function open(path: string) {
  window.history.pushState({}, "", path);
  window.dispatchEvent(new PopStateEvent("popstate"));
}

const when = (at: number) => {
  const date = new Date(at);
  const time = date.toLocaleTimeString([], {
    hour: "numeric",
    minute: "2-digit",
  });
  return date.toDateString() === new Date().toDateString()
    ? time
    : `${date.toLocaleDateString([], { month: "short", day: "numeric" })}, ${time}`;
};

function PausedLoopCard({
  loop,
  onClose,
}: {
  loop: PausedLoop;
  onClose: () => void;
}) {
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const resume = () => {
    setPending(true);
    setError(null);
    const request =
      loop.kind === "local"
        ? rpc("automations_resume", {
            projectId: loop.projectId,
            automationId: loop.id,
          })
        : rpc("cloud_automations", {
            action: "update",
            id: loop.id,
            enabled: true,
          });
    request.then(onClose, (failed: Error) => {
      setPending(false);
      setError(failed.message);
    });
  };
  return (
    <div
      role="status"
      className="pointer-events-auto rounded-xl border border-foreground/15 bg-[color-mix(in_oklab,var(--foreground)_4%,var(--popover))] p-3.5 text-popover-foreground shadow-2xl"
    >
      <div className="flex items-center gap-2">
        <Icon
          name="Repeat"
          className="size-4 shrink-0 text-primary"
          aria-hidden
        />
        <span className="truncate text-sm font-semibold">{loop.name}</span>
        <span className="inline-flex shrink-0 items-center gap-1 rounded-md border border-foreground/15 px-1.5 py-px text-[11px] text-muted-foreground">
          <Icon
            name={loop.kind === "cloud" ? "Cloud" : "Laptop"}
            className="size-3 text-primary"
            aria-hidden
          />
          {loop.kind === "cloud" ? "Cloud" : "This Mac"}
        </span>
        <button
          type="button"
          onClick={onClose}
          aria-label="Close"
          className="ml-auto shrink-0 text-muted-foreground hover:text-foreground"
        >
          <Icon name="X" className="size-3.5" aria-hidden />
        </button>
      </div>
      <div className="mt-1 text-[13px] text-warning-text">
        Paused after {loop.failures} failed runs
      </div>
      <div className="mt-2.5 line-clamp-3 break-words rounded-lg border border-foreground/10 bg-background px-2.5 py-2 font-mono text-xs text-foreground/85">
        {loop.reason || "No error was saved."}
      </div>
      <div className="mt-2.5 flex items-center gap-1.5 text-xs text-muted-foreground">
        Runs
        {Array.from({ length: Math.min(loop.failures, 5) }, (_, i) => (
          <span
            key={i}
            className="flex size-4 items-center justify-center rounded bg-destructive/15 text-destructive-text"
          >
            <Icon name="X" className="size-2.5" aria-hidden />
          </span>
        ))}
        <span>· last at {when(loop.at)}</span>
      </div>
      {error && (
        <div className="mt-2 text-xs text-destructive-text">{error}</div>
      )}
      <div className="mt-3 flex justify-end gap-2">
        <Button
          variant="outline"
          size="sm"
          onClick={() => {
            open(
              loop.kind === "local" && loop.projectId
                ? `${LOOPS_PATH}/${loop.projectId}/${loop.id}`
                : LOOPS_PATH,
            );
            onClose();
          }}
        >
          Open loop
        </Button>
        <Button size="sm" disabled={pending} onClick={resume}>
          <Icon name="Play" className="size-3 fill-current" aria-hidden />
          Resume
        </Button>
      </div>
    </div>
  );
}

function PausedLoops() {
  const [loops, setLoops] = useState<PausedLoop[]>([]);
  const [seen, setSeen] = useState(readSeen);
  useEffect(() => {
    const load = () => {
      if (document.visibilityState !== "visible") return;
      rpc("paused_loops").then(
        (result) => setLoops((result as { loops: PausedLoop[] }).loops),
        () => {},
      );
    };
    // Another window closed a card.
    const sync = (event: StorageEvent) => {
      if (event.key === SEEN_KEY) setSeen(readSeen());
    };
    load();
    const timer = window.setInterval(load, POLL_MS);
    document.addEventListener("visibilitychange", load);
    window.addEventListener("storage", sync);
    return () => {
      window.clearInterval(timer);
      document.removeEventListener("visibilitychange", load);
      window.removeEventListener("storage", sync);
    };
  }, []);
  const close = (key: string) => {
    const next = [...readSeen().filter((each) => each !== key), key].slice(
      -200,
    );
    localStorage.setItem(SEEN_KEY, JSON.stringify(next));
    setSeen(next);
  };
  const shown = loops
    .filter((loop) => !seen.includes(loop.key))
    .slice(0, MAX_CARDS);
  if (!shown.length) return null;
  return (
    <div className="pointer-events-none fixed right-4 top-12 z-40 flex w-[360px] max-w-[calc(100vw-2rem)] flex-col gap-2">
      {shown.map((loop) => (
        <PausedLoopCard
          key={loop.key}
          loop={loop}
          onClose={() => close(loop.key)}
        />
      ))}
    </div>
  );
}

/** Content script: renders the cards outside any panel, so they show on every screen. */
export function mountPausedLoops(): () => void {
  const host = document.createElement("div");
  // The plugin's stylesheet only styles elements inside its own scope.
  host.setAttribute("data-bb-plugin", "automations");
  document.body.appendChild(host);
  const root = createRoot(host);
  root.render(<PausedLoops />);
  return () => {
    root.unmount();
    host.remove();
  };
}
