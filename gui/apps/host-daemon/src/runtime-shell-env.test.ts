import fs from "node:fs/promises";
import os from "node:os";
import path, { delimiter } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  createUserShellEnvResolver,
  prepareRuntimeShellEnv,
  resolvePowerShellExecutionPolicyDefault,
  resolveLocalBbExecutablePath,
  type SpawnUserShellEnv,
  type SpawnUserShellEnvArgs,
  type UserShellEnvSpawnResult,
} from "./runtime-shell-env.js";

const tempDirs: string[] = [];

async function makeTempDir(prefix: string): Promise<string> {
  const directoryPath = await fs.mkdtemp(path.join(os.tmpdir(), prefix));
  tempDirs.push(directoryPath);
  return directoryPath;
}

interface FakeCliPackageOptions {
  executablePath?: string;
  executable?: boolean;
  writeEntry?: boolean;
  writeRuntime?: boolean;
}

interface FakeCliPackage {
  cliEntryPath: string;
  cliRuntimePath: string;
}

interface FakeShellEnvSpawn {
  calls: SpawnUserShellEnvArgs[];
  spawn: SpawnUserShellEnv;
}

interface CreateShellEnvSpawnResultArgs {
  error?: Error;
  signal?: NodeJS.Signals | null;
  status?: number | null;
  stderr?: string;
  stdout?: string;
}

interface CreateFakeShellEnvSpawnArgs {
  results: UserShellEnvSpawnResult[];
}

async function withPlatform<T>(
  platform: NodeJS.Platform,
  action: () => Promise<T>,
): Promise<T> {
  const originalDescriptor = Object.getOwnPropertyDescriptor(
    process,
    "platform",
  );
  if (!originalDescriptor) {
    throw new Error("Expected process.platform descriptor");
  }

  Object.defineProperty(process, "platform", {
    configurable: true,
    value: platform,
  });

  try {
    return await action();
  } finally {
    Object.defineProperty(process, "platform", originalDescriptor);
  }
}

async function createFakeCliPackage(
  options: FakeCliPackageOptions = {},
): Promise<FakeCliPackage> {
  const cliPackageRoot = await makeTempDir("bb-cli-package-");
  const executablePath = options.executablePath ?? "./dist/bin/bb";
  const cliEntryPath = path.resolve(cliPackageRoot, executablePath);
  const cliRuntimePath = path.resolve(cliPackageRoot, "dist/index.js");

  if (options.writeEntry ?? true) {
    await fs.mkdir(path.dirname(cliEntryPath), { recursive: true });
    await fs.writeFile(
      cliEntryPath,
      "#!/usr/bin/env node\nprocess.stdout.write('bb')\n",
      { mode: options.executable ? 0o755 : 0o644 },
    );
    await fs.chmod(cliEntryPath, options.executable ? 0o755 : 0o644);
  }

  if (options.writeRuntime) {
    await fs.mkdir(path.dirname(cliRuntimePath), { recursive: true });
    await fs.writeFile(cliRuntimePath, "process.stdout.write('bb')\n", "utf8");
  }

  return {
    cliEntryPath,
    cliRuntimePath,
  };
}

function createShellEnvSpawnResult(
  args: CreateShellEnvSpawnResultArgs,
): UserShellEnvSpawnResult {
  return {
    ...(args.error === undefined ? {} : { error: args.error }),
    signal: args.signal ?? null,
    status: args.status ?? 0,
    stderr: args.stderr ?? "",
    stdout: args.stdout ?? "",
  };
}

function createMarkedShellEnvOutput(pathValue: string): string {
  return [
    "shell startup noise",
    "__BB_SHELL_ENV_START__",
    "USER=test-user",
    `PATH=${pathValue}`,
    "__BB_SHELL_ENV_END__",
    "shell shutdown noise",
  ].join("\n");
}

