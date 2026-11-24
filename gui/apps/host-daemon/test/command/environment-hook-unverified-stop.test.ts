import { afterEach, expect, it, vi } from "vitest";
import { dispatchOnlineRpcCommand } from "../../src/command-dispatch.js";
import {
  cleanupTempDirs,
  createHarness,
  HOOK_TEST_ENVIRONMENT_ID,
  makeTempDir,
  saveHooks,
} from "./dispatch-helpers.js";

vi.mock("../../src/environment-lifecycle-script.js", async (importOriginal) => {
  const actual =
    await importOriginal<
      typeof import("../../src/environment-lifecycle-script.js")
    >();
  return {
    ...actual,
    runSetupScript: (args: { signal?: AbortSignal }) =>
      new Promise((_resolve, reject) => {
        const fail = () =>
          reject(
            new actual.LifecycleScriptTerminationUnverifiedError(
              ".bb-env-setup.sh",
            ),
          );
        // The cancel can land while the saved hooks are still being read.
        if (args.signal?.aborted) fail();
        args.signal?.addEventListener("abort", fail);
      }),
  };
});

afterEach(cleanupTempDirs);

it("answers unknown when a cancelled hook's processes could not be confirmed stopped", async () => {
  const path = await makeTempDir("bb-hook-unverified-");
  await saveHooks(path, { setup: "sleep 120\n" });
  const options = createHarness().dispatchOptions({ dataDir: path });
  const run = dispatchOnlineRpcCommand(
    {
      type: "environment.hook.run",
      contributedEnv: [],
      resumeOnly: false,
      operationId: "hook-unverified",
      environmentId: HOOK_TEST_ENVIRONMENT_ID,
      path,
      kind: "setup",
      timeoutMs: 5000,
    },
    options,
  );
  const runFailure = expect(run).rejects.toThrow(
    "could not confirm that all of its processes exited",
  );
  await Promise.resolve();
  await expect(
    dispatchOnlineRpcCommand(
      { type: "environment.hook.cancel", operationId: "hook-unverified" },
      options,
    ),
  ).resolves.toEqual({ status: "unknown" });
  await runFailure;
});
