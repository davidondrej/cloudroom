import type { CSSProperties, ReactNode } from "react";
import type { ThreadListEntry } from "@cloudroom/domain";
import { Button } from "@cloudroom/shared-ui/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@cloudroom/shared-ui/dropdown-menu";
import { Icon } from "@cloudroom/shared-ui/icon";
import { cn } from "@cloudroom/shared-ui/lib/utils";
import { useThreadTitleDisplayText } from "@/components/thread/ThreadTitleMentions";
import {
  RouteAnchor,
  useRouteNavigate,
} from "@/components/ui/app-route-anchor";
import { useStopThread } from "@/hooks/mutations/thread-runtime-mutations";
import { getThreadRoutePath } from "@/lib/route-paths";
import { getThreadDisplayTitle } from "@/lib/thread-title";

type SubagentState = "working" | "waiting" | "done" | "failed";

interface Subagent {
  thread: ThreadListEntry;
  state: SubagentState;
}

const STATE_LABEL: Record<SubagentState, string> = {
  working: "working",
  waiting: "needs you",
  done: "done",
  failed: "failed",
};

/** Finished agents shown as chips; older ones fold into "+N". */
const MAX_FINISHED_CHIPS = 3;

/** Clockwise orbit place of each 2x2 cell, in grid order (TL, TR, BL, BR). */
const ORBIT = [0, 1, 3, 2];

/**
 * From the thread's own status: it only turns `idle` or `error` once the agent
 * has really stopped. The runtime display status also reports "its computer is
 * offline" as not running, which is not finished.
 */
function subagentState(thread: ThreadListEntry): SubagentState {
  if (thread.hasPendingInteraction) return "waiting";
  if (thread.status === "error") return "failed";
  if (thread.status === "idle") return "done";
  return "working";
}

function threadHref(thread: ThreadListEntry): string {
  return getThreadRoutePath({
    projectId: thread.projectId,
    threadId: thread.id,
  });
}

/** The title with @mentions shown as names, like the header and sidebar. */
function useSubagentName(thread: ThreadListEntry): string {
  return useThreadTitleDisplayText(getThreadDisplayTitle(thread));
}

export function SubagentGrid({
  offset,
  className,
}: {
  offset: number;
  className?: string;
}) {
  return (
    <span className={cn("subagent-grid", className)} aria-hidden>
      {ORBIT.map((n, index) => (
        <i
          key={index}
          style={{ "--n": n, "--o": `${offset}ms` } as CSSProperties}
        />
      ))}
    </span>
  );
}

function StatusIcon({ state }: { state: SubagentState }) {
  return (
    <Icon
      name={state === "failed" ? "CircleX" : "CircleCheck"}
      className={cn(
        "size-3 shrink-0",
        state === "failed" ? "text-destructive-text" : "text-primary-text",
      )}
    />
  );
}

function LivePill({ agent, offset }: { agent: Subagent; offset: number }) {
  const name = useSubagentName(agent.thread);
  const waiting = agent.state === "waiting";
  const offline = agent.thread.runtime.displayStatus === "waiting-for-host";
  const label = `${name}, ${STATE_LABEL[agent.state]}`;
  return (
    <RouteAnchor
      href={threadHref(agent.thread)}
      aria-label={label}
      className={cn(
        "inline-flex h-[30px] max-w-60 shrink-0 items-center gap-[7px] rounded-lg border border-transparent px-2.5 text-[12.5px] text-foreground transition-colors",
        waiting
          ? "border-warning/30 bg-warning/10 hover:bg-warning/15"
          : "bg-foreground/5 hover:bg-foreground/10",
      )}
    >
      {waiting ? (
        <Icon
          name="AlertCircle"
          className="size-3.5 shrink-0 text-warning-text"
        />
      ) : (
        <SubagentGrid offset={offset} />
      )}
      <span
        className="truncate"
        title={offline ? `${name}: waiting for its computer` : label}
      >
        {name}
      </span>
      {waiting ? (
        <span className="shrink-0 text-warning-text">needs you</span>
      ) : null}
    </RouteAnchor>
  );
}

/** Shrinks with "…" when the bar is narrow, so live pills keep their room. */
function FinishedChip({ agent }: { agent: Subagent }) {
  const name = useSubagentName(agent.thread);
  const label = `${name}, ${STATE_LABEL[agent.state]}`;
  return (
    <RouteAnchor
      href={threadHref(agent.thread)}
      aria-label={label}
      className={cn(
        "inline-flex h-[26px] min-w-0 max-w-40 items-center gap-[5px] overflow-hidden rounded-md px-[7px] transition-colors hover:bg-foreground/5",
        agent.state === "failed"
          ? "text-destructive-text"
          : "text-muted-foreground hover:text-foreground",
      )}
    >
      <StatusIcon state={agent.state} />
      <span className="truncate" title={label}>
        {name}
      </span>
    </RouteAnchor>
  );
}