function createFakeShellEnvSpawn(
  args: CreateFakeShellEnvSpawnArgs,
): FakeShellEnvSpawn {
  const calls: SpawnUserShellEnvArgs[] = [];
  const results = [...args.results];
  return {
    calls,
    async spawn(spawnArgs) {
      calls.push(spawnArgs);
      const result = results.shift();
      if (!result) {
        throw new Error("Unexpected shell env spawn");
      }
      return result;
    },
  };
}

afterEach(async () => {
  vi.unstubAllEnvs();
  await Promise.all(
    tempDirs
      .splice(0)
      .map((directoryPath) =>
        fs.rm(directoryPath, { recursive: true, force: true }),
      ),
  );
});

describe("resolveLocalBbExecutablePath", () => {
  it("returns the built CLI executable path", async () => {
    const { cliEntryPath, cliRuntimePath } = await createFakeCliPackage({
      executable: true,
      writeRuntime: true,
    });

    await expect(
      resolveLocalBbExecutablePath({
        cliExecutablePath: cliEntryPath,
        cliRuntimePath,
      }),
    ).resolves.toBe(cliEntryPath);
  });

  it("fails before startup when the source CLI runtime is unbuilt", async () => {
    const { cliEntryPath, cliRuntimePath } = await createFakeCliPackage({
      executable: true,
    });

    await expect(
      resolveLocalBbExecutablePath({
        cliExecutablePath: cliEntryPath,
        cliRuntimePath,
      }),
    ).rejects.toThrow(
      `Missing built bb CLI runtime at ${cliRuntimePath}. Build @cloudroom/cli before starting the host daemon.`,
    );
  });

  it("fails clearly when the built CLI entry is missing", async () => {
    const { cliEntryPath } = await createFakeCliPackage({
      writeEntry: false,
    });

    await expect(
      resolveLocalBbExecutablePath({
        cliExecutablePath: cliEntryPath,
      }),
    ).rejects.toThrow(
      `Missing built bb CLI entry at ${cliEntryPath}. Build @cloudroom/cli before starting the host daemon.`,
    );
  });

  it.skipIf(process.platform === "win32")(
    "fails clearly when the built CLI entry is not executable",
    async () => {
      const { cliEntryPath } = await createFakeCliPackage({
        executable: false,
      });

      await expect(
        resolveLocalBbExecutablePath({
          cliExecutablePath: cliEntryPath,
        }),
      ).rejects.toThrow(
        `Resolved bb CLI entry is not executable: ${cliEntryPath}. Build @cloudroom/cli before starting the host daemon.`,
      );
    },
  );

  it("skips the execute-bit check on win32", async () => {
    const { cliEntryPath } = await createFakeCliPackage({
      executable: false,
    });

    await expect(
      withPlatform("win32", () =>
        resolveLocalBbExecutablePath({
          cliExecutablePath: cliEntryPath,
        }),
      ),
    ).resolves.toBe(cliEntryPath);
  });
});

