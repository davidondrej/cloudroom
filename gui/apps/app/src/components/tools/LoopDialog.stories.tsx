import type { ReactNode } from "react";
import {
  LoopDialog,
  type LoopDialogContext,
  type LoopDialogLoop,
} from "bb-plugin-automations/loop-dialog";
import { PluginContext } from "../plugin/plugin-context";
import { ModelPickerStoryQueryProvider } from "../../../.ladle/model-picker-query-provider";

export default { title: "Automations / Loop dialog" };

const noop = () => {};
const save = async () => true;
const minute = 60_000;
const now = Date.now();

const PROMPT = `PR review loop. The script output below names one PR by Maty, Chris, or Marko in cloudroom-dev/cloudroom. Review it and act on it. Work only in this thread. Push only to this PR's branch, or to main for a small fix right after merging. Never force-push.

1. Read the PR, its linked issue, and the scope file it touches.
2. Check out the branch. Run the typecheck and the tests it affects.
3. Fix small problems yourself and push them to the PR's branch.
4. Spawn one GPT reviewer to try to break the change. Fix what holds up.
5. Merge when it's safe. Otherwise, comment on the PR with what's left.`;

const cloudLoop: LoopDialogLoop = {
  name: "PR review: Maty, Chris, Marko (Cloud, every 10 min, Opus 5.5)",
  enabled: true,
  cloud: true,
  nextRunAt: now + 10 * minute,
  runs: 123,
  prompt: PROMPT,
  cron: "*/10 * * * *",
  timezone: "Europe/Prague",
  webhook: false,
  agent: {
    providerId: "claude-code",
    model: "claude-opus-4-8[1m]",
    reasoningLevel: "high",
  },
  agentEditable: true,
  runsOn: "Cloud · new thread each run",
};

const context: LoopDialogContext = {
  repo: { label: "cloudroom", github: "cloudroom-dev/cloudroom" },
  runs: [
    ["done", "Merged #812 · sidebar scroll fix"],
    ["done", "Reviewed #811 · asked for 2 changes"],
    ["needs-you", "#809 needs you · pricing copy"],
    ["done", "Merged #806 · keep loop draft"],
    ["failed", "Failed · sandbox didn't start"],
    ["done", "Merged #801 · webhook retry"],
    ["done", "Reviewed #799 · looks good"],
    ["done", "Merged #797 · orbit header"],
  ].map(([status, text], index) => ({
    id: `run_${index}`,
    at: now - (index + 1) * 10 * minute,
    status: status as "done" | "needs-you" | "failed",
    text: text!,
    threadId: `thr_${index}`,
  })),
  onOpenThread: noop,
  onOpenReview: noop,
};

function Stage({
  loop,
  ctx = context,
  script,
}: {
  loop: LoopDialogLoop;
  ctx?: LoopDialogContext;
  script?: ReactNode;
}) {
  return (
    <PluginContext.Provider value="automations">
      <ModelPickerStoryQueryProvider>
        <LoopDialog
          loop={loop}
          context={ctx}
          priority={1}
          onPriorityChange={noop}
          onEnabledChange={noop}
          onRun={noop}
          onDelete={noop}
          onSave={save}
          onClose={noop}
          {...(script ? { script } : {})}
        />
      </ModelPickerStoryQueryProvider>
    </PluginContext.Provider>
  );
}

export const Cloud = () => <Stage loop={cloudLoop} />;

export const Local = () => (
  <Stage
    loop={{
      ...cloudLoop,
      name: "System health every 15 min",
      cloud: false,
      cron: "*/15 * * * *",
      nextRunAt: now + 2 * minute,
      runs: 412,
      runsOn: "Worktree · Full access",
    }}
    ctx={{ ...context, repo: { label: "website", github: null } }}
  />
);

export const PausedNoRuns = () => (
  <Stage
    loop={{ ...cloudLoop, enabled: false, runs: 0 }}
    ctx={{ ...context, runs: [] }}
  />
);
