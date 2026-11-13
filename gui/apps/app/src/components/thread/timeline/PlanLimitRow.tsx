import {
  useEffect,
  useState,
  type ComponentType,
  type CSSProperties,
  type ReactNode,
} from "react";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import type { TimelineNonOperationSystemRow } from "@cloudroom/server-contract";
import { Button } from "@cloudroom/shared-ui/button";
import { Icon } from "@cloudroom/shared-ui/icon";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@cloudroom/shared-ui/dropdown-menu";
import { cn } from "@cloudroom/shared-ui/lib/utils";
import { formatUsageReset } from "@cloudroom/shared-ui/lib/usage-format";
import { useUpdateThread } from "@/hooks/mutations/thread-state-mutations";
import { useSystemProviders } from "@/hooks/queries/system-queries";
import {
  getProviderIconInfo,
  getProviderIconTintStyle,
} from "@/lib/provider-icon";
import { usePlanLimitAgents, type PlanLimitAgent } from "./plan-limit-agents";
import {
  atLimit,
  nextAccount,
  switchAccount,
  usePlanLimitAccounts,
} from "./plan-limit-accounts";

type Logo = {
  icon: ComponentType<{ className?: string }>;
  tint: CSSProperties | undefined;
};
type Agent = Logo & { name: string };
type PlanLimitSwitch = NonNullable<
  TimelineNonOperationSystemRow["planLimitSwitch"]
>;
type PlanLimitAccountSwitch = NonNullable<
  TimelineNonOperationSystemRow["planLimitAccountSwitch"]
>;

/** A switch whose new agent never got going (say its message is still queued) stops showing as in progress. */
const SWITCH_STALE_MS = 3 * 60_000;

/** A plan limit stopped the last turn: switch to another account of the same agent, or continue on another agent (ADR 0211 switch, then resend). */
export function PlanLimitRow({
  threadId,
  switched,
  className,
}: {
  threadId: string;
  /** The thread already moved to another agent with resend: the card shows it picking up. */
  switched?: PlanLimitSwitch | undefined;
  className?: string;
}) {
  const { thread, model, self, selfResetsAt, agents, primary } =
    usePlanLimitAgents(threadId);
  const accounts = usePlanLimitAccounts(thread?.providerId ?? "");
  const queryClient = useQueryClient();
  const [busy, setBusy] = useState<string | null>(null);
  // Kept from the click: the thread moves to `to` midway, and `from` is the agent that hit the limit.
  const [switching, setSwitching] = useState<{
    from: Agent | null;
    to: PlanLimitAgent;
    startedAt: number;
  } | null>(null);
  const agentOf = useAgentOf();
  const now = useNow(switching !== null || switched !== undefined);
  const status = thread?.status;
  const update = useUpdateThread({
    threadId,
    errorMessage: "Couldn't continue with the other agent.",
  });
  const accountSwitch = useMutation({
    meta: { errorMessage: "Couldn't switch accounts." },
    mutationFn: switchAccount,
    onError: () => setBusy(null),
  });
  const pending = accountSwitch.isPending;
  useEffect(() => {
    if (busy === null || pending) return;
    const timer = setTimeout(() => setBusy(null), 60_000);
    return () => clearTimeout(timer);
  }, [busy, pending]);
  if (!thread) return null;
  const stopped = status === "idle" || status === "error";
  if (switching || switched) {
    if (switched && stopped && now - switched.at > SWITCH_STALE_MS) {
      return <PlanLimitSwitchedRow switched={switched} className={className} />;
    }
    const to = switching?.to ?? agentOf(switched!.to);
    const landed =
      switched !== undefined || thread.providerId === switching?.to.providerId;
    return (
      <SwitchChecklist
        from={switching?.from ?? (switched ? agentOf(switched.from) : null)}
        to={to}
        step={!landed ? 0 : status === "active" ? 2 : 1}
        seconds={Math.max(
          0,
          Math.round((now - (switching?.startedAt ?? switched!.at)) / 1000),
        )}
        className={className}
      />
    );
  }
  if (!stopped) return null;
  const isCloud = thread.executionTarget === "cloud";
  const pickAccount = (accountId: string) => {
    setBusy("Switching account");
    accountSwitch.mutate({
      providerId: thread.providerId,
      accountId,
      threadId,
      isCloud,
    });
  };
  const switchTo = (agent: PlanLimitAgent) => {
    setSwitching({ from: self, to: agent, startedAt: Date.now() });
    update.mutate(
      {
        id: threadId,
        providerId: agent.providerId,
        model: agent.model,
        reasoningLevel: agent.reasoningLevel,
        resend: true,
      },
      {
        onSuccess: () =>
          void queryClient.invalidateQueries({
            queryKey: ["cloudroom-thread", threadId],
          }),
        onError: () => setSwitching(null),
      },
    );
  };
  const name = self?.name ?? thread.providerId;
  const reset = formatUsageReset(selfResetsAt);
  const canSwitch = accounts.others.length > 0;
  const SelfIcon = self?.icon;

  return (
    <div className={cn("flex flex-col gap-3 py-1", className)}>
      <p className="flex items-center gap-2.5 text-base font-semibold text-foreground">
        {SelfIcon ? (
          <SelfIcon className="size-[18px] shrink-0 text-muted-foreground" />
        ) : (
          <Icon
            name="AlertCircle"
            className="size-[18px] shrink-0 text-attention"
            aria-hidden
          />
        )}
        {name} hit its plan limit
      </p>
      {busy ? (
        <div className="pl-7">
          <Button type="button" size="sm" variant="outline" disabled>
            <Icon
              name="Spinner"
              className="size-3.5 animate-spin"
              aria-hidden
            />
            {busy}
          </Button>
        </div>
      ) : canSwitch || primary ? (
        <div className="flex flex-wrap items-center gap-2 pl-7">
          {canSwitch ? (
            <SplitButton
              logo={self}
              label="Switch account"
              onClick={() => {
                const next = nextAccount(accounts.others, model);
                if (next) pickAccount(next.id);
              }}
              menuLabel="Switch to"
              moreLabel="Other accounts"
            >
              {accounts.others.map((account) => (
                <MenuRow
                  key={account.id}
                  logo={self}
                  label={account.label}
                  detail={atLimit(account, model) ? "At limit" : null}
                  onSelect={() => pickAccount(account.id)}
                />
              ))}
              {accounts.inUse ? (
                <>
                  <DropdownMenuSeparator />
                  <MenuRow logo={self} label={accounts.inUse.label} checked />
                </>
              ) : null}
            </SplitButton>
          ) : null}
          {primary ? (
            <SplitButton
              logo={primary}
              label={`Continue with ${primary.name}`}
              onClick={() => switchTo(primary)}
              menuLabel="Continue with"
              moreLabel="Other agents"
            >
              {agents.map((agent) => (
                <MenuRow
                  key={agent.providerId}
                  logo={agent}
                  label={agent.name}
                  detail={
                    agent.resetsAt === null
                      ? agent.modelLabel
                      : (formatUsageReset(agent.resetsAt) ?? "At its limit")
                  }
                  disabled={agent.resetsAt !== null}
                  onSelect={() => switchTo(agent)}
                />
              ))}
              {self ? (
                <>
                  <DropdownMenuSeparator />
                  <MenuRow
                    logo={self}
                    label={name}
                    detail={reset ?? "At its limit"}
                    disabled
                  />
                </>
              ) : null}
            </SplitButton>
          ) : null}
        </div>
      ) : reset ? (
        <p className="-mt-1.5 pl-7 text-sm text-muted-foreground">{reset}.</p>
      ) : null}
    </div>
  );
}

