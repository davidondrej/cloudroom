import {
  CommandDispatchError,
  type CommandDispatchOptions,
  type CommandOf,
} from "../command-dispatch-support.js";
import {
  DEFAULT_ENV_SETUP_SCRIPT_NAME,
  DEFAULT_ENV_TEARDOWN_SCRIPT_NAME,
} from "@cloudroom/domain";
import {
  readEnvironmentHookScripts,
  removeEnvironmentHookScripts,
} from "../environment-hook-scripts.js";
import {
  LifecycleScriptTerminationUnverifiedError,
  runSetupScript,
  runTeardownScript,
} from "../environment-lifecycle-script.js";

interface HookOutcome {
  terminationUnverified: boolean;
}

interface HookOperation {
  controller: AbortController;
  done: Promise<Record<string, never>>;
  outcome: HookOutcome;
  path: string;
  kind: "setup" | "teardown";
}
const operations = new WeakMap<
  object,
  Map<string, HookOperation | "cancelled">
>();

function controllers(
  options: CommandDispatchOptions,
): Map<string, HookOperation | "cancelled"> {
  let active = operations.get(options.runtimeManager);
  if (active === undefined) {
    active = new Map();
    operations.set(options.runtimeManager, active);
  }
  return active;
}

export async function runEnvironmentHook(
  command: CommandOf<"environment.hook.run">,
  options: CommandDispatchOptions,
): Promise<Record<string, never>> {
  const active = controllers(options);
  const existing = active.get(command.operationId);
  // This daemon never ran it. The server gives up on it once its time limit passes.
  if (existing === "cancelled")
    throw new CommandDispatchError(
      "environment_hook_unknown",
      "Environment hook cancelled before dispatch",
    );
  if (existing !== undefined) {
    if (existing.path !== command.path || existing.kind !== command.kind)
      throw new Error("Environment hook identity mismatch");
    return existing.done;
  }
  if (command.resumeOnly)
    throw new CommandDispatchError(
      "environment_hook_unknown",
      "Environment hook outcome is unknown after daemon restart",
    );
  const controller = new AbortController();
  const outcome: HookOutcome = { terminationUnverified: false };
  const emit = (entry: {
    type: "step" | "output";
    text: string;
    status?: "started" | "completed" | "failed";
  }) =>
    options.emitEnvironmentHookProgress?.({
      type: "environment.hook.progress",
      operationId: command.operationId,
      entry: { type: entry.type, text: entry.text, status: entry.status ?? null },
    });
  const done = Promise.resolve().then(
    async (): Promise<Record<string, never>> => {
      const run = command.kind === "setup" ? runSetupScript : runTeardownScript;
      try {
        // Only the copy read from Git at the environment's first setup runs,
        // never the file in the folder, which sandboxed agents can write.
        const scripts = await readEnvironmentHookScripts(
          options.dataDir,
          command.environmentId,
        );
        if (scripts === null) {
          emit({
            type: "output",
            text: `Skipped ${command.kind === "setup" ? DEFAULT_ENV_SETUP_SCRIPT_NAME : DEFAULT_ENV_TEARDOWN_SCRIPT_NAME}: this environment was set up before Cloudroom saved its hooks from Git, so there is no copy it may run.`,
          });
          return {};
        }
        await run({
          workspacePath: command.path,
          script: command.kind === "setup" ? scripts.setup : scripts.teardown,
          dataDir: options.dataDir,
          contributedEnv: command.contributedEnv,
          env: { ...process.env, ...options.runtimeManager.getShellEnv() },
          timeoutMs: command.timeoutMs,
          shellPath: options.runtimeManager.getShellEnv().PATH,
          signal: controller.signal,
          onProgress: emit,
        });
      } catch (error) {
        if (error instanceof LifecycleScriptTerminationUnverifiedError) {
          outcome.terminationUnverified = true;
        }
        throw new Error(error instanceof Error ? error.message : String(error));
      } finally {
        // The server runs an environment's teardown operation once.
        if (command.kind === "teardown")
          await removeEnvironmentHookScripts(
            options.dataDir,
            command.environmentId,
          ).catch(() => undefined);
      }
      return {};
    },
  );
  active.set(command.operationId, {
    controller,
    done,
    outcome,
    path: command.path,
    kind: command.kind,
  });
  return done;
}

export async function cancelEnvironmentHook(
  command: CommandOf<"environment.hook.cancel">,
  options: CommandDispatchOptions,
): Promise<{ status: "unknown" | "terminated" }> {
  const active = controllers(options);
  const operation = active.get(command.operationId);
  if (operation === undefined || operation === "cancelled") {
    active.set(command.operationId, "cancelled");
    return { status: "unknown" };
  }
  operation.controller.abort();
  await operation.done.catch(() => undefined);
  return {
    status: operation.outcome.terminationUnverified ? "unknown" : "terminated",
  };
}
