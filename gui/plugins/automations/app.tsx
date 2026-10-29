import { COMPUTER } from "@cloudroom/domain/computer-name";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { ReactNode } from "react";
import { buildAutomationEditThreadPrompt } from "@cloudroom/shared-ui/resource-edit-prompt";
import {
  definePluginApp,
  experimental_useProviders as useProviders,
  useBbNavigate,
  useRealtime,
  useRpc,
  useSdk,
  type PluginNavPanelProps,
} from "@get-bb/plugin-sdk/app";
import type { automationRpcContract } from "./src/rpc.js";
import { toast } from "sonner";
import type {
  AutomationResponse,
  AutomationReadResult,
  AgentExecutionUpdate,
  AutomationRunListResponse,
  AutomationRunResponse,
  AutomationsOverviewResponse,
  ReviewResponse,
} from "@/src/rpc-types";
import {
  automationEnvironmentLabel,
  providerModelRouting,
  ScriptAutomationDefinition,
} from "./detail-view";
import {
  LoopDialog,
  type LoopDialogChanges,
  type LoopDialogContext,
  type LoopDialogLoop,
  type LoopDialogRun,
  type Priority,
} from "./loop-dialog";
import { replaceWebhookUrl, useCloudAutomations } from "./cloud-view";
import {
  AutomationOverviewView,
  automationProjectLabel,
  CREATE_AUTOMATION_PROMPT,
  type AutomationCollectionMode,
  type LoopReviewState,
} from "./overview-view";
import { PERSONAL_PROJECT_ID } from "./lib/format-schedule";
import { mountPausedLoops } from "./paused-notice";
import type { LoopTemplate } from "./templates";
import type {
  LoopTarget,
  LoopTemplatesState,
  TemplateProject,
} from "./templates-view";
import { Button } from "@cloudroom/shared-ui/button";
import { DelayedLoading } from "@cloudroom/shared-ui/delayed-loading";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@cloudroom/shared-ui/dialog";
import { ResourceListState } from "@cloudroom/shared-ui/resource-list";
import { cn } from "@cloudroom/shared-ui/lib/utils";

const PANEL_PATH = "automations";
type OverviewEntry = AutomationsOverviewResponse["automations"][number];

const lastLoaded: {
  entries: OverviewEntry[] | null;
  review: ReviewResponse | null;
  plan: string | null | undefined;
  projects: TemplateProject[] | null;
} = { entries: null, review: null, plan: undefined, projects: null };

function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function loadErrorText(error: unknown): string {
  return error instanceof Error && Reflect.get(error, "code") === "needs_mac"
    ? error.message
    : "Couldn't load loops.";
}

interface DetailRoute {
  projectId: string;
  automationId: string;
}

interface ParsedDetailRoute {
  route: DetailRoute;
  editing: boolean;
}

function parseSubPath(subPath: string): ParsedDetailRoute | null {
  const parts = subPath.split("/").filter((p) => p.length > 0);
  if (parts.length === 2 || (parts.length === 3 && parts[2] === "edit")) {
    return {
      route: { projectId: parts[0], automationId: parts[1] },
      editing: parts[2] === "edit",
    };
  }
  return null;
}

interface AutomationSignal {
  projectId: string;
  kind: "automations-changed" | "automation-runs-changed";
}

function asSignal(payload: unknown): AutomationSignal | null {
  if (payload === null || typeof payload !== "object") return null;
  const record = payload as { projectId?: unknown; kind?: unknown };
  if (
    typeof record.projectId !== "string" ||
    (record.kind !== "automations-changed" &&
      record.kind !== "automation-runs-changed")
  ) {
    return null;
  }
  return { projectId: record.projectId, kind: record.kind };
}

