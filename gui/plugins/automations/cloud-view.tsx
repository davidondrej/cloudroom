import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useBbNavigate, useRpc, useSdk } from "@get-bb/plugin-sdk/app";
import { toast } from "sonner";
import { Switch } from "@cloudroom/shared-ui/switch";
import { Button } from "@cloudroom/shared-ui/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@cloudroom/shared-ui/dropdown-menu";
import { Icon } from "@cloudroom/shared-ui/icon";
import { loopsChanged, useCloudLoginFixed, usePlanLoopsChanged } from "./paused-notice";
import type { automationRpcContract } from "./src/rpc.js";
import type { AutomationAgentSummary } from "./src/rpc-types.js";

// Cloud loops (ADR 0212) run on Cloudroom's servers and re-prompt a Cloud thread, even while this Mac is off.
// Agents create them with `room-cli loop create --cloud`; the Overview shows, pauses, runs, and deletes them.
export type CloudAutomation = {
  id: string;
  thread_id: string;
  name: string;
  cron: string | null;
  timezone: string;
  run_at: string | null;
  enabled: boolean;
  next_run_at: string | null;
  last_run_at: string | null;
  last_error: string | null;
  runs: number;
  prompt?: string;
  new_thread?: boolean;
  /** Runs first; a Jev loop's prints its items. */
  script?: string | null;
  /** A Jev loop's action script (docs/scopes/loops.md, Jev loops): its `prompt` is Jev's questions and it runs no agent. */
  jev_action?: string | null;
  agent?: AutomationAgentSummary | null;
  /** Two or more agents that take turns, in order; `agent` is the first. */
  agents?: AutomationAgentSummary[];
  project_id?: string | null;
  /** P1-P4; missing until the website's 0094 update. */
  priority?: number;
  /** API keys and `.env` its runs get (ADR 0342); null for all. Missing until the website's 0103 update. */
  secrets?: string[] | null;
};
export type CloudAutomationChanges = {
  prompt?: string;
  cron?: string;
  harness?: string;
  model?: string;
  reasoning?: string;
  /** Two or more agents that take turns, one per run. */
  agents?: { harness: string; model: string; reasoning?: string }[];
  secrets?: string[];
  /** With `prompt` (Jev's questions) and `jev_action`, saved together for a Jev loop. */
  script?: string;
  jev_action?: string;
};
export type CloudAutomationActions = {
  onOpen: (a: CloudAutomation) => void;
  onRun: (a: CloudAutomation) => void;
  onNewUrl: (a: CloudAutomation) => void;
  onDelete: (a: CloudAutomation) => void;
  onEnabledChange: (a: CloudAutomation, enabled: boolean) => void;
  onSave: (a: CloudAutomation, changes: CloudAutomationChanges) => Promise<boolean>;
  /** Rejects when the priority couldn't be saved. */
  onPriorityChange: (a: CloudAutomation, priority: number) => Promise<void>;
};
type Request =
  | { action: "list" }
  | { action: "settings"; stop_at_limit?: boolean }
  | ({ action: "update"; id: string; enabled?: boolean; priority?: number } & CloudAutomationChanges)
  | { action: "run" | "delete" | "hook"; id: string };

/** Asks, then replaces a webhook loop's secret URL and copies the new one. The website keeps only its hash, so this
 *  is the only time it shows. */
export async function replaceWebhookUrl(
  replace: () => Promise<string | undefined>,
): Promise<void> {
  if (
    !window.confirm(
      "Make a new webhook URL? The old one stops working at once.",
    )
  )
    return;
  try {
    const url = await replace();
    if (!url) throw new Error("No URL came back.");
    await navigator.clipboard.writeText(url).then(
      () =>
        toast.success("New webhook URL copied", {
          description:
            "Paste it into the sending service. It isn't shown again.",
        }),
      () =>
        toast.success("New webhook URL", {
          description: url,
          duration: Infinity,
        }),
    );
  } catch (error: unknown) {
    toast.error(error instanceof Error ? error.message : String(error));
  }
}

