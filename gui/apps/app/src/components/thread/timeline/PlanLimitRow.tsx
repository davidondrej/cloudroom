import {
  useEffect,
  useState,
  type ComponentType,
  type CSSProperties,
  type ReactNode,
} from "react";
import { useMutation, useQueryClient } from "@tanstack/react-query";
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

/** A plan limit stopped the last turn: switch to another account of the same agent, or continue on another agent (ADR 0211 switch, then resend). */
export function PlanLimitRow({
  threadId,
  className,
}: {
  threadId: string;
  className?: string;
}) {
  const { thread, self, selfResetsAt, agents, primary } =
    usePlanLimitAgents(threadId);
  const accounts = usePlanLimitAccounts(thread?.providerId ?? "");
  const queryClient = useQueryClient();
  const [busy, setBusy] = useState<string | null>(null);
  const status = thread?.status;
  const update = useUpdateThread({
    threadId,
    errorMessage: "Couldn't switch to the other agent.",
  });
  const accountSwitch = useMutation({
    meta: { errorMessage: "Couldn't switch accounts." },
    mutationFn: switchAccount,
    onError: () => setBusy(null),
  });
  const pending = update.isPending || accountSwitch.isPending;
  useEffect(() => {
    if (busy === null || pending) return;
    const timer = setTimeout(() => setBusy(null), 60_000);
    return () => clearTimeout(timer);
  }, [busy, pending]);
  if (!thread || (status !== "idle" && status !== "error")) {
    return null;
  }
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
    setBusy(`Continuing with ${agent.name}`);
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
        onError: () => setBusy(null),
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
                const next = nextAccount(accounts.others);
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
                  detail={atLimit(account) ? "At limit" : null}
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