function useOverview(): {
  entries: OverviewEntry[] | null;
  error: string | null;
  refetch: () => void;
} {
  const rpc = useRpc<typeof automationRpcContract>();
  const [state, setState] = useState<{
    entries: OverviewEntry[] | null;
    error: string | null;
  }>(() => ({ entries: lastLoaded.entries, error: null }));
  const refetchTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const requestInFlightRef = useRef(false);
  const trailingRefetchRef = useRef(false);

  const runRefetch = useCallback(
    function requestOverview(showLoading: boolean) {
      if (requestInFlightRef.current) {
        trailingRefetchRef.current = true;
        return;
      }
      requestInFlightRef.current = true;
      if (showLoading) {
        setState({ entries: null, error: null });
      }
      rpc
        .call("automations_overview")
        .then(
          (result) => {
            const data = result as AutomationsOverviewResponse;
            lastLoaded.entries = data.automations;
            setState({ entries: data.automations, error: null });
          },
          (error: unknown) =>
            setState((current) =>
              !showLoading && current.entries !== null
                ? current
                : { entries: null, error: loadErrorText(error) },
            ),
        )
        .finally(() => {
          requestInFlightRef.current = false;
          if (trailingRefetchRef.current) {
            trailingRefetchRef.current = false;
            requestOverview(false);
          }
        });
    },
    [rpc],
  );
  const refetch = useCallback(() => runRefetch(true), [runRefetch]);

  useEffect(() => {
    runRefetch(lastLoaded.entries === null);
  }, [runRefetch]);
  useEffect(
    () => () => {
      if (refetchTimerRef.current !== null) {
        clearTimeout(refetchTimerRef.current);
      }
    },
    [],
  );
  const scheduleRefetch = useCallback(() => {
    if (requestInFlightRef.current) {
      trailingRefetchRef.current = true;
      return;
    }
    if (refetchTimerRef.current !== null) return;
    refetchTimerRef.current = setTimeout(() => {
      refetchTimerRef.current = null;
      runRefetch(false);
    }, 75);
  }, [runRefetch]);
  useRealtime("automations", (payload) => {
    if (asSignal(payload) !== null) scheduleRefetch();
  });
  return { ...state, refetch };
}

function useReview(): LoopReviewState {
  const rpc = useRpc<typeof automationRpcContract>();
  const navigate = useBbNavigate();
  const [state, setState] = useState<{
    data: ReviewResponse | null;
    error: string | null;
  }>(() => ({ data: lastLoaded.review, error: null }));
  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const load = useCallback(() => {
    rpc.call("automations_review").then(
      (data) => {
        lastLoaded.review = data;
        setState({ data, error: null });
      },
      (error: unknown) =>
        setState((current) =>
          current.data === null
            ? { data: null, error: errorText(error) }
            : current,
        ),
    );
  }, [rpc]);
  useEffect(() => {
    load();
    return () => {
      if (timerRef.current !== null) clearTimeout(timerRef.current);
    };
  }, [load]);
  useRealtime("automations", (payload) => {
    if (asSignal(payload) === null || timerRef.current !== null) return;
    timerRef.current = setTimeout(() => {
      timerRef.current = null;
      load();
    }, 250);
  });
  const onMark = useCallback(
    (itemIds: string[], reviewed: boolean) => {
      setState((current) =>
        current.data === null
          ? current
          : {
              ...current,
              data: {
                ...current.data,
                items: current.data.items.map((item) =>
                  itemIds.includes(item.id)
                    ? { ...item, reviewedAt: reviewed ? Date.now() : null }
                    : item,
                ),
              },
            },
      );
      rpc.call("automations_review_mark", { itemIds, reviewed }).then(
        () => load(),
        (error: unknown) => {
          toast.error(`Couldn't save the review: ${errorText(error)}`);
          load();
        },
      );
    },
    [load, rpc],
  );
  return {
    ...state,
    onRetry: load,
    onOpenThread: (threadId: string) => navigate.toThread(threadId),
    onMark,
  };
}