/** Each step is a real signal: the switch request (new agent starting), the thread on the new agent (hidden "continue"
 *  with the conversation on its way), then its turn running. The card goes once the new agent shows output. */
function SwitchChecklist({
  from,
  to,
  step,
  seconds,
  className,
}: {
  from: Agent | null;
  to: Agent;
  step: number;
  seconds: number;
  className?: string | undefined;
}) {
  const steps = [
    `Starting ${to.name}`,
    "Sharing the conversation",
    `${to.name} picks up the task`,
  ];
  return (
    <div className={cn("flex flex-col gap-2.5 py-1", className)}>
      <p className="flex items-center gap-2.5 text-base font-semibold text-foreground">
        <LogoIcon logo={to} className="size-[18px]" />
        Switching to {to.name}
        <span className="text-sm font-normal tabular-nums text-muted-foreground">
          {seconds} s
        </span>
      </p>
      <ul className="flex flex-col gap-2 pl-7 text-sm">
        <SwitchStep state="done">
          {from?.name ?? "The last agent"} hit its plan limit
        </SwitchStep>
        {steps.map((label, index) => (
          <SwitchStep
            key={label}
            state={index < step ? "done" : index === step ? "active" : "todo"}
          >
            {label}
          </SwitchStep>
        ))}
      </ul>
    </div>
  );
}

function SwitchStep({
  state,
  children,
}: {
  state: "done" | "active" | "todo";
  children: ReactNode;
}) {
  return (
    <li
      className={cn(
        "flex items-center gap-2.5",
        state === "active" ? "text-foreground" : "text-muted-foreground",
      )}
    >
      {state === "done" ? (
        <Icon name="Check" className="size-3.5 text-success" aria-hidden />
      ) : state === "active" ? (
        <Icon name="Spinner" className="size-3.5 animate-spin" aria-hidden />
      ) : (
        <span className="mx-px size-3 rounded-full border border-muted-foreground/50" />
      )}
      {children}
    </li>
  );
}

