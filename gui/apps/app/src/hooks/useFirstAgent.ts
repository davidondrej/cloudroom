import { useCallback } from "react";
import { useAtom } from "jotai";
import { atomWithStorage } from "jotai/utils";
import { useQueryClient } from "@tanstack/react-query";
import { useNavigate } from "react-router-dom";
import { PERSONAL_PROJECT_ID, sameLevelModel } from "@cloudroom/domain";
import { useCreateThread } from "@/hooks/mutations/thread-runtime-mutations";
import { cloudCatalogKnown, cloudHarness, fetchCloudroomConnection } from "@/hooks/queries/cloudroom-queries";
import { useHostDaemon } from "@/hooks/useHostDaemon";
import { fetchWithAppSurface } from "@/lib/app-surface";
import { getThreadRoutePath } from "@/lib/route-paths";
import { sdk } from "@/lib/sdk";

// The first agent (ADR 20261111-220912, docs/scopes/onboarding.md#the-first-agent): when first-run setup ends, Cloudroom
// starts an agent and sends it one short prompt by itself, so a new user lands on a working agent, not an empty screen.
const PROMPT = "explain how Cloudroom works, and why it's more powerful than default Claude or Codex.\n\nanswer in short, in plain english. be very concise.";
const MODEL = "claude-opus-5-5";
const HOLDOUT = 0.2;
/** Decided once per install: `auto` starts it, `manual` is the holdout, `none` had no Claude Code or Codex. */
const groupAtom = atomWithStorage<"auto" | "manual" | "none" | null>("cloudroom.setup.firstAgent", null, undefined, { getOnInit: true });

function report(action: "started" | "done" | "skipped", detail: "auto" | "manual" | "none" | "cloud" | "local" | "blocked" | "failed") {
  void fetchWithAppSurface("/api/v1/cloudroom/setup-step", {
    method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ step: "first_agent", action, detail }),
  }).catch(() => {});
}

/** Call when first-run setup closes, with the agents it connected. Starts nothing a second time. */
export function useStartFirstAgent() {
  const [group, setGroup] = useAtom(groupAtom);
  const queryClient = useQueryClient();
  const { localHostId } = useHostDaemon();
  const { mutateAsync: createThread } = useCreateThread();
  const navigate = useNavigate();
  return useCallback((agents: { claude: boolean; codex: boolean }) => {
    if (group !== null) return;
    // Claude Code by default; Codex only when it is the one they connected.
    const providerId = agents.claude ? "claude-code" : agents.codex ? "codex" : null;
    if (providerId === null) { setGroup("none"); return report("skipped", "none"); }
    if (Math.random() < HOLDOUT) { setGroup("manual"); return report("skipped", "manual"); }
    setGroup("auto");
    report("started", "auto");
    void (async () => {
      // Cloud when it can take this agent now (the composer's own checks), else this computer when the agent is ready
      // here. Neither: start nothing, rather than a first thread that fails.
      const cloud = await fetchCloudroomConnection(queryClient).catch(() => undefined);
      const inCloud = cloud?.ready === true && cloud.cloudQueue === null && !(cloudCatalogKnown(cloud) && !cloudHarness(cloud, providerId));
      if (!inCloud && (localHostId === null || !(await sdk.system.providerStates({ hostId: localHostId })).providers.some((provider) => provider.providerId === providerId && provider.status === "ready"))) return report("skipped", "blocked");
      const thread = await createThread({
        origin: "setup",
        // No project: nothing to copy, so the reply comes fast.
        projectId: PERSONAL_PROJECT_ID,
        providerId,
        model: providerId === "codex" ? sameLevelModel(MODEL, "claude-code", "codex") ?? MODEL : MODEL,
        reasoningLevel: "medium",
        input: [{ type: "text", text: PROMPT, mentions: [] }],
        ...(inCloud || localHostId === null
          ? { executionTarget: "cloud" as const, requestId: crypto.randomUUID(), permissionMode: "full" as const, environment: { type: "project-default" as const } }
          : { environment: { type: "host" as const, hostId: localHostId, workspace: { type: "personal" as const } } }),
      });
      report("done", inCloud ? "cloud" : "local");
      void navigate(getThreadRoutePath({ projectId: thread.projectId, threadId: thread.id }));
    })().catch(() => report("skipped", "failed"));
  }, [group, setGroup, queryClient, localHostId, createThread, navigate]);
}
