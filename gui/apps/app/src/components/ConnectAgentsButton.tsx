import { useEffect, useRef, useState } from "react";
import { useQueryClient } from "@tanstack/react-query";
import type { ProviderInfo } from "@cloudroom/domain";
import { Button } from "@cloudroom/shared-ui/button";
import { Icon } from "@cloudroom/shared-ui/icon";
import { Popover, PopoverContent, PopoverTrigger } from "@cloudroom/shared-ui/popover";
import { ClaudeConnectionPanel, useClaudeConnection, useRefreshOnClaudeConnect, type ClaudeConnectionTarget } from "@/components/ClaudeConnection";
import { openCodexConnection, openCursorConnection, useCloudLogin } from "@/components/CodexConnectionPanel";
import { restartProviderModels } from "@/components/pickers/ModelUnavailable";
import { useProviderLogin } from "@/components/settings/ProviderLoginButton";
import { cloudCanRunHarness } from "@/hooks/queries/cloudroom-queries";
import { useEnvironment } from "@/hooks/queries/environment-queries";
import { useSystemProviders, useSystemProviderStates } from "@/hooks/queries/system-queries";
import { getLocalStorage } from "@/lib/browser-storage";
import { getProviderIconInfo, getProviderIconTintStyle } from "@/lib/provider-icon";

const HIDDEN_KEY = "cloudroom.connectAgents.hidden";
export const CONNECT_AGENT_IDS = ["claude-code", "codex", "acp-cursor"];
const NAMES: Record<string, string> = { "claude-code": "Claude Code", codex: "Codex", "acp-cursor": "Cursor" };
type Agent = { id: string; connected: boolean; provider: ProviderInfo | undefined };

/** The quiet "Connect agents" button under the new-thread prompt box. It shows only while the picked agent
 *  isn't connected on the selected Local/Cloud target, until the user hides it on this device. */
export function ConnectAgentsButton({
  target,
  hostId,
  environmentId,
  primaryHostId,
  providerIds,
  selectedProviderId,
}: ClaudeConnectionTarget & { primaryHostId: string | null; providerIds: string[]; selectedProviderId: string }) {
  const client = useQueryClient();
  const [hidden, setHidden] = useState(() => getLocalStorage()?.getItem(HIDDEN_KEY) === "1");
  const cloud = target === "cloud";
  const ids = CONNECT_AGENT_IDS.filter((id) => providerIds.includes(id) && (!cloud || cloudCanRunHarness(id)));
  const active = !hidden && ids.includes(selectedProviderId);
  const claudeTarget = { target, hostId, environmentId };
  const claude = useClaudeConnection(claudeTarget, active && ids.includes("claude-code"));
  const codex = useCloudLogin("codex", active && cloud && ids.includes("codex"));
  const cursor = useCloudLogin("cursor", active && cloud && ids.includes("acp-cursor"));
  const local = useSystemProviderStates({ hostId: hostId ?? undefined, environmentId: environmentId ?? undefined, enabled: active && !cloud, poll: false });
  // Local logins run on the machine the status came from: a reused environment's own host, not the primary one.
  const environment = useEnvironment(environmentId, { enabled: active && !cloud });
  const login = useProviderLogin(environmentId ? (environment.data?.hostId ?? null) : (hostId ?? primaryHostId), () => void local.refetch());
  const providers = useSystemProviders({ enabled: active }).data;
  const claudeConnected = useRefreshOnClaudeConnect(claude.data?.state === "connected");

  // true = connected, false = can connect, null = unknown (left out). A failed check counts as not connected,
  // so the row still opens a sign-in with its own "Check again".
  const status = (id: string): boolean | null => {
    if (id === "claude-code") return claude.data ? claudeConnected : claude.isError ? false : null;
    if (cloud) {
      const query = id === "codex" ? codex : cursor;
      const state = query.data?.state;
      return state === undefined ? (query.isError ? false : null) : state === "connected" || state === "limited";
    }
    const state = local.data?.providers.find((provider) => provider.providerId === id);
    if (state?.status === "ready") return true;
    return (state?.status === "unauthenticated" || state?.status === "expired") && state.loginCommand ? false : null;
  };
  const agents: Agent[] = ids.flatMap((id) => {
    const connected = status(id);
    return connected === null ? [] : [{ id, connected, provider: providers?.find((provider) => provider.id === id) }];
  });

  // Once Codex or Cursor connects, reload its models so the prompt box can send. Claude does this itself.
  const missing = useRef(new Set<string>());
  useEffect(() => {
    for (const { id, connected } of agents) {
      if (id === "claude-code") continue;
      if (!connected) missing.current.add(id);
      else if (missing.current.delete(id)) {
        if (cloud) void client.invalidateQueries({ queryKey: ["systemExecutionOptions"] });
        else void restartProviderModels(client, id, environmentId ? { environmentId } : hostId ? { hostId } : {}).catch(() => {});
      }
    }
  });

  const visible = active && agents.find((agent) => agent.id === selectedProviderId)?.connected === false;
  const connect = (id: string) => {
    if (cloud) return id === "codex" ? openCodexConnection() : openCursorConnection();
    const state = local.data?.providers.find((provider) => provider.providerId === id);
    if (state?.loginCommand) login.start(state.loginCommand, state.displayName);
  };
  const hide = () => {
    getLocalStorage()?.setItem(HIDDEN_KEY, "1");
    setHidden(true);
  };
  return (
    <>
      {/* The menu only exists while visible, so its open state resets whenever the button hides. */}
      {visible && <AgentsMenu agents={agents} claudeTarget={claudeTarget} onConnect={connect} onHide={hide} />}
      {login.drawer}
    </>
  );
}

