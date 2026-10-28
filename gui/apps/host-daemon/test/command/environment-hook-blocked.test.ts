import { access, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { afterEach, expect, it } from "vitest";
import {
  dispatchCommand,
  dispatchOnlineRpcCommand,
} from "../../src/command-dispatch.js";
import {
  clearUnverifiedHookStops,
  markHookStopUnverified,
} from "../../src/environment-lifecycle-script.js";
import {
  cleanupTempDirs,
  createHarness,
  makeTempDir,
} from "./dispatch-helpers.js";

// After a hook stop that couldn't be confirmed (Windows), no hook may start in
// that workspace again, on either the attach path or the hook RPC.
afterEach(async () => {
  clearUnverifiedHookStops();
  await cleanupTempDirs();
});

it("environment.attach won't run setup where an earlier hook may still run", async () => {
  const path = await makeTempDir("bb-hook-blocked-attach-");
  await writeFile(join(path, ".bb-env-setup.sh"), "touch setup-ran\n");
  markHookStopUnverified(path);
  const harness = createHarness({ workspacePath: path });

  await expect(
    dispatchCommand(
      {
        type: "environment.attach",
        contributedEnv: [],
        environmentId: "env-hook-blocked",
        initiator: null,
        path,
        setupScriptTimeoutMs: 10_000,
      },
      harness.dispatchOptions(),
    ),
  ).rejects.toThrow("may still be running");
  await expect(access(join(path, "setup-ran"))).rejects.toThrow();
});

it("a blocked teardown fails instead of letting cleanup proceed", async () => {
  const path = await makeTempDir("bb-hook-blocked-teardown-");
  await writeFile(join(path, ".bb-env-teardown.sh"), "touch teardown-ran\n");
  markHookStopUnverified(path);
  const options = createHarness().dispatchOptions({ dataDir: path });

  await expect(
    dispatchOnlineRpcCommand(
      {
        type: "environment.hook.run",
        contributedEnv: [],
        resumeOnly: false,
        operationId: "hook-blocked-teardown",
        path,
        kind: "teardown",
        timeoutMs: 5000,
      },
      options,
    ),
  ).rejects.toThrow("may still be running");
  await expect(
    dispatchOnlineRpcCommand(
      { type: "environment.hook.cancel", operationId: "hook-blocked-teardown" },
      options,
    ),
  ).resolves.toEqual({ status: "unknown" });
  await expect(access(join(path, "teardown-ran"))).rejects.toThrow();
});