/** A menu item navigates on select: phone menus render items as buttons. */
function FoldedItem({ agent }: { agent: Subagent }) {
  const name = useSubagentName(agent.thread);
  const navigate = useRouteNavigate();
  return (
    <DropdownMenuItem onSelect={() => navigate(threadHref(agent.thread))}>
      <StatusIcon state={agent.state} />
      <span className="truncate">{name}</span>
    </DropdownMenuItem>
  );
}

const plural = (count: number) => (count === 1 ? "agent" : "agents");

function FoldedMenu({
  agents,
  label,
  children,
  className,
}: {
  agents: readonly Subagent[];
  label: string;
  children: ReactNode;
  className: string;
}) {
  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <button
          type="button"
          className={cn(
            "h-6 shrink-0 items-center gap-1 rounded-md bg-foreground/5 px-2 font-mono text-[11px] text-muted-foreground hover:bg-foreground/10 hover:text-foreground",
            className,
          )}
          aria-label={label}
        >
          {children}
        </button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end" className="max-w-72">
        {agents.map((agent) => (
          <FoldedItem key={agent.thread.id} agent={agent} />
        ))}
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

/**
 * The second header bar of a parent thread: one pill per live subagent, then
 * the finished ones as small chips. A click opens that agent's thread.
 */
export function SubagentBar({
  childThreads,
  reserveRight = false,
}: {
  childThreads: readonly ThreadListEntry[];
  /** Leaves room for the side chat button that hangs under the header. */
  reserveRight?: boolean;
}) {
  const stopThread = useStopThread();
  const agents = childThreads
    .filter((thread) => thread.originKind === null)
    .map((thread) => ({ thread, state: subagentState(thread) }));
  if (agents.length === 0) return null;

  const live = agents
    .filter(({ state }) => state === "working" || state === "waiting")
    .sort((a, b) => a.thread.createdAt - b.thread.createdAt);
  const finished = agents
    .filter(({ state }) => state === "done" || state === "failed")
    .sort((a, b) => b.thread.updatedAt - a.thread.updatedAt);
  const folded = finished.slice(MAX_FINISHED_CHIPS);
  const failed = finished.filter(({ state }) => state === "failed").length;

  return (
    <div
      data-subagent-bar=""
      className={cn(
        "@container flex h-[42px] shrink-0 items-center gap-1.5 overflow-hidden border-b border-foreground/[0.07] px-4 text-xs",
        reserveRight && "pr-14",
      )}
    >
      {/* Live pills always keep at least half the bar; finished chips shrink first. */}
      <div
        className={cn(
          "flex flex-1 items-center gap-1.5 overflow-x-auto [scrollbar-width:none]",
          live.length > 0 ? "min-w-[50%]" : "min-w-0",
        )}
      >
        {live.map((agent, index) => (
          <LivePill key={agent.thread.id} agent={agent} offset={index * 350} />
        ))}
      </div>
      {finished.length > 0 ? (
        <>
          {live.length > 0 ? (
            <span className="mx-1 h-[18px] w-px shrink-0 bg-foreground/10" />
          ) : null}
          {/* Wide bar: the newest chips, the rest in "+N". Narrow bar: one menu with all of them. */}
          <div className="hidden min-w-0 items-center gap-1.5 overflow-hidden @3xl:flex">
            {finished.slice(0, MAX_FINISHED_CHIPS).map((agent) => (
              <FinishedChip key={agent.thread.id} agent={agent} />
            ))}
          </div>
          {folded.length > 0 ? (
            <FoldedMenu
              agents={folded}
              label={`${folded.length} more finished ${plural(folded.length)}`}
              className="hidden @3xl:inline-flex"
            >
              +{folded.length}
            </FoldedMenu>
          ) : null}
          <FoldedMenu
            agents={finished}
            label={`${finished.length} finished ${plural(finished.length)}`}
            className="inline-flex @3xl:hidden"
          >
            {failed > 0 ? (
              <>
                <StatusIcon state="failed" />
                {failed}
              </>
            ) : null}
            {finished.length > failed ? (
              <>
                <StatusIcon state="done" />
                {finished.length - failed}
              </>
            ) : null}
          </FoldedMenu>
        </>
      ) : null}
      {live.length > 0 ? (
        <Button
          type="button"
          variant="outline"
          size="sm"
          className="ml-1 h-7 shrink-0 px-2.5"
          onClick={() => {
            for (const { thread } of live) stopThread.mutate(thread.id);
          }}
        >
          Stop all
        </Button>
      ) : null}
    </div>
  );
}