/** After a switch, the plan-limit row is one line: who hit the limit and who took over. */
export function PlanLimitSwitchedRow({
  switched,
  className,
}: {
  switched: PlanLimitSwitch;
  className?: string;
}) {
  const agentOf = useAgentOf();
  const from = agentOf(switched.from);
  const to = agentOf(switched.to);
  return (
    <p
      className={cn(
        "flex flex-wrap items-center gap-2 py-1 text-sm text-muted-foreground",
        className,
      )}
    >
      <LogoIcon logo={from} className="size-3.5" />
      {from.name} hit its plan limit
      <Icon name="ArrowRight" className="size-3.5" aria-hidden />
      <LogoIcon logo={to} className="size-3.5" />
      {to.name} took over
    </p>
  );
}

/** After an account switch, the plan-limit row is one quiet line (ADR 20261107-082837). */
export function PlanLimitAccountSwitchedRow({
  switched,
  detail,
  className,
}: {
  switched: PlanLimitAccountSwitch;
  /** The limit error's text, which names the window Claude hit. */
  detail: string | null;
  className?: string;
}) {
  const agent = useAgentOf()(switched.provider);
  return (
    <p
      className={cn(
        "flex flex-wrap items-center gap-2 py-1 text-sm text-muted-foreground",
        className,
      )}
    >
      <LogoIcon logo={agent} className="size-3.5" />
      {switched.from} hit its {limitName(detail)}
      <Icon name="ArrowRight" className="size-3.5" aria-hidden />
      <LogoIcon logo={agent} className="size-3.5" />
      Continued on {switched.to}
    </p>
  );
}

/** Claude names the window it hit ("You've hit your weekly limit"); otherwise it is the plan limit. */
function limitName(detail: string | null): string {
  const named =
    /\b(weekly|session|daily|monthly|5-hour|five-hour) limit\b/i.exec(
      detail ?? "",
    );
  return named ? named[0].toLowerCase() : "plan limit";
}

function useAgentOf(): (providerId: string) => Agent {
  const providers = useSystemProviders().data;
  return (providerId) => {
    const provider = providers?.find((entry) => entry.id === providerId);
    return {
      name: provider?.displayName ?? providerId,
      icon: getProviderIconInfo("agent", providerId, provider ?? null).icon,
      tint: provider ? getProviderIconTintStyle(provider) : undefined,
    };
  };
}

/** The clock, ticking each second only while a switch is in progress. */
function useNow(ticking: boolean): number {
  const [now, setNow] = useState(Date.now);
  useEffect(() => {
    if (!ticking) return;
    setNow(Date.now());
    const timer = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(timer);
  }, [ticking]);
  return now;
}

function LogoIcon({ logo, className }: { logo: Logo; className: string }) {
  const Glyph = logo.icon;
  return (
    <span className="inline-flex shrink-0" style={logo.tint}>
      <Glyph className={className} />
    </span>
  );
}

function SplitButton({
  logo,
  label,
  onClick,
  menuLabel,
  moreLabel,
  children,
}: {
  logo: Logo | null;
  label: string;
  onClick: () => void;
  menuLabel: string;
  moreLabel: string;
  children: ReactNode;
}) {
  return (
    <div className="flex items-center">
      <Button
        type="button"
        size="sm"
        variant="outline"
        className="rounded-r-none"
        onClick={onClick}
      >
        {logo ? <LogoIcon logo={logo} className="size-3.5" /> : null}
        {label}
      </Button>
      <DropdownMenu modal={false}>
        <DropdownMenuTrigger asChild>
          <Button
            type="button"
            size="sm"
            variant="outline"
            aria-label={moreLabel}
            className="rounded-l-none border-l-0 px-1.5"
          >
            <Icon name="ChevronDown" className="size-3.5" aria-hidden />
          </Button>
        </DropdownMenuTrigger>
        <DropdownMenuContent
          align="start"
          mobileTitle={menuLabel}
          className="w-64"
        >
          <DropdownMenuLabel className="font-normal text-subtle-foreground">
            {menuLabel}
          </DropdownMenuLabel>
          {children}
        </DropdownMenuContent>
      </DropdownMenu>
    </div>
  );
}

function MenuRow({
  logo,
  label,
  detail,
  disabled,
  checked,
  onSelect,
}: {
  logo: Logo | null;
  label: string;
  detail?: string | null;
  disabled?: boolean;
  checked?: boolean;
  onSelect?: () => void;
}) {
  return (
    <DropdownMenuItem
      disabled={disabled || checked}
      className="gap-2"
      onSelect={onSelect}
    >
      {logo ? <LogoIcon logo={logo} className="size-4" /> : null}
      <span className="min-w-0 flex-1 truncate">{label}</span>
      {detail ? <span className="text-subtle-foreground">{detail}</span> : null}
      {checked ? <Icon name="Check" className="size-4" aria-hidden /> : null}
    </DropdownMenuItem>
  );
}