/** Run now puts the user in the run (2026-11-18): asks every 2 s, for up to 3 minutes (a Cloud sandbox can take a
 *  minute to start), for the thread the run started, and opens it once it shows. `find` gives null to keep asking and
 *  false when the run ended with no thread (a quiet script check). A newer Run now, or `stopRunThread` when the page
 *  closes, stops it, so it never pulls the user out of a thread they moved to. */
let polling: AbortController | null = null;
export async function openRunThread(
  find: () => Promise<string | null | false>,
  open: (threadId: string) => void,
): Promise<void> {
  polling?.abort();
  const { signal } = (polling = new AbortController());
  for (const end = Date.now() + 180_000; Date.now() < end; ) {
    const thread = await find().catch(() => null);
    if (signal.aborted || thread === false) return;
    if (thread) return open(thread);
    await new Promise((resolve) => setTimeout(resolve, 2_000));
    if (signal.aborted) return;
  }
}
export function stopRunThread(): void {
  polling?.abort();
  polling = null;
}

const BILLING_URL = /(?: at)?\s*(?:https?:\/\/)?(?:www\.)?cloudroom\.dev\/billing\b/gi;

/** Shows a toast error, turning any website billing URL into a one-click Upgrade action button. */
export function showLoopError(message: string, onUpgrade: () => void): void {
  if (!BILLING_URL.test(message)) {
    toast.error(message);
    return;
  }
  BILLING_URL.lastIndex = 0;
  const clean = message.replace(BILLING_URL, "").replace(/\s+([.,;:])/g, "$1").trim();
  toast.error(clean, { action: { label: "Upgrade", onClick: onUpgrade } });
}

const lastLoaded: {
  rows: CloudAutomation[] | null;
  stopAtLimit: boolean | null;
} = { rows: null, stopAtLimit: null };

export function useCloudAutomations(): {
  rows: CloudAutomation[];
  loaded: boolean;
  actions: CloudAutomationActions;
  reload: () => Promise<void>;
} {
  const rpc = useRpc<typeof automationRpcContract>();
  const sdk = useSdk();
  const navigate = useBbNavigate();
  const [rows, setRows] = useState(() => lastLoaded.rows ?? []);
  // True once the last list request succeeded, so an empty list means no Cloud loops.
  const [loaded, setLoaded] = useState(() => lastLoaded.rows !== null);
  const call = useCallback(
    (request: Request) => rpc.call("cloud_automations", request),
    [rpc],
  );
  const load = useCallback(
    () =>
      call({ action: "list" }).then(
        (value) => {
          lastLoaded.rows =
            (value as { automations?: CloudAutomation[] }).automations ?? [];
          setRows(lastLoaded.rows);
          setLoaded(true);
        },
        () => {
          lastLoaded.rows = null;
          setRows([]);
          setLoaded(false);
        },
      ),
    [call],
  );
  useEffect(() => {
    void load();
  }, [load]);
  useCloudLoginFixed(() => void load());
  useEffect(() => stopRunThread, []);
  usePlanLoopsChanged(() => void load());
  const onUpgrade = useCallback(
    () => navigate.openUrl("https://www.cloudroom.dev/billing"),
    [navigate],
  );
  const act = useCallback(
    async (request: Request, done: string, then?: (value: unknown) => void) => {
      try {
        const value = await call(request);
        if (request.action !== "run") loopsChanged();
        toast.success(done);
        then?.(value);
      } catch (error: unknown) {
        showLoopError(error instanceof Error ? error.message : String(error), onUpgrade);
      }
      await load();
    },
    [call, load, onUpgrade],
  );
  const actions = useMemo<CloudAutomationActions>(
    () => ({
      // A project loop (no thread hosts it) opens its project.
      onOpen: (a) => a.thread_id.startsWith("proj_") ? navigate.toProject(a.thread_id) : navigate.toThread(a.thread_id),
      onRun: (a) =>
        void act({ action: "run", id: a.id }, "Starting now", (value) => {
          // The thread the run prompts; missing from websites before 2026-11-18.
          const thread = (value as { thread?: unknown }).thread;
          if (typeof thread !== "string") return;
          void openRunThread(
            () => sdk.threads.get({ threadId: thread }).then(() => thread),
            navigate.toThread,
          );
        }),
      onNewUrl: (a) =>
        void replaceWebhookUrl(
          async () =>
            ((await call({ action: "hook", id: a.id })) as { url?: string })
              .url,
        ),
      onDelete: (a) => {
        if (window.confirm(`Delete "${a.name}"?`))
          void act({ action: "delete", id: a.id }, "Deleted");
      },
      onEnabledChange: (a, enabled) =>
        void act(
          { action: "update", id: a.id, enabled },
          enabled ? "Resumed" : "Turned off",
        ),
      onPriorityChange: async (a, priority) => {
        try {
          await call({ action: "update", id: a.id, priority });
        } catch (error: unknown) {
          showLoopError(error instanceof Error ? error.message : String(error), onUpgrade);
          throw error;
        }
        await load();
      },
      onSave: async (a, changes) => {
        try {
          await call({ action: "update", id: a.id, ...changes });
          toast.success("Saved");
          await load();
          return true;
        } catch (error: unknown) {
          showLoopError(error instanceof Error ? error.message : String(error), onUpgrade);
          return false;
        }
      },
    }),
    [act, call, load, navigate, onUpgrade, sdk],
  );
  return { rows, loaded, actions, reload: load };
}

