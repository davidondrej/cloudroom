import { useEffect, useState } from "react";
import {
  experimental_ProviderIcon as ProviderIcon,
  experimental_useProviders as useProviders,
  useBbNavigate,
  useRpc,
} from "@get-bb/plugin-sdk/app";
import { Button } from "@cloudroom/shared-ui/button";
import { Icon } from "@cloudroom/shared-ui/icon";
import { cn } from "@cloudroom/shared-ui/lib/utils";
import { toast } from "sonner";
import type { automationRpcContract } from "./src/rpc.js";
import type { AgentSessions } from "./src/agent-sessions.js";

type Agent = AgentSessions["agents"][number];

const COLORS: Record<string, string> = {
  "claude-code": "#D97757",
  codex: "#8FA8FF",
  pi: "#C792EA",
  "acp-opencode": "currentColor",
  "acp-hermes-agent": "#F2C94C",
};
const card = "rounded-xl border border-border bg-surface-raised";
const fmt = (n: number) => n.toLocaleString("en-US");

export function ScansTabLabel() {
  return (
    <span className="inline-flex items-center gap-1.5">
      Scans
      <span className="inline-flex h-4 items-center rounded-full border border-primary/50 bg-primary/10 px-2 text-[9px] leading-none font-bold tracking-wider text-primary uppercase">
        New
      </span>
    </span>
  );
}

export function ScansView() {
  const rpc = useRpc<typeof automationRpcContract>();
  const navigate = useBbNavigate();
  const [agents, setAgents] = useState<Agent[] | null>(null);
  const [plan, setPlan] = useState<string | null | undefined>(undefined);
  const [starting, setStarting] = useState(false);
  useEffect(() => {
    let cancelled = false;
    rpc.call("scans_agent_sessions", null).then(
      (result) => !cancelled && setAgents(result.agents),
      () => !cancelled && setAgents([]),
    );
    rpc.call("account_plan", null).then(
      (result) => !cancelled && setPlan(result.plan),
      () => !cancelled && setPlan(null),
    );
    return () => {
      cancelled = true;
    };
  }, [rpc]);
  const free = plan === "free";
  const start = () => {
    if (free) return navigate.openUrl("https://www.cloudroom.dev/billing");
    setStarting(true);
    rpc.call("scans_start", null).then(
      ({ threadId }) => navigate.toThread(threadId),
      (error: unknown) => {
        setStarting(false);
        toast.error(
          error instanceof Error ? error.message : "The scan could not start.",
        );
      },
    );
  };
  const [first, second, ...rest] = agents ?? [];
  return (
    <div className="mx-auto w-full max-w-3xl pb-10">
      <div className="mb-6 flex items-end justify-between gap-6">
        <h2 className="text-[30px] leading-tight font-semibold tracking-tight text-foreground">
          See how you
          <br />
          actually work.
        </h2>
        <div className="flex shrink-0 items-center gap-3">
          <span className="inline-flex h-10 items-center gap-2 rounded-md border border-dashed border-border px-3.5 text-sm text-muted-foreground">
            <Icon name="SecurityCheck" className="size-4" aria-hidden />
            Cyber scan
            <span className="rounded-[4px] bg-primary/15 px-1.5 py-px text-[10px] font-bold tracking-wide text-primary uppercase">
              Soon
            </span>
          </span>
          <Button
            type="button"
            size="lg"
            className="h-10 gap-2 px-5 font-semibold"
            disabled={starting || plan === undefined || !agents?.length}
            onClick={start}
          >
            <Icon name="Play" className="size-4" aria-hidden />
            {free
              ? "Upgrade to scan"
              : starting
                ? "Starting…"
                : "Scan my workflow"}
          </Button>
        </div>
      </div>
      {agents === null ? (
        <div className="grid grid-cols-2 gap-3">
          {[0, 1].map((key) => (
            <div key={key} className={cn(card, "h-64 animate-pulse")} />
          ))}
        </div>
      ) : agents.length === 0 ? (
        <div
          className={cn(card, "p-8 text-center text-sm text-muted-foreground")}
        >
          No agent sessions found on this computer yet.
        </div>
      ) : (
        <>
          <div
            className={cn("grid gap-3", second ? "grid-cols-2" : "grid-cols-1")}
          >
            {[first, second].filter(Boolean).map((agent) => (
              <BigCard key={agent.id} agent={agent} />
            ))}
          </div>
          {rest.length > 0 ? (
            <div className="mt-3 grid grid-cols-3 gap-3">
              {rest.map((agent) => (
                <SmallCard key={agent.id} agent={agent} />
              ))}
            </div>
          ) : null}
        </>
      )}
    </div>
  );
}

function Logo({ agent, className }: { agent: Agent; className?: string }) {
  const { providers } = useProviders();
  return (
    <ProviderIcon
      providerKind="agent"
      provider={
        providers.find((provider) => provider.id === agent.id) ?? {
          id: agent.id,
        }
      }
      fallback="Bot"
      className={cn("size-4", className)}
      aria-hidden
    />
  );
}

function BigCard({ agent }: { agent: Agent }) {
  return (
    <div className={cn(card, "p-5")}>
      <div className="flex items-center gap-2">
        <Logo agent={agent} className="size-5" />
        <span className="font-semibold text-foreground">{agent.name}</span>
      </div>
      <p className="mt-4 text-4xl font-semibold tracking-tight text-foreground tabular-nums">
        {fmt(agent.sessions)}
      </p>
      <p className="text-xs text-muted-foreground">sessions</p>
      <div className="mt-5">
        <Heatmap agent={agent} cell={14} />
      </div>
    </div>
  );
}

function SmallCard({ agent }: { agent: Agent }) {
  return (
    <div className={cn(card, "p-4")}>
      <div className="flex items-center gap-2">
        <Logo agent={agent} />
        <span className="truncate text-sm font-semibold text-foreground">
          {agent.name}
        </span>
        <span className="ml-auto text-lg font-semibold text-foreground tabular-nums">
          {fmt(agent.sessions)}
        </span>
      </div>
      <div className="mt-3">
        <Heatmap agent={agent} cell={9} />
      </div>
    </div>
  );
}

function Heatmap({ agent, cell }: { agent: Agent; cell: number }) {
  const max = Math.max(...agent.days, 1);
  const color = COLORS[agent.id] ?? "#A1A1AA";
  return (
    <div
      className="flex gap-[3px] text-foreground"
      aria-label={`${agent.name} sessions per day, last 13 weeks`}
    >
      {Array.from({ length: Math.ceil(agent.days.length / 7) }, (_, week) => (
        <div key={week} className="flex flex-col gap-[3px]">
          {agent.days.slice(week * 7, week * 7 + 7).map((count, day) => (
            <span
              key={day}
              className="rounded-[2px]"
              style={{
                width: cell,
                height: cell,
                background:
                  count === 0
                    ? "color-mix(in srgb, currentColor 7%, transparent)"
                    : color,
                opacity: count === 0 ? 1 : 0.25 + 0.75 * Math.sqrt(count / max),
              }}
            />
          ))}
        </div>
      ))}
    </div>
  );
}