function useAutomation(route: DetailRoute): {
  automation: AutomationReadResult | null;
  error: string | null;
  refetch: () => void;
} {
  const rpc = useRpc<typeof automationRpcContract>();
  const { projectId, automationId } = route;
  const [state, setState] = useState<{
    automation: AutomationReadResult | null;
    error: string | null;
  }>({ automation: null, error: null });
  const requestRef = useRef(0);

  const refetch = useCallback(() => {
    const requestId = ++requestRef.current;
    setState((current) => ({ ...current, error: null }));
    rpc.call("automations_get", { projectId, automationId }).then(
      (result) => {
        if (requestRef.current !== requestId) return;
        setState({ automation: result, error: null });
      },
      (error: unknown) => {
        if (requestRef.current !== requestId) return;
        setState({ automation: null, error: errorText(error) });
      },
    );
  }, [rpc, projectId, automationId]);

  useEffect(() => {
    setState({ automation: null, error: null });
    refetch();
    return () => {
      requestRef.current += 1;
    };
  }, [refetch]);
  useRealtime("automations", (payload) => {
    const signal = asSignal(payload);
    if (signal !== null && signal.projectId === projectId) refetch();
  });
  return { ...state, refetch };
}

function useRuns(route: DetailRoute): AutomationRunResponse[] | null {
  const rpc = useRpc<typeof automationRpcContract>();
  const { projectId, automationId } = route;
  const [runs, setRuns] = useState<AutomationRunResponse[] | null>(null);
  const requestRef = useRef(0);

  const load = useCallback(() => {
    const requestId = ++requestRef.current;
    rpc.call("automations_runs", { projectId, automationId }).then(
      (result) => {
        if (requestRef.current === requestId)
          setRuns((result as AutomationRunListResponse).runs);
      },
      () => {
        if (requestRef.current === requestId) setRuns([]);
      },
    );
  }, [rpc, projectId, automationId]);

  useEffect(() => {
    load();
  }, [load]);
  useRealtime("automations", (payload) => {
    const signal = asSignal(payload);
    if (
      signal !== null &&
      signal.kind === "automation-runs-changed" &&
      signal.projectId === projectId
    ) {
      load();
    }
  });
  return runs;
}

function localRun(run: AutomationRunResponse): LoopDialogRun[] {
  if (run.status === "skipped") return [];
  const line = (run.error ?? run.output)?.trim().split("\n")[0];
  return [
    {
      id: run.id,
      at: run.startedAt,
      status: run.status === "succeeded" ? "done" : run.status,
      text:
        line ||
        (run.status === "running"
          ? "Running"
          : run.status === "failed"
            ? "Failed"
            : run.runMode === "script"
              ? "Script ran"
              : "Agent run finished"),
      threadId: run.runMode === "agent" ? run.threadId : null,
    },
  ];
}

function useMutations() {
  const rpc = useRpc<typeof automationRpcContract>();
  type MutationMethod =
    | "automations_pause"
    | "automations_resume"
    | "automations_run"
    | "automations_delete";
  const call = useCallback(
    (method: MutationMethod, route: DetailRoute) => rpc.call(method, route),
    [rpc],
  );
  return {
    pause: (route: DetailRoute) => call("automations_pause", route),
    resume: (route: DetailRoute) => call("automations_resume", route),
    run: (route: DetailRoute) => call("automations_run", route),
    delete: (route: DetailRoute) => call("automations_delete", route),
    newWebhookUrl: (route: DetailRoute) =>
      rpc.call("automations_new_webhook_url", route),
    update: (route: DetailRoute, agent: AgentExecutionUpdate) =>
      rpc.call("automations_update", { ...route, agent }),
    setPriority: (route: DetailRoute, priority: number) =>
      rpc.call("automations_update", { ...route, priority }),
  };
}

