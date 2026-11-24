import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { afterEach, expect, it } from "vitest";
import {
  dispatchCommand,
  dispatchOnlineRpcCommand,
} from "../../src/command-dispatch.js";
import {
  cleanupTempDirs,
  commitHooks,
  createHarness,
  HOOK_TEST_ENVIRONMENT_ID,
  makeTempDir,
  saveHooks,
} from "./dispatch-helpers.js";

afterEach(cleanupTempDirs);

it("streams hook output and cancels the process before the run RPC settles", async () => {
  const harness = createHarness();
  const path = await makeTempDir("bb-hook-dispatch-");
  await saveHooks(path, { setup: "echo running-hook\nsleep 120\n" });
  const output: string[] = [];
  const options = harness.dispatchOptions({ dataDir: path });
  options.emitEnvironmentHookProgress = (message) => {
    output.push(message.entry.text);
    if (message.entry.text === "running-hook")
      void dispatchOnlineRpcCommand(
        {
          type: "environment.hook.cancel",
          operationId: "hook-1",
        },
        options,
      );
  };
  await expect(
    dispatchOnlineRpcCommand(
      {
        type: "environment.hook.run",
        contributedEnv: [],
        resumeOnly: false,
        operationId: "hook-1",
        environmentId: HOOK_TEST_ENVIRONMENT_ID,
        path,
        kind: "setup",
        timeoutMs: 5000,
      },
      options,
    ),
  ).rejects.toThrow("cancelled");
  expect(output).toContain("running-hook");
  expect(output).toContain(".bb-env-setup.sh cancelled");
});

it("reconciles running and completed hook IDs without executing a second shell", async () => {
  const path = await makeTempDir("bb-hook-resume-");
  await saveHooks(path, { setup: "echo once >> marker\nwhile [ ! -f proceed ]; do sleep 0.05; done\n" });
  const options = createHarness().dispatchOptions({ dataDir: path });
  const command = {
    type: "environment.hook.run" as const,
    contributedEnv: [],
    resumeOnly: false,
    operationId: "resume",
    environmentId: HOOK_TEST_ENVIRONMENT_ID,
    path,
    kind: "setup" as const,
    timeoutMs: 5000,
  };
  const first = dispatchOnlineRpcCommand(command, options);
  await expect
    .poll(async () => readFile(join(path, "marker"), "utf8").catch(() => ""))
    .toBe("once\n");
  const resumed = dispatchOnlineRpcCommand(
    { ...command, resumeOnly: true },
    options,
  );
  await writeFile(join(path, "proceed"), "");
  await Promise.all([first, resumed]);
  await dispatchOnlineRpcCommand({ ...command, resumeOnly: true }, options);
  expect(await readFile(join(path, "marker"), "utf8")).toBe("once\n");
});

it("rejects unknown recovery and cancels delayed dispatch within this daemon", async () => {
  const path = await makeTempDir("bb-hook-unknown-");
  await saveHooks(path, { setup: "echo unsafe > marker\n" });
  const options = createHarness().dispatchOptions({ dataDir: path });
  await expect(
    dispatchOnlineRpcCommand(
      {
        type: "environment.hook.run",
        contributedEnv: [],
        resumeOnly: true,
        operationId: "unknown",
        environmentId: HOOK_TEST_ENVIRONMENT_ID,
        path,
        kind: "setup",
        timeoutMs: 5000,
      },
      options,
    ),
  ).rejects.toThrow("outcome is unknown");
  await expect(
    dispatchOnlineRpcCommand(
      { type: "environment.hook.cancel", operationId: "unknown" },
      options,
    ),
  ).resolves.toEqual({ status: "unknown" });
  await expect(
    dispatchOnlineRpcCommand(
      {
        type: "environment.hook.run",
        contributedEnv: [],
        resumeOnly: false,
        operationId: "unknown",
        environmentId: HOOK_TEST_ENVIRONMENT_ID,
        path,
        kind: "setup",
        timeoutMs: 5000,
      },
      options,
    ),
  ).rejects.toThrow("cancelled before dispatch");
  await expect(readFile(join(path, "marker"))).rejects.toThrow();
});