function AgentsMenu({ agents, claudeTarget, onConnect, onHide }: {
  agents: Agent[];
  claudeTarget: ClaudeConnectionTarget;
  onConnect: (id: string) => void;
  onHide: () => void;
}) {
  const [open, setOpen] = useState(false);
  const [claudeOpen, setClaudeOpen] = useState(false);
  const close = () => { setOpen(false); setClaudeOpen(false); };
  const choose = (id: string) => {
    if (id === "claude-code") return setClaudeOpen(true);
    close();
    onConnect(id);
  };
  // Claude sits in the middle of the closed button so it stands out.
  const others = agents.filter((agent) => agent.id !== "claude-code");
  const claude = agents.find((agent) => agent.id === "claude-code");
  const stack = claude ? [...others.slice(0, 1), claude, ...others.slice(1)] : others;
  const showClaude = claudeOpen && claude?.connected === false;

  return (
    <Popover open={open} onOpenChange={(next) => (next ? setOpen(true) : close())}>
      <PopoverTrigger asChild>
        <Button type="button" variant="ghost" size="sm" className="h-7 gap-2 text-xs text-muted-foreground hover:text-foreground">
          <span className="flex items-center gap-2" aria-hidden>
            {stack.map((agent) => (
              <span key={agent.id} className="relative flex">
                <AgentLogo id={agent.id} provider={agent.provider} big={agent.id === "claude-code"} />
                {agent.connected && <span className="absolute -right-0.5 -bottom-0.5 size-1.5 rounded-full bg-primary" />}
              </span>
            ))}
          </span>
          Connect agents
        </Button>
      </PopoverTrigger>
      <PopoverContent side="top" align="center" sideOffset={6} mobileTitle="Connect agents" className={showClaude ? "w-72 p-3" : "w-56 p-1"}>
        {showClaude ? (
          <ClaudeConnectionPanel target={claudeTarget} onClose={close} />
        ) : (
          <div className="text-sm">
            {agents.map((agent) => agent.connected ? (
              <div key={agent.id} className="flex h-9 items-center gap-2.5 px-2 text-muted-foreground">
                <AgentLogo id={agent.id} provider={agent.provider} />
                <span className="flex-1">{NAMES[agent.id]}</span>
                <Icon name="Check" aria-label="Connected" className="size-4 text-primary" />
              </div>
            ) : (
              <button key={agent.id} type="button" onClick={() => choose(agent.id)} className="group flex h-9 w-full items-center gap-2.5 rounded-md px-2 text-left hover:bg-state-hover">
                <AgentLogo id={agent.id} provider={agent.provider} />
                <span className="flex-1">{NAMES[agent.id]}</span>
                <Icon name="ArrowRight" aria-label={`Connect ${NAMES[agent.id]}`} className="size-4 text-muted-foreground group-hover:text-primary" />
              </button>
            ))}
            <div className="mx-1 my-1 h-px bg-border" />
            <button type="button" onClick={onHide} className="flex h-8 w-full items-center gap-2.5 rounded-md px-2 text-xs text-muted-foreground hover:bg-state-hover">
              <Icon name="EyeOff" aria-hidden className="size-4" />
              Hide
            </button>
          </div>
        )}
      </PopoverContent>
    </Popover>
  );
}

function AgentLogo({ id, provider, big = false }: { id: string; provider: ProviderInfo | undefined; big?: boolean }) {
  const Logo = getProviderIconInfo("agent", id, provider ?? null).icon;
  return (
    <span className="flex" style={id === "claude-code" ? getProviderIconTintStyle(provider) : undefined}>
      <Logo className={big ? "size-[15px]" : "size-3.5"} />
    </span>
  );
}