describe("createUserShellEnvResolver", () => {
  it("settles when the shell env probe times out even if the shell ignores SIGTERM", async () => {
    const shellDir = await makeTempDir("bb-shell-timeout-");
    const shellPath = path.join(shellDir, "ignore-term-shell");
    await fs.writeFile(
      shellPath,
      [
        "#!/usr/bin/env node",
        'process.on("SIGTERM", () => {});',
        "setInterval(() => {}, 1000);",
        "",
      ].join("\n"),
      { mode: 0o755 },
    );
    await fs.chmod(shellPath, 0o755);

    const startedAt = Date.now();

    await expect(
      createUserShellEnvResolver({
        env: { SHELL: shellPath, PATH: "/usr/bin" },
        platform: "linux",
        timeoutMs: 25,
      })(),
    ).resolves.toBeNull();
    expect(Date.now() - startedAt).toBeLessThan(1_000);
  });

  it("loads PATH from the configured interactive login shell", async () => {
    const shellPath = "/root/.local/bin:/usr/local/bin:/usr/bin";
    const fakeSpawn = createFakeShellEnvSpawn({
      results: [
        createShellEnvSpawnResult({
          stdout: createMarkedShellEnvOutput(shellPath),
        }),
      ],
    });

    await expect(
      createUserShellEnvResolver({
        env: { SHELL: "/usr/bin/bash", PATH: "/usr/bin" },
        platform: "linux",
        spawnUserShellEnv: fakeSpawn.spawn,
        timeoutMs: 1234,
      })(),
    ).resolves.toMatchObject({ PATH: shellPath });

    expect(fakeSpawn.calls).toEqual([
      {
        command: "/usr/bin/bash",
        args: [
          "-ilc",
          "printf '%s\\n' __BB_SHELL_ENV_START__; env; printf '%s\\n' __BB_SHELL_ENV_END__",
        ],
        env: { SHELL: "/usr/bin/bash", PATH: "/usr/bin" },
        timeoutMs: 1234,
      },
    ]);
  });

  it("falls back to a non-interactive login shell when the interactive probe fails", async () => {
    const shellPath = "/home/me/.local/bin:/usr/bin";
    const fakeSpawn = createFakeShellEnvSpawn({
      results: [
        createShellEnvSpawnResult({
          status: 1,
          stderr: "interactive shell failed",
        }),
        createShellEnvSpawnResult({
          stdout: createMarkedShellEnvOutput(shellPath),
        }),
      ],
    });

    await expect(
      createUserShellEnvResolver({
        env: { SHELL: "/bin/zsh", PATH: "/usr/bin" },
        platform: "linux",
        spawnUserShellEnv: fakeSpawn.spawn,
      })(),
    ).resolves.toMatchObject({ PATH: shellPath });

    expect(fakeSpawn.calls.map((call) => call.args[0])).toEqual([
      "-ilc",
      "-lc",
    ]);
  });

  it("retains the previous shell env when a refreshed interactive probe fails", async () => {
    const interactivePath = "/home/me/.local/bin:/usr/bin";
    const fakeSpawn = createFakeShellEnvSpawn({
      results: [
        createShellEnvSpawnResult({
          stdout: createMarkedShellEnvOutput(interactivePath),
        }),
        createShellEnvSpawnResult({
          status: 1,
          stderr: "interactive shell failed",
        }),
      ],
    });

    const resolveShellEnv = createUserShellEnvResolver({
      env: { SHELL: "/bin/zsh", PATH: "/usr/bin" },
      platform: "linux",
      spawnUserShellEnv: fakeSpawn.spawn,
    });

    await expect(resolveShellEnv()).resolves.toMatchObject({
      PATH: interactivePath,
    });
    await expect(resolveShellEnv()).resolves.toMatchObject({
      PATH: interactivePath,
    });

    expect(fakeSpawn.calls.map((call) => call.args[0])).toEqual([
      "-ilc",
      "-ilc",
    ]);
  });

  it("uses plain login mode for sh-compatible fallback shells", async () => {
    const fakeSpawn = createFakeShellEnvSpawn({
      results: [
        createShellEnvSpawnResult({
          stdout: createMarkedShellEnvOutput("/usr/bin:/bin"),
        }),
      ],
    });

    await expect(
      createUserShellEnvResolver({
        env: { PATH: "/usr/bin" },
        platform: "linux",
        spawnUserShellEnv: fakeSpawn.spawn,
      })(),
    ).resolves.toMatchObject({ PATH: "/usr/bin:/bin" });

    expect(fakeSpawn.calls[0]?.command).toBe("/bin/sh");
    expect(fakeSpawn.calls[0]?.args[0]).toBe("-lc");
  });

  it("uses zsh as the macOS fallback shell when SHELL is unset", async () => {
    const fakeSpawn = createFakeShellEnvSpawn({
      results: [
        createShellEnvSpawnResult({
          stdout: createMarkedShellEnvOutput("/opt/homebrew/bin:/usr/bin"),
        }),
      ],
    });

    await expect(
      createUserShellEnvResolver({
        env: { PATH: "/usr/bin" },
        platform: "darwin",
        spawnUserShellEnv: fakeSpawn.spawn,
      })(),
    ).resolves.toMatchObject({ PATH: "/opt/homebrew/bin:/usr/bin" });

    expect(fakeSpawn.calls[0]?.command).toBe("/bin/zsh");
    expect(fakeSpawn.calls[0]?.args[0]).toBe("-ilc");
  });

  it("reads the Windows PATH and the variables it references from the registry", async () => {
    const fakeSpawn = createFakeShellEnvSpawn({
      results: [
        createShellEnvSpawnResult({
          stdout:
            "\r\nHKEY_LOCAL_MACHINE\\SYSTEM\\CurrentControlSet\\Control\\Session Manager\\Environment\r\n    JAVA_HOME    REG_SZ    C:\\Program Files\\Java\\jdk-21\r\n    Path    REG_EXPAND_SZ    %SystemRoot%\\system32;C:\\Program Files\\nodejs\\;%JAVA_HOME%\\bin\r\n\r\n",
        }),
        createShellEnvSpawnResult({
          stdout:
            "\r\nHKEY_CURRENT_USER\\Environment\r\n    TOOLS    REG_EXPAND_SZ    %USERPROFILE%\\tools\r\n    Path    REG_SZ    %USERPROFILE%\\AppData\\Roaming\\npm;c:\\program files\\NODEJS;%TOOLS%\\bin\r\n\r\n",
        }),
      ],
    });

    await expect(
      createUserShellEnvResolver({
        env: {
          Path: "C:\\Windows\\system32;C:\\launcher\\bin",
          SystemRoot: "C:\\Windows",
          USERPROFILE: "C:\\Users\\me",
        },
        platform: "win32",
        spawnUserShellEnv: fakeSpawn.spawn,
      })(),
    ).resolves.toEqual({
      PATH: "C:\\Windows\\system32;C:\\Program Files\\nodejs\\;C:\\Program Files\\Java\\jdk-21\\bin;C:\\Users\\me\\AppData\\Roaming\\npm;C:\\Users\\me\\tools\\bin;C:\\launcher\\bin",
    });

    expect(fakeSpawn.calls.map((call) => [call.command, call.args])).toEqual([
      [
        "C:\\Windows\\System32\\reg.exe",
        [
          "query",
          "HKLM\\SYSTEM\\CurrentControlSet\\Control\\Session Manager\\Environment",
        ],
      ],
      ["C:\\Windows\\System32\\reg.exe", ["query", "HKCU\\Environment"]],
    ]);
  });

  it("keeps the last good PATH when the user environment cannot be read", async () => {
    const machine = createShellEnvSpawnResult({
      stdout: "    Path    REG_SZ    C:\\Windows\r\n",
    });
    const fakeSpawn = createFakeShellEnvSpawn({
      results: [
        machine,
        createShellEnvSpawnResult({
          stdout: "    Path    REG_SZ    C:\\Users\\me\\npm\r\n",
        }),
        machine,
        createShellEnvSpawnResult({ status: 1, stdout: "" }),
      ],
    });
    const resolveEnv = createUserShellEnvResolver({
      env: { SystemRoot: "C:\\Windows" },
      platform: "win32",
      spawnUserShellEnv: fakeSpawn.spawn,
    });

    const good = { PATH: "C:\\Windows;C:\\Users\\me\\npm" };
    await expect(resolveEnv()).resolves.toEqual(good);
    await expect(resolveEnv()).resolves.toEqual(good);
  });

  it("falls back to the inherited PATH when the Windows registry cannot be read", async () => {
    const fakeSpawn = createFakeShellEnvSpawn({
      results: [createShellEnvSpawnResult({ status: 1, stdout: "" })],
    });

    await expect(
      createUserShellEnvResolver({
        env: { PATH: "C:\\Windows" },
        platform: "win32",
        spawnUserShellEnv: fakeSpawn.spawn,
      })(),
    ).resolves.toBeNull();
    expect(fakeSpawn.calls).toHaveLength(1);
  });
});

