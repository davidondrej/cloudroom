import { useEffect, useState } from "react";
import { useBbNavigate, useRpc } from "@get-bb/plugin-sdk/app";
import { Icon } from "@cloudroom/shared-ui/icon";
import { useCorner } from "@cloudroom/shared-ui/lib/corner";
import { cn } from "@cloudroom/shared-ui/lib/utils";
import type { automationRpcContract } from "./src/rpc.js";
import { COLORS, type Agent } from "./scans-view";

// The Scan card at the top right (docs/scopes/corner-cards.md, feedback 0023): it makes the Workflow scan easy to
// find. Same size and place as the Wrapped card. It wants to show when no scan started on this computer in the
// last 45 days; the corner module decides whether it may. A click opens the Scans tab, which asks a free plan to
// upgrade.
/** Two designs, one picked at random each time the app starts. Our stats show which one gets more clicks. */
const DESIGN = Math.random() < 0.5 ? "night" : "paper";
/** The card asks only once the app has settled, like the Wrapped card. */
const WAIT_MS = 30_000;
const color = (agent: Agent) => COLORS[agent.id] ?? "#A1A1AA";

/** Night: the Scans page's own heatmap, your top agent's last 9 weeks, tilted off the corner. */
function Heatmap({ agent }: { agent: Agent }) {
  const days = agent.days.slice(-63), max = Math.max(...agent.days, 1);
  return (
    <span className="absolute -right-[30px] -bottom-[22px] flex origin-bottom-right -rotate-[14deg] gap-[3px]">
      {Array.from({ length: Math.ceil(days.length / 7) }, (_, week) => (
        <span key={week} className="flex flex-col gap-[3px]">
          {days.slice(week * 7, week * 7 + 7).map((count, day) => (
            <span key={day} className="size-[15px] rounded-[2.5px]"
              style={count === 0 ? { background: "color-mix(in srgb, currentColor 7%, transparent)" } : { background: color(agent), opacity: 0.25 + 0.75 * Math.sqrt(count / max) }} />
          ))}
        </span>
      ))}
    </span>
  );
}

/** Paper: one bar per agent in its Scans color. A taller bar means more sessions. */
function Bars({ agents }: { agents: Agent[] }) {
  const shown = agents.slice(0, 5), peak = Math.sqrt(Math.max(shown[0]?.sessions ?? 1, 1));
  return (
    <span className="absolute right-4 bottom-4 flex items-end gap-[3px]">
      {[...shown].reverse().map((agent) => {
        const cells = Math.max(1, Math.round(7 * Math.sqrt(agent.sessions) / peak)) * 2;
        const recent = agent.days.slice(-cells), max = Math.max(...recent, 1);
        return (
          <span key={agent.id} className="grid grid-cols-2 gap-[3px]">
            {Array.from({ length: cells }, (_, index) => (
              <span key={index} className="size-[11px] rounded-[2px]" style={{ background: color(agent), opacity: 0.45 + 0.55 * Math.sqrt((recent[index] ?? 0) / max) }} />
            ))}
          </span>
        );
      })}
    </span>
  );
}

export function ScanCard() {
  const rpc = useRpc<typeof automationRpcContract>();
  const navigate = useBbNavigate();
  const [wanted, setWanted] = useState(false);
  const [agents, setAgents] = useState<Agent[] | null>(null);
  useEffect(() => {
    const timer = setTimeout(() => void rpc.call("scans_card", null).then(({ show }) => setWanted(show), () => {}), WAIT_MS);
    return () => clearTimeout(timer);
  }, [rpc]);
  const corner = useCorner("scan", wanted ? "" : null, DESIGN);
  const granted = corner !== null;
  // The sessions are counted only once the card may show: counting reads thousands of file names.
  useEffect(() => {
    if (granted && agents === null) void rpc.call("scans_agent_sessions", null).then((result) => setAgents(result.agents), () => {});
  }, [agents, granted, rpc]);
  const top = agents?.[0];
  if (!corner || !agents || !top) return null;
  const night = DESIGN === "night";
  const done = (answer: "opened" | "closed") => { corner.answer(answer); setWanted(false); };
  return (
    <div data-testid="scan-card" style={corner.style}
      className={cn(corner.className, "h-[176px] w-[340px] overflow-hidden rounded-[10px] shadow-[0_18px_50px_rgba(0,0,0,.65),0_2px_8px_rgba(0,0,0,.5)]",
        night ? "bg-[#0c0c0c] text-[#F5F0E1] ring-1 ring-[#F5F0E1]/15 ring-inset" : "bg-[#F5F0E1] text-[#0a0a0a]")}>
      <button type="button" onClick={() => { done("opened"); navigate.toPluginPanel("automations", { subPath: "scans" }); }}
        className="absolute inset-0 flex cursor-pointer flex-col px-4 pt-[26px] text-left outline-none focus-visible:ring-2 focus-visible:ring-current focus-visible:ring-inset">
        <span aria-hidden="true" className="pointer-events-none absolute inset-0">
          {night ? <Heatmap agent={top} /> : <Bars agents={agents} />}
        </span>
        <span className="relative block font-mono text-[10px] tracking-[0.16em] uppercase" style={night ? { color: color(top) } : undefined}>Workflow · Scan</span>
        <span className="relative mt-2 block text-[27px] leading-[1.05] font-extrabold tracking-[-0.045em]">
          {night ? <>See how you<br />actually work.</> : <>Find your<br />next loop.</>}
        </span>
        <span className={cn("absolute bottom-4 left-4 flex h-8 items-center gap-[7px] rounded-[7px] px-3.5 text-[13px] font-semibold", night ? "bg-[#BFFF00] text-[#0a0a0a]" : "bg-[#0a0a0a] text-[#F5F0E1]")}>
          Scan my workflow<Icon name="ArrowRight" className="size-3.5" aria-hidden="true" />
        </span>
      </button>
      <button type="button" aria-label="Dismiss" onClick={() => done("closed")}
        className="absolute top-[22px] right-3 flex size-6 cursor-pointer items-center justify-center rounded hover:bg-current/10">
        <Icon name="X" className="size-3.5" aria-hidden="true" />
      </button>
    </div>
  );
}