function DeleteAutomationDialog({
  open,
  onOpenChange,
  name,
  pending,
  onConfirm,
  onCancel,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  name: string;
  pending: boolean;
  onConfirm: () => void;
  onCancel: () => void;
}) {
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent>
        {open ? (
          <>
            <DialogHeader>
              <DialogTitle>Delete loop?</DialogTitle>
              <DialogDescription>
                &ldquo;{name}&rdquo; and its run history will be permanently
                removed.
              </DialogDescription>
            </DialogHeader>
            <DialogFooter>
              <Button
                type="button"
                variant="outline"
                disabled={pending}
                onClick={onCancel}
              >
                Cancel
              </Button>
              <Button
                type="button"
                variant="destructive"
                disabled={pending}
                onClick={onConfirm}
              >
                Delete
              </Button>
            </DialogFooter>
          </>
        ) : null}
      </DialogContent>
    </Dialog>
  );
}

// Templates tab: the repos to pick from, and one Cloud (default) or Local loop per picked repo.
function useTemplates(onAdded: () => void): LoopTemplatesState {
  const rpc = useRpc<typeof automationRpcContract>();
  const sdk = useSdk();
  const navigate = useBbNavigate();
  const { providers } = useProviders();
  const [projects, setProjects] = useState(lastLoaded.projects);
  const [plan, setPlan] = useState(lastLoaded.plan);
  useEffect(() => {
    let cancelled = false;
    rpc.call("account_plan", null).then(
      (result) => {
        lastLoaded.plan = result.plan;
        if (!cancelled) setPlan(result.plan);
      },
      () => !cancelled && setPlan(null),
    );
    return () => {
      cancelled = true;
    };
  }, [rpc]);
  useEffect(() => {
    let cancelled = false;
    sdk.projects.list().then(
      (list) => {
        lastLoaded.projects = list
          .filter((project) => project.id !== PERSONAL_PROJECT_ID)
          .map((project) => ({
            id: project.id,
            name: project.name,
            path:
              (
                project.sources.find((source) => source.isDefault) ??
                project.sources[0]
              )?.path ?? null,
            github:
              project.gitRemoteUrl
                ?.trim()
                .match(
                  /github\.com[:/]([\w.-]+\/[\w.-]+?)(?:\.git)?\/?$/i,
                )?.[1] ?? null,
          }))
          .sort((a, b) => a.name.localeCompare(b.name));
        if (!cancelled) setProjects(lastLoaded.projects);
      },
      () => !cancelled && setProjects([]),
    );
    return () => {
      cancelled = true;
    };
  }, [sdk]);
  const onAdd = useCallback(
    async (template: LoopTemplate, projectIds: string[], target: LoopTarget) => {
      const timezone = Intl.DateTimeFormat().resolvedOptions().timeZone;
      // The template's agent when it is set up here, else each project's default agent.
      const ownAgent = providers.some(
        (provider) => provider.id === template.providerId && provider.available,
      );
      const results = await Promise.allSettled(
        projectIds.map(async (projectId) => {
          const defaults = await sdk.projects.defaultExecutionOptions({
            projectId,
          });
          const agent = ownAgent || defaults === null ? template : defaults;
          if (target === "cloud") {
            await rpc.call("cloud_template_add", {
              projectId,
              name: template.name,
              prompt: template.prompt,
              cron: template.cron,
              timezone,
              providerId: agent.providerId,
              model: agent.model,
              reasoningLevel: agent.reasoningLevel,
              priority: template.priority,
            });
            return;
          }
          await rpc.call("automations_create", {
            projectId,
            name: template.name,
            origin: "human",
            priority: template.priority,
            trigger: { triggerType: "schedule", cron: template.cron, timezone },
            execution: {
              mode: "agent",
              prompt: template.prompt,
              providerId: agent.providerId,
              model: agent.model,
              reasoningLevel: agent.reasoningLevel,
              permissionMode: defaults?.permissionMode ?? "auto",
              environment: { type: "project-default" },
            },
          });
        }),
      );
      const failed = results.filter((result) => result.status === "rejected");
      const added = results.length - failed.length;
      if (added > 0) {
        toast.success(
          `${template.name} is on for ${added} repo${added === 1 ? "" : "s"}${target === "cloud" ? " in the Cloud" : `, on this ${COMPUTER}`}.`,
        );
      }
      if (failed[0]?.status === "rejected") {
        toast.error(
          `Couldn't add ${template.name} to ${failed.length} repo${failed.length === 1 ? "" : "s"}: ${errorText(failed[0].reason)}`,
        );
      }
      onAdded();
    },
    [providers, rpc, sdk, onAdded],
  );
  const onUpgrade = useCallback(
    () => navigate.openUrl("https://www.cloudroom.dev/billing"),
    [navigate],
  );
  return {
    projects,
    onAdd,
    locked: plan === undefined ? null : plan === "free",
    onUpgrade,
  };
}