describe("prepareRuntimeShellEnv", () => {
  it("uses the daemon proxy URL without exporting its machine credential", () => {
    vi.stubEnv("BB_CONNECT_MACHINE_CREDENTIAL", "bbcm_durable_secret");

    const env = prepareRuntimeShellEnv({
      bbExecutableDirectory: "/tmp/bb-bin",
      inheritedPath: "/usr/bin",
      serverUrl: "http://127.0.0.1:43123",
    });

    expect(env.ROOM_SERVER_URL).toBe("http://127.0.0.1:43123");
    expect(env).not.toHaveProperty("BB_CONNECT_MACHINE_CREDENTIAL");
  });

  it("prepends the configured bb executable directory to PATH and sets ROOM_CLI", () => {
    expect(
      prepareRuntimeShellEnv({
        bbExecutableDirectory: "/tmp/bb-bin",
        hostDaemonPort: 3002,
        inheritedPath: "/usr/bin",
        serverUrl: "http://127.0.0.1:3334",
      }),
    ).toEqual({
      PATH: `/tmp/bb-bin${delimiter}/usr/bin`,
      ROOM_CLI: path.resolve("/tmp/bb-bin", "room-cli"),
      ROOM_SERVER_URL: "http://127.0.0.1:3334",
      ROOM_HOST_DAEMON_PORT: "3002",
    });
  });

  it("sets the PowerShell execution policy it is given and none otherwise", () => {
    const options = {
      bbExecutableDirectory: "C:\\bb",
      inheritedPath: "C:\\Windows",
      serverUrl: "http://127.0.0.1:43123",
    };

    expect(
      prepareRuntimeShellEnv({
        ...options,
        powershellExecutionPolicy: "RemoteSigned",
      }),
    ).toMatchObject({ PSExecutionPolicyPreference: "RemoteSigned" });
    expect(
      prepareRuntimeShellEnv({ ...options, powershellExecutionPolicy: null }),
    ).not.toHaveProperty("PSExecutionPolicyPreference");
    expect(prepareRuntimeShellEnv(options)).not.toHaveProperty(
      "PSExecutionPolicyPreference",
    );
  });

  it("uses an explicit bbExecutablePath for ROOM_CLI", () => {
    expect(
      prepareRuntimeShellEnv({
        bbExecutableDirectory: "/tmp/bb-bin",
        bbExecutablePath: "/opt/custom/bb",
        inheritedPath: "/usr/bin",
        serverUrl: "http://127.0.0.1:3334",
      }),
    ).toMatchObject({
      ROOM_CLI: "/opt/custom/bb",
      PATH: `/tmp/bb-bin${delimiter}/usr/bin`,
    });
  });

  it("falls back to process.env.PATH when inheritedPath is omitted", () => {
    vi.stubEnv("PATH", "/usr/local/bin:/usr/bin");

    expect(
      prepareRuntimeShellEnv({
        bbExecutableDirectory: "/tmp/bb-bin",
        hostDaemonPort: 3002,
        serverUrl: "http://127.0.0.1:3334",
      }),
    ).toEqual({
      PATH: `/tmp/bb-bin${delimiter}/usr/local/bin:/usr/bin`,
      ROOM_CLI: path.resolve("/tmp/bb-bin", "room-cli"),
      ROOM_SERVER_URL: "http://127.0.0.1:3334",
      ROOM_HOST_DAEMON_PORT: "3002",
    });
  });

  it("omits the host daemon port when the local API is disabled", () => {
    expect(
      prepareRuntimeShellEnv({
        bbExecutableDirectory: "/tmp/bb-bin",
        inheritedPath: "/usr/bin",
        serverUrl: "http://127.0.0.1:3334",
      }),
    ).toEqual({
      PATH: `/tmp/bb-bin${delimiter}/usr/bin`,
      ROOM_CLI: path.resolve("/tmp/bb-bin", "room-cli"),
      ROOM_SERVER_URL: "http://127.0.0.1:3334",
    });
  });
});