it("reports unknown after daemon memory is lost without rerunning the script", async () => {
  const path = await makeTempDir("bb-hook-daemon-restart-");
  await saveHooks(path, { setup: "echo started > started\nsleep 120\necho unsafe > completed\n" });
  const firstOptions = createHarness().dispatchOptions({ dataDir: path });
  const command = {
    type: "environment.hook.run" as const,
    contributedEnv: [],
    resumeOnly: false,
    operationId: "restart",
    environmentId: HOOK_TEST_ENVIRONMENT_ID,
    path,
    kind: "setup" as const,
    timeoutMs: 5000,
  };
  const running = dispatchOnlineRpcCommand(command, firstOptions).catch(
    () => undefined,
  );
  await expect
    .poll(async () => readFile(join(path, "started"), "utf8").catch(() => ""))
    .toBe("started\n");
  const restored = createHarness().dispatchOptions({ dataDir: path });
  try {
    await expect(
      dispatchOnlineRpcCommand({ ...command, resumeOnly: true }, restored),
    ).rejects.toThrow("outcome is unknown");
    await expect(
      dispatchOnlineRpcCommand(
        { type: "environment.hook.cancel", operationId: "restart" },
        restored,
      ),
    ).resolves.toEqual({ status: "unknown" });
    expect(await readFile(join(path, "started"), "utf8")).toBe("started\n");
  } finally {
    await dispatchOnlineRpcCommand(
      { type: "environment.hook.cancel", operationId: "restart" },
      firstOptions,
    );
    await running;
  }
  await expect(readFile(join(path, "completed"))).rejects.toThrow();
});

it.each(["setup", "teardown"] as const)(
  "injects %s contributions and forwards progress as-is",
  async (kind) => {
    const path = await makeTempDir("bb-hook-environment-");
    const secret = "hook-secret-fixture";
    await saveHooks(path, { [kind]: 'test "$HOOK_PLAIN" = configured || exit 1\nprintf "%s" "$GH_TOKEN" > received\nprintf "%s\\n" "$GH_TOKEN"\nexit 1\n' });
    const options = createHarness().dispatchOptions({ dataDir: path });
    const output: string[] = [];
    options.emitEnvironmentHookProgress = (message) =>
      output.push(message.entry.text);
    const command = {
      type: "environment.hook.run" as const,
      contributedEnv: [
        {
          name: "GH_TOKEN",
          value: secret,
          source: { core: "machine-environment" as const },
          reason: "test",
        },
        {
          name: "HOOK_PLAIN",
          value: "configured",
          source: { core: "machine-environment" as const },
          reason: "test",
        },
      ],
      resumeOnly: false,
      operationId: `env-${kind}`,
      environmentId: HOOK_TEST_ENVIRONMENT_ID,
      path,
      kind,
      timeoutMs: 5000,
    };
    if (kind === "setup")
      await expect(dispatchOnlineRpcCommand(command, options)).rejects.toThrow(
        "exit code 1",
      );
    else await dispatchOnlineRpcCommand(command, options);
    expect(await readFile(join(path, "received"), "utf8")).toBe(secret);
    expect(output.join("\n")).toContain(secret);
    expect(process.env.GH_TOKEN).not.toBe(secret);
  },
);

it.each(["setup", "teardown"] as const)(
  "streams multiline contributed environment values from %s hook lines",
  async (kind) => {
    const path = await makeTempDir("bb-hook-multiline-");
    await saveHooks(path, { [kind]: 'printf "%s\\n" "$MULTILINE" | while IFS= read -r line; do printf "%s\\n" "$line"; sleep 0.05; done\nprintf "%s\\n" "$MULTILINE" | while IFS= read -r line; do printf "%s\\n" "$line"; sleep 0.05; done >&2\n' });
    const output: string[] = [];
    const options = createHarness().dispatchOptions({ dataDir: path });
    options.emitEnvironmentHookProgress = (message) => {
      output.push(message.entry.text);
    };
    await dispatchOnlineRpcCommand(
      {
        type: "environment.hook.run",
        contributedEnv: [
          {
            name: "MULTILINE",
            value: "HEADER\nPRIVATE_BODY\nFOOTER",
            source: { core: "machine-environment" as const },
            reason: "test",
          },
        ],
        resumeOnly: false,
        operationId: `output-${kind}`,
        environmentId: HOOK_TEST_ENVIRONMENT_ID,
        path,
        kind,
        timeoutMs: 5000,
      },
      options,
    );
    expect(output.join("\n")).toContain("PRIVATE_BODY");
  },
);