export type LimitSetting = { stop_at_limit: boolean };

export function LoopLimitSwitch() {
  const rpc = useRpc<typeof automationRpcContract>();
  const [stop, setStop] = useState(lastLoaded.stopAtLimit);
  const [saving, setSaving] = useState(false);
  const changedRef = useRef(false);
  useEffect(() => {
    const request: Request = { action: "settings" };
    rpc.call("cloud_automations", request).then(
      (value) => {
        if (changedRef.current) return;
        lastLoaded.stopAtLimit = (value as LimitSetting).stop_at_limit;
        setStop(lastLoaded.stopAtLimit);
      },
      () => {
        if (changedRef.current) return;
        lastLoaded.stopAtLimit = null;
        setStop(null);
      },
    );
  }, [rpc]);
  const change = useCallback(
    async (next: boolean) => {
      if (saving) return;
      changedRef.current = true;
      const previous = stop;
      setSaving(true);
      setStop(next);
      const request: Request = { action: "settings", stop_at_limit: next };
      try {
        const saved = (await rpc.call(
          "cloud_automations",
          request,
        )) as LimitSetting;
        lastLoaded.stopAtLimit = saved.stop_at_limit;
        setStop(saved.stop_at_limit);
      } catch (error: unknown) {
        setStop(previous);
        toast.error(error instanceof Error ? error.message : String(error));
      } finally {
        setSaving(false);
      }
    },
    [rpc, saving, stop],
  );
  if (stop === null) return null;
  return <LoopLimitSwitchView checked={stop} onChange={change} />;
}

export function LoopLimitSwitchView({
  checked,
  onChange,
}: {
  checked: boolean;
  onChange: (checked: boolean) => void;
}) {
  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <Button
          type="button"
          variant="ghost"
          size="sm"
          aria-label="Loop settings"
          className="h-8 w-8 px-0"
        >
          <Icon name="Settings" className="size-3.5" aria-hidden />
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end" className="w-56">
        <DropdownMenuItem
          role="menuitemcheckbox"
          aria-checked={checked}
          title="Cloud loops wait for the reset instead of spending extra credits."
          className="cursor-pointer justify-between gap-3"
          onSelect={(event) => {
            event.preventDefault();
            onChange(!checked);
          }}
        >
          Stop at plan limit
          <Switch
            checked={checked}
            tabIndex={-1}
            aria-hidden
            className="pointer-events-none"
          />
        </DropdownMenuItem>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