describe("resolvePowerShellExecutionPolicyDefault", () => {
  const windowsEnv = {
    PATH: "C:\\Windows\\system32",
    SystemRoot: "C:\\Windows",
  };
  const pwsh = "C:\\Program Files\\PowerShell\\7\\pwsh.exe";
  const windowsPowerShell =
    "C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe";
  const policies = (overrides: Record<string, string> = {}) =>
    createShellEnvSpawnResult({
      stdout: Object.entries({
        MachinePolicy: "Undefined",
        UserPolicy: "Undefined",
        Process: "Undefined",
        CurrentUser: "Undefined",
        LocalMachine: "Undefined",
        ...overrides,
      })
        .map(([scope, policy]) => `${scope}=${policy}`)
        .join("\r\n"),
    });

  it("offers RemoteSigned only when every PowerShell reports no policy", async () => {
    const fakeSpawn = createFakeShellEnvSpawn({
      results: [policies(), policies()],
    });

    await expect(
      resolvePowerShellExecutionPolicyDefault({
        env: windowsEnv,
        platform: "win32",
        powershells: [pwsh, windowsPowerShell],
        spawnUserShellEnv: fakeSpawn.spawn,
      }),
    ).resolves.toBe("RemoteSigned");
    expect(fakeSpawn.calls.map((call) => call.command)).toEqual([
      pwsh,
      windowsPowerShell,
    ]);
    expect(fakeSpawn.calls[0]?.args.slice(0, 3)).toEqual([
      "-NoProfile",
      "-NonInteractive",
      "-Command",
    ]);
  });

  it("leaves any configured scope alone, in either PowerShell", async () => {
    for (const scope of [
      "MachinePolicy",
      "UserPolicy",
      "CurrentUser",
      "LocalMachine",
    ]) {
      await expect(
        resolvePowerShellExecutionPolicyDefault({
          env: windowsEnv,
          platform: "win32",
          powershells: [pwsh, windowsPowerShell],
          spawnUserShellEnv: createFakeShellEnvSpawn({
            results: [policies(), policies({ [scope]: "AllSigned" })],
          }).spawn,
        }),
      ).resolves.toBeNull();
    }
  });

  it("offers nothing when PowerShell can't answer, isn't installed, or the variable is set", async () => {
    for (const result of [
      createShellEnvSpawnResult({ status: 1, stdout: "" }),
      createShellEnvSpawnResult({ error: new Error("ENOENT"), status: null }),
      createShellEnvSpawnResult({ stdout: "garbled" }),
    ]) {
      await expect(
        resolvePowerShellExecutionPolicyDefault({
          env: windowsEnv,
          platform: "win32",
          powershells: [windowsPowerShell],
          spawnUserShellEnv: createFakeShellEnvSpawn({ results: [result] })
            .spawn,
        }),
      ).resolves.toBeNull();
    }
    const neverSpawn = createFakeShellEnvSpawn({ results: [] });
    for (const options of [
      { env: windowsEnv, powershells: [] },
      { env: { ...windowsEnv, PSEXECUTIONPOLICYPREFERENCE: "AllSigned" } },
    ]) {
      await expect(
        resolvePowerShellExecutionPolicyDefault({
          ...options,
          platform: "win32",
          spawnUserShellEnv: neverSpawn.spawn,
        }),
      ).resolves.toBeNull();
    }
    await expect(
      resolvePowerShellExecutionPolicyDefault({
        env: windowsEnv,
        platform: "linux",
        spawnUserShellEnv: neverSpawn.spawn,
      }),
    ).resolves.toBeNull();
    expect(neverSpawn.calls).toEqual([]);
  });
});
