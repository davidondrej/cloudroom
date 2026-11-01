import { useQueryClient } from "@tanstack/react-query";
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

/** A plan limit stopped the last turn: continue the same thread on another agent (ADR 0211 switch, then resend). */
export function PlanLimitRow({
  threadId,
  className,
}: {
  threadId: string;
  className?: string;
}) {
  const { thread, self, selfResetsAt, agents, primary } =
    usePlanLimitAgents(threadId);
  const queryClient = useQueryClient();
  const update = useUpdateThread({
    threadId,
    errorMessage: "Couldn't switch to the other agent.",
  });
  if (!thread || (thread.status !== "idle" && thread.status !== "error")) {
    return null;
  }
  const switchTo = (agent: PlanLimitAgent) =>
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
      },
    );
  const name = self?.name ?? thread.providerId;
  const reset = formatUsageReset(selfResetsAt);
  const summary = [
    reset ? `${reset}.` : null,
    primary
      ? "Another agent can continue right now, with the full conversation."
      : null,
  ]
    .filter(Boolean)
    .join(" ");
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
      {summary ? (
        <p className="-mt-1.5 pl-7 text-sm text-muted-foreground">{summary}</p>
      ) : null}
      {primary ? (
        <div className="flex flex-wrap items-center gap-1.5 pl-7">
          <div className="flex items-center">
            <Button
              type="button"
              size="sm"
              className="rounded-r-none"
              disabled={update.isPending}
              onClick={() => switchTo(primary)}
            >
              {update.isPending ? (
                <Icon
                  name="Spinner"
                  className="size-3.5 animate-spin"
                  aria-hidden
                />
              ) : (
                <primary.icon className="size-3.5" />
              )}
              Continue with {primary.name}
            </Button>
            <DropdownMenu modal={false}>
              <DropdownMenuTrigger asChild>
                <Button
                  type="button"
                  size="sm"
                  aria-label="Other agents"
                  disabled={update.isPending}
                  className="rounded-l-none border-l border-background/25 px-1.5"
                >
                  <Icon name="ChevronDown" className="size-3.5" aria-hidden />
                </Button>
              </DropdownMenuTrigger>
              <DropdownMenuContent
                align="start"
                mobileTitle="Continue with"
                className="w-64"
              >
                <DropdownMenuLabel className="font-normal text-subtle-foreground">
                  Continue with
                </DropdownMenuLabel>
                {agents.map((agent) => (
                  <DropdownMenuItem
                    key={agent.providerId}
                    disabled={agent.resetsAt !== null}
                    className="gap-2"
                    onSelect={() => switchTo(agent)}
                  >
                    <agent.icon className="size-4" />
                    <span className="flex-1">{agent.name}</span>
                    <span className="text-subtle-foreground">
                      {agent.resetsAt === null
                        ? agent.modelLabel
                        : (formatUsageReset(agent.resetsAt) ?? "At its limit")}
                    </span>
                  </DropdownMenuItem>
                ))}
                {SelfIcon ? (
                  <>
                    <DropdownMenuSeparator />
                    <DropdownMenuItem disabled className="gap-2">
                      <SelfIcon className="size-4" />
                      <span className="flex-1">{name}</span>
                      <span className="text-subtle-foreground">
                        {reset ?? "At its limit"}
                      </span>
                    </DropdownMenuItem>
                  </>
                ) : null}
              </DropdownMenuContent>
            </DropdownMenu>
          </div>
          <span className="pl-1.5 text-xs text-subtle-foreground">
            {primary.modelLabel} · {primary.reasoningLabel}
          </span>
        </div>
      ) : null}
    </div>
  );
}