function OverviewView({
  onOpenDetail,
  activeMode,
  onModeChange,
  openRoute,
  onCloseRoute,
}: {
  onOpenDetail: (route: DetailRoute, options?: { editing?: boolean }) => void;
  activeMode: AutomationCollectionMode;
  onModeChange: (mode: AutomationCollectionMode) => void;
  openRoute: DetailRoute | null;
  onCloseRoute: () => void;
}) {
  const navigate = useBbNavigate();
  const { entries, error, refetch } = useOverview();
  const cloud = useCloudAutomations();
  const review = useReview();
  const mutations = useMutations();
  const reloadCloud = cloud.reload;
  const templates = useTemplates(
    useCallback(() => {
      refetch();
      void reloadCloud();
    }, [refetch, reloadCloud]),
  );

  const changeEnabled = useCallback(
    async (enabled: boolean, route: DetailRoute) => {
      const method = enabled ? "resume" : "pause";
      try {
        await mutations[method](route);
      } catch (rpcError: unknown) {
        toast.error(`Failed to ${method} loop: ${errorText(rpcError)}`);
      }
    },
    [mutations],
  );

  const changePriority = useCallback(
    async (route: DetailRoute, priority: number) => {
      try {
        await mutations.setPriority(route, priority);
      } catch (rpcError: unknown) {
        toast.error(`Couldn't change the priority: ${errorText(rpcError)}`);
        throw rpcError;
      }
      refetch();
    },
    [mutations, refetch],
  );

  const createViaChat = useCallback(
    (prompt?: string) => {
      navigate.toCompose({
        focusPrompt: true,
        initialPrompt: prompt ?? CREATE_AUTOMATION_PROMPT,
      });
    },
    [navigate],
  );

  return (
    <AutomationOverviewView
      entries={entries}
      error={error}
      onRetry={refetch}
      onOpenDetail={onOpenDetail}
      onEnabledChange={changeEnabled}
      onPriorityChange={changePriority}
      onCreateViaChat={createViaChat}
      activeMode={activeMode}
      onModeChange={onModeChange}
      cloud={cloud}
      review={review}
      templates={templates}
      localDialog={
        openRoute === null
          ? undefined
          : {
              projectId: openRoute.projectId,
              automationId: openRoute.automationId,
              render: (priority, onPriorityChange, context) => (
                <LocalLoopDialog
                  key={openRoute.automationId}
                  route={openRoute}
                  context={context}
                  priority={priority}
                  onPriorityChange={onPriorityChange}
                  onClose={onCloseRoute}
                />
              ),
            }
      }
    />
  );
}

const PERMISSION_LABELS: Record<string, string> = {
  auto: "Auto",
  "accept-edits": "Accept edits",
  full: "Full access",
};

function localLoop(automation: AutomationResponse): LoopDialogLoop {
  const { execution, trigger } = automation;
  const agent = execution.mode === "agent";
  return {
    name: automation.name,
    enabled: automation.enabled,
    cloud: false,
    nextRunAt: automation.nextRunAt,
    runs: automation.runCount,
    ...(agent ? { prompt: execution.prompt } : {}),
    cron: trigger.triggerType === "schedule" ? trigger.cron : null,
    timezone: trigger.triggerType === "schedule" ? trigger.timezone : "UTC",
    webhook: trigger.triggerType === "webhook",
    agent: agent
      ? {
          providerId: execution.providerId,
          model: execution.model,
          reasoningLevel: execution.reasoningLevel,
          ...(execution.serviceTier ? { serviceTier: execution.serviceTier } : {}),
        }
      : null,
    agentEditable: true,
    ...(agent
      ? { agentRouting: providerModelRouting(execution.environment) }
      : {}),
    runsOn: agent
      ? `${
          execution.targetThreadId !== undefined
            ? "Existing thread"
            : automationEnvironmentLabel(execution)
        } · ${PERMISSION_LABELS[execution.permissionMode] ?? execution.permissionMode}`
      : "Local · script",
    ...(agent ? { usageKey: { automationId: automation.id } } : {}),
  };
}