// A POSIX PATH fixture: on Windows it hides Git, so the hook (rightly) won't start.
it.skipIf(process.platform === "win32")(
  "applies hook NODE_ENV and PATH contributions after sanitizing inherited state",
  async () => {
    const path = await makeTempDir("bb-hook-overrides-");
    await saveHooks(path, { setup: 'printf "NODE_ENV=%s\\nPATH=%s\\n" "$NODE_ENV" "$PATH"; sleep 0.1\n' });
    const output: string[] = [];
    const options = createHarness().dispatchOptions({ dataDir: path });
    options.emitEnvironmentHookProgress = (message) => {
      output.push(message.entry.text);
    };
    const contributedEnv = Object.entries({
      NODE_ENV: "production",
      PATH: "/review-toolchain:/usr/bin:/bin",
    }).map(([name, value]) => ({
      name,
      value,
      source: { core: "machine-environment" as const },
      reason: "test",
    }));
    await dispatchOnlineRpcCommand(
      {
        type: "environment.hook.run",
        contributedEnv,
        resumeOnly: false,
        operationId: "overrides",
        environmentId: HOOK_TEST_ENVIRONMENT_ID,
        path,
        kind: "setup",
        timeoutMs: 5000,
      },
      options,
    );
    expect(output).toContain("NODE_ENV=production");
    expect(output).toContain("PATH=/review-toolchain:/usr/bin:/bin");
  },
);

it("a teardown written into the folder after setup never runs; the committed one does", async () => {
  const path = await makeTempDir("bb-hook-planted-teardown-");
  const dataDir = await makeTempDir("bb-hook-planted-teardown-data-");
  await commitHooks(path, { teardown: "echo committed > teardown-ran\n" });
  const harness = createHarness({ workspacePath: path });
  const options = harness.dispatchOptions({ dataDir });
  await dispatchCommand(
    {
      type: "environment.attach",
      contributedEnv: [],
      environmentId: "env-planted",
      initiator: null,
      path,
      setupScriptTimeoutMs: 10_000,
      hookBaseBranch: "main",
    },
    options,
  );
  // What a sandboxed agent can do: rewrite the hook in its own folder.
  await writeFile(
    join(path, ".bb-env-teardown.sh"),
    "echo planted > teardown-ran\ntouch planted\n",
  );
  await dispatchOnlineRpcCommand(
    {
      type: "environment.hook.run",
      contributedEnv: [],
      resumeOnly: false,
      operationId: "planted-teardown",
      environmentId: "env-planted",
      path,
      kind: "teardown",
      timeoutMs: 5000,
    },
    options,
  );
  expect(await readFile(join(path, "teardown-ran"), "utf8")).toBe(
    "committed\n",
  );
  await expect(readFile(join(path, "planted"))).rejects.toThrow();
  await expect(
    readFile(join(dataDir, "environment-hooks", "env-planted.json")),
  ).rejects.toThrow();
});

it("skips a teardown, with a note, for an environment set up before hooks were saved", async () => {
  const path = await makeTempDir("bb-hook-unsaved-");
  await writeFile(join(path, ".bb-env-teardown.sh"), "touch teardown-ran\n");
  const options = createHarness().dispatchOptions({ dataDir: path });
  const output: string[] = [];
  options.emitEnvironmentHookProgress = (message) =>
    output.push(message.entry.text);
  await dispatchOnlineRpcCommand(
    {
      type: "environment.hook.run",
      contributedEnv: [],
      resumeOnly: false,
      operationId: "unsaved-teardown",
      environmentId: "env-unsaved",
      path,
      kind: "teardown",
      timeoutMs: 5000,
    },
    options,
  );
  expect(output).toEqual([
    expect.stringContaining(
      "Skipped .bb-env-teardown.sh: this environment was set up before Cloudroom saved its hooks from Git",
    ),
  ]);
  await expect(readFile(join(path, "teardown-ran"))).rejects.toThrow();
});