function LocalLoopDialog({
  route,
  context,
  priority,
  onPriorityChange,
  onClose,
}: {
  route: DetailRoute;
  context: LoopDialogContext;
  priority: Priority;
  onPriorityChange: (priority: Priority) => void;
  onClose: () => void;
}) {
  const rpc = useRpc<typeof automationRpcContract>();
  const { automation, error, refetch } = useAutomation(route);
  const ownRuns = useRuns(route);
  const mutations = useMutations();
  const [deleteOpen, setDeleteOpen] = useState(false);
  const [deleting, setDeleting] = useState(false);
  const readable =
    automation !== null && !("problem" in automation) ? automation : null;
  const loop = useMemo(
    () => (readable === null ? null : localLoop(readable)),
    [readable],
  );

  const runAction = (method: "pause" | "resume" | "run") =>
    mutations[method](route).then(
      () => {
        if (method === "run") toast.success("Run started");
      },
      (rpcError: unknown) =>
        toast.error(`Failed to ${method} loop: ${errorText(rpcError)}`),
    );

  const save = async (changes: LoopDialogChanges) => {
    if (readable === null) return false;
    const agent: AgentExecutionUpdate = {};
    if (changes.prompt !== undefined) agent.prompt = changes.prompt;
    if (changes.agent !== undefined) {
      agent.providerId = changes.agent.providerId;
      agent.model = changes.agent.model;
      agent.reasoningLevel = changes.agent.reasoningLevel;
      agent.serviceTier = changes.agent.serviceTier ?? null;
    }
    try {
      await rpc.call("automations_update", {
        ...route,
        ...(Object.keys(agent).length > 0 ? { agent } : {}),
        ...(changes.cron !== undefined &&
        readable.trigger.triggerType === "schedule"
          ? { trigger: { ...readable.trigger, cron: changes.cron } }
          : {}),
      });
      toast.success("Saved");
      refetch();
      return true;
    } catch (rpcError: unknown) {
      toast.error(`Failed to update loop: ${errorText(rpcError)}`);
      return false;
    }
  };

  const confirmDelete = () => {
    setDeleting(true);
    mutations
      .delete(route)
      .then(
        () => {
          toast.success("Loop deleted");
          setDeleteOpen(false);
          onClose();
        },
        (rpcError: unknown) =>
          toast.error(`Failed to delete loop: ${errorText(rpcError)}`),
      )
      .finally(() => setDeleting(false));
  };

  const deleteDialog = (
    <DeleteAutomationDialog
      open={deleteOpen}
      onOpenChange={setDeleteOpen}
      name={automation?.name ?? "this loop"}
      pending={deleting}
      onConfirm={confirmDelete}
      onCancel={() => setDeleteOpen(false)}
    />
  );

  if (error !== null) {
    return (
      <LoopStatusDialog
        title="Couldn't load this loop"
        message={error}
        onClose={onClose}
      >
        <Button type="button" variant="outline" onClick={onClose}>
          Close
        </Button>
        <Button type="button" onClick={refetch}>
          Retry
        </Button>
      </LoopStatusDialog>
    );
  }
  if (automation !== null && "problem" in automation) {
    return (
      <>
        <LoopStatusDialog
          title={automation.name}
          message="The stored loop configuration cannot be read."
          onClose={onClose}
        >
          <Button
            type="button"
            variant="destructive"
            disabled={deleting}
            onClick={() => setDeleteOpen(true)}
          >
            Delete loop
          </Button>
        </LoopStatusDialog>
        {deleteDialog}
      </>
    );
  }
  if (readable === null || loop === null) {
    return (
      <DelayedLoading>
        <LoopStatusDialog
          title="Loading loop…"
          message="One moment."
          onClose={onClose}
        />
      </DelayedLoading>
    );
  }

  return (
    <>
      <LoopDialog
        loop={loop}
        context={{
          ...context,
          runs: context.runs?.length
            ? context.runs
            : ownRuns
              ? ownRuns.flatMap(localRun)
              : context.runs,
        }}
        priority={priority}
        onPriorityChange={onPriorityChange}
        onEnabledChange={(enabled) => void runAction(enabled ? "resume" : "pause")}
        onRun={() => void runAction("run")}
        onDelete={() => setDeleteOpen(true)}
        onSave={save}
        onClose={onClose}
        {...(readable.execution.mode === "script"
          ? {
              script: (
                <ScriptAutomationDefinition execution={readable.execution} />
              ),
            }
          : {})}
      />
      {deleteDialog}
    </>
  );
}

function LoopStatusDialog({
  title,
  message,
  onClose,
  children,
}: {
  title: string;
  message: string;
  onClose: () => void;
  children?: ReactNode;
}) {
  return (
    <Dialog open onOpenChange={(open) => (open ? undefined : onClose())}>
      <DialogContent className="max-w-md">
        <DialogHeader>
          <DialogTitle>{title}</DialogTitle>
          <DialogDescription>{message}</DialogDescription>
        </DialogHeader>
        {children ? <DialogFooter>{children}</DialogFooter> : null}
      </DialogContent>
    </Dialog>
  );
}

function AutomationsPageFrame({
  fill,
  children,
}: {
  fill: boolean;
  children: ReactNode;
}) {
  return (
    <div className="h-full min-h-0 flex-1 overflow-y-auto">
      <div
        className={cn(
          "mx-auto box-border min-h-full w-full max-w-5xl px-4 pb-4 pt-3 md:px-10 md:pt-4",
          fill && "h-full",
        )}
      >
        {children}
      </div>
    </div>
  );
}

function AutomationsPanel({ subPath }: PluginNavPanelProps) {
  const navigate = useBbNavigate();
  const parsedRoute = useMemo(() => parseSubPath(subPath), [subPath]);
  const collectionMode: AutomationCollectionMode =
    subPath === "review" || subPath === "templates" || subPath === "scans"
      ? subPath
      : subPath === "browse"
        ? "templates"
        : "installed";
  const openDetail = useCallback(
    (next: DetailRoute, options?: { editing?: boolean }) => {
      navigate.toPluginPanel(PANEL_PATH, {
        subPath: `${next.projectId}/${next.automationId}${
          options?.editing ? "/edit" : ""
        }`,
      });
    },
    [navigate],
  );
  const backToList = useCallback(() => {
    navigate.toPluginPanel(PANEL_PATH, { subPath: "" });
  }, [navigate]);
  const changeCollectionMode = useCallback(
    (mode: AutomationCollectionMode) => {
      navigate.toPluginPanel(PANEL_PATH, {
        subPath: mode === "installed" ? "" : mode,
      });
    },
    [navigate],
  );
  return (
    <AutomationsPageFrame fill>
      <OverviewView
        onOpenDetail={openDetail}
        activeMode={collectionMode}
        onModeChange={changeCollectionMode}
        openRoute={parsedRoute?.route ?? null}
        onCloseRoute={backToList}
      />
    </AutomationsPageFrame>
  );
}

export default definePluginApp((app) => {
  app.slots.navPanel({
    id: "automations",
    title: "Loops",
    icon: "Repeat",
    path: PANEL_PATH,
    component: AutomationsPanel,
  });
  // A card on every screen when a loop's own failures paused it (ADR 0338).
  app.contentScripts.register({ id: "paused-loops", mount: mountPausedLoops });
});
