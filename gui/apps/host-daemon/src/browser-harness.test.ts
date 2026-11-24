import { spawn, spawnSync } from "node:child_process";
import {
  chmodSync,
  closeSync,
  constants,
  openSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, it, vi } from "vitest";
import {
  createBrowserHarnessShimInstaller,
  installBrowserHarnessShim,
} from "./browser-harness.js";

const roots: string[] = [];

afterEach(() => {
  for (const root of roots.splice(0)) {
    rmSync(root, { recursive: true, force: true });
  }
});

// #1087: one failed write, or a deleted shim, used to leave agents without browser-harness until the
// daemon restarted. A file where the folder goes fails the write even as root. Repairs after start
// never hold the caller: overlapping ones still leave a whole shim, and a blocked read (a FIFO) returns.
it.skipIf(process.platform === "win32").each([
  ["a write that failed at daemon start", "start", 1],
  ["a shim deleted after start", "deleted", 0],
  ["overlapping repairs", "overlap", 0],
  ["a shim whose read blocks", "stuck", 0],
  ["a write that fails after a good start", "later", 1],
] as const)("each refresh repairs %s", async (_name, when, errorCount) => {
  const root = mkdtempSync(join(tmpdir(), "browser-harness-"));
  roots.push(root);
  const reference = await installBrowserHarnessShim(join(root, "reference"));
  const shimText = readFileSync(
    join(reference ?? "", "browser-harness"),
    "utf8",
  );
  const bin = join(root, "bin");
  const shim = join(bin, "browser-harness");
  const errors: unknown[] = [];
  const install = createBrowserHarnessShimInstaller(root, (error) =>
    errors.push(error),
  );
  if (when === "start") writeFileSync(bin, "");
  expect(await install()).toBe(when === "start" ? undefined : bin);
  rmSync(when === "start" || when === "later" ? bin : shim, {
    recursive: true,
    force: true,
  });
  if (when === "later") writeFileSync(bin, "");
  if (when === "stuck") spawnSync("mkfifo", [shim]);
  const calls = when === "overlap" ? 5 : 1;
  expect(await Promise.all(Array.from({ length: calls }, install))).toEqual(
    Array(calls).fill(bin),
  );
  // Unblocks the read with an empty FIFO once it has started, so the repair can replace it.
  if (when === "stuck") {
    await vi.waitFor(() =>
      closeSync(openSync(shim, constants.O_WRONLY | constants.O_NONBLOCK)),
    );
  }
  await vi.waitFor(() => expect(errors).toHaveLength(errorCount));
  if (when === "later") return expect(existsSync(shim)).toBe(false);
  await vi.waitFor(() =>
    expect(statSync(shim).isFile() && readFileSync(shim, "utf8")).toBe(
      shimText,
    ),
  );
  expect(readdirSync(bin)).toEqual(["browser-harness"]);
});

const supported =
  ["darwin", "linux"].includes(process.platform) &&
  ["arm64", "x64"].includes(process.arch);

// A first run of the shim with a fake `curl` that saves where it downloads to,
// waits `delay` seconds, then fails the checksum check, so nothing is fetched
// or run. A space in the data folder's path must not matter.
async function firstRun(delay: number) {
  const root = mkdtempSync(join(tmpdir(), "browser-harness-"));
  roots.push(root);
  const dataDir = join(root, "data folder");
  const temp = join(root, "temp");
  const fakeBin = join(root, "fake-bin");
  mkdirSync(temp);
  mkdirSync(fakeBin);
  writeFileSync(
    join(fakeBin, "curl"),
    `#!/bin/sh\nwhile [ $# -gt 0 ]; do [ "$1" = -o ] && out=$2; shift; done\nprintf %s "$out" > "$CURL_OUTPUT"\nsleep ${delay}\nprintf junk > "$out"\n`,
  );
  chmodSync(join(fakeBin, "curl"), 0o755);
  const bin = await installBrowserHarnessShim(dataDir);
  return {
    home: join(dataDir, "browser-harness"),
    output: join(root, "curl-output"),
    shim: join(bin ?? "", "browser-harness"),
    temp,
    env: {
      ...process.env,
      CURL_OUTPUT: join(root, "curl-output"),
      PATH: `${fakeBin}:${process.env.PATH ?? ""}`,
      TMPDIR: temp,
    },
  };
}

it.skipIf(!supported)(
  "downloads uv into the data folder, never the OS temp folder",
  async () => {
    // uv runs from this download outside any sandbox. Read-only Mac commands
    // and sandboxed agents can change files in the OS temp folder.
    const run = await firstRun(0);

    const result = spawnSync(run.shim, ["--version"], {
      encoding: "utf8",
      env: run.env,
    });

    expect(result.stderr).toContain("uv checksum mismatch");
    const download = readFileSync(run.output, "utf8");
    expect(download.startsWith(`${run.home}/install.`)).toBe(true);
    expect(download.endsWith("/uv.tgz")).toBe(true);
    expect(readdirSync(run.temp)).toEqual([]);
    // The download and the install lock are gone.
    expect(readdirSync(run.home)).toEqual([]);
  },
);

it.skipIf(!supported)(
  "removes its download and lock when it is stopped mid-install",
  async () => {
    const run = await firstRun(30);
    // In its own process group, like an agent's command that times out.
    const child = spawn(run.shim, ["--version"], {
      detached: true,
      env: run.env,
      stdio: "ignore",
    });
    const exited = new Promise((resolve) => child.once("exit", resolve));
    const pid = child.pid;
    if (pid === undefined) throw new Error("The shim did not start");
    await vi.waitFor(() => expect(existsSync(run.output)).toBe(true), {
      timeout: 10_000,
    });

    process.kill(-pid, "SIGTERM");
    await exited;

    expect(readdirSync(run.home)).toEqual([]);
  },
);

// #1335: a lease's ws:// endpoint in BU_CDP_URL made 0.1.13 poll /json/version for 30 s and fail.
it.skipIf(!supported).each([
  ["ws://127.0.0.1:1/cdp/a", "", "ws://127.0.0.1:1/cdp/a|"],
  ["wss://host/x", "ws://explicit", "ws://explicit|"],
  ["http://127.0.0.1:9333", "", "|http://127.0.0.1:9333"],
])(
  "passes BU_CDP_URL=%s on as BU_CDP_WS only when it is a WebSocket",
  async (url, ws, expected) => {
    const root = mkdtempSync(join(tmpdir(), "browser-harness-"));
    roots.push(root);
    const bin = await installBrowserHarnessShim(root);
    const venv = join(root, "browser-harness", "0.1.13");
    mkdirSync(join(venv, "bin"), { recursive: true });
    writeFileSync(join(venv, ".ready"), "");
    writeFileSync(
      join(venv, "bin", "browser-harness"),
      '#!/bin/sh\nprintf %s "$BU_CDP_WS|$BU_CDP_URL"\n',
    );
    chmodSync(join(venv, "bin", "browser-harness"), 0o755);

    const result = spawnSync(
      join(bin ?? "", "browser-harness"),
      ["--version"],
      {
        encoding: "utf8",
        env: {
          ...process.env,
          BU_CDP_URL: url,
          BU_CDP_WS: ws,
          BU_NAME: "test",
          ROOM_THREAD_ID: "",
        },
      },
    );

    expect(result.stdout).toBe(expected);
  },
);

it.skipIf(!supported)(
  "gives each explicit CDP endpoint its own daemon name (#1275)",
  async () => {
    // A daemon is reused by name alone, so one thread's second endpoint got
    // the first browser's daemon. A fake install prints the name it was given.
    const root = mkdtempSync(join(tmpdir(), "browser-harness-"));
    roots.push(root);
    const bin = await installBrowserHarnessShim(join(root, "data"));
    const venv = join(root, "data", "browser-harness", "0.1.13");
    mkdirSync(join(venv, "bin"), { recursive: true });
    writeFileSync(join(venv, ".ready"), "");
    writeFileSync(
      join(venv, "bin", "browser-harness"),
      '#!/bin/sh\nprintf %s "$BU_NAME"\n',
    );
    chmodSync(join(venv, "bin", "browser-harness"), 0o755);
    const name = (env: Record<string, string>) =>
      spawnSync(join(bin ?? "", "browser-harness"), ["--version"], {
        encoding: "utf8",
        env: { PATH: process.env.PATH, ROOM_THREAD_ID: "thr_1", ...env },
      }).stdout;
    const a = { BU_CDP_URL: "http://127.0.0.1:9222" };
    const b = { BU_CDP_URL: "http://127.0.0.1:9232" };
    const [plain, a1, a2, b1, ws, own, long] = [
      {},
      a,
      a,
      b,
      { ...a, BU_CDP_WS: "ws://127.0.0.1:9232/devtools/browser/x" },
      { ...b, BU_NAME: "mine" },
      { ...b, ROOM_THREAD_ID: "t".repeat(80) },
    ].map(name);

    expect(plain).toBe("thr_1");
    expect(a1).toMatch(/^thr_1-\d+$/);
    expect(a2).toBe(a1);
    expect(new Set([a1, b1, ws]).size).toBe(3);
    expect(own).toBe("mine");
    expect(long).toMatch(/^t{53}-\d{1,10}$/);
  },
);

it.skipIf(!supported)(
  "switch_tab keeps the daemon's live session on the same tab (#1215)",
  async () => {
    const root = mkdtempSync(join(tmpdir(), "browser-harness-"));
    roots.push(root);
    const bin = await installBrowserHarnessShim(root);
    const venv = join(root, "browser-harness", "0.1.13");
    const pkg = join(
      venv,
      "lib",
      "python3.12",
      "site-packages",
      "browser_harness",
    );
    mkdirSync(join(venv, "bin"), { recursive: true });
    mkdirSync(pkg, { recursive: true });
    writeFileSync(join(venv, ".ready"), "");
    writeFileSync(
      join(venv, "bin", "python"),
      '#!/bin/sh\nexec python3 "$@"\n',
    );
    writeFileSync(join(venv, "bin", "browser-harness"), "#!/bin/sh\n");
    chmodSync(join(venv, "bin", "python"), 0o755);
    chmodSync(join(venv, "bin", "browser-harness"), 0o755);
    // 0.1.13's switch_tab attach lines, verbatim.
    writeFileSync(
      join(pkg, "helpers.py"),
      "def switch_tab(target_id):\n" +
        '    sid = cdp("Target.attachToTarget", targetId=target_id, flatten=True)["sessionId"]\n' +
        '    _send({"meta": "set_session", "session_id": sid, "target_id": target_id})\n' +
        "    return sid\n",
    );
    for (const _ of [1, 2]) {
      const run = spawnSync(join(bin ?? "", "browser-harness"), [], {
        env: { ...process.env, BU_NAME: "test" },
      });
      expect(run.status).toBe(0);
    }

    // Each row: the daemon's status, whether its session answers, the tab
    // requested, and the session switch_tab returns ("new" means it attached).
    const rows = [
      ['{"target_id": "T1", "session_id": "S1"}', true, "T1", "S1"],
      ['{"target_id": "T1", "session_id": "S1"}', true, "T2", "new"],
      ['{"target_id": "T1", "session_id": "S1"}', false, "T1", "new"],
      ['{"error": "not_attached"}', true, "T1", "new"],
    ] as const;
    const driver = [
      "import importlib.util, json, sys",
      'spec = importlib.util.spec_from_file_location("h", sys.argv[1])',
      "m = importlib.util.module_from_spec(spec); spec.loader.exec_module(m)",
      "for status, live, target in json.loads(sys.argv[2]):",
      "    def send(req, status=status):",
      '        if req["meta"] == "connection_status":',
      "            r = json.loads(status)",
      '            if "error" in r: raise RuntimeError(r["error"])',
      "            return r",
      "    def cdp(method, live=live, **params):",
      '        if method == "Target.attachToTarget": return {"sessionId": "new"}',
      '        if not live: raise RuntimeError("Session with given id not found")',
      "    m._send, m.cdp, m._mark_tab = send, cdp, lambda: None",
      "    print(m.switch_tab(target))",
    ];
    const result = spawnSync(
      "python3",
      [
        "-c",
        driver.join("\n"),
        join(pkg, "helpers.py"),
        JSON.stringify(rows.map((row) => row.slice(0, 3))),
      ],
      { encoding: "utf8" },
    );
    expect(result.stdout.trim().split("\n")).toEqual(rows.map((row) => row[3]));
  },
);

// 0.1.13 messages that sent agents the wrong way: mac-approve sees only English Google Chrome sheets on the
// current Space, yet said to run it again (#1295); Chrome rejects at once while it has no window, yet the
// message named no fix, so every retry failed the same way (#1702); the Allow popup wait had no limit (#2521).
// Each source is 0.1.13's, verbatim.
it.skipIf(!supported).each([
  [
    "mac-approve not-found asks the user to click Allow instead of retrying (#1295)",
    "macos.py",
    "def f():\n" +
      "        return (\n" +
      '            "not-found",\n' +
      '            "retry the browser command and run `browser-harness mac-approve` when the prompt appears",\n' +
      "        )\n",
    "not-found|the Allow sheet was not found here: it can be on another Space or desktop, in another language, or in a browser other than Google Chrome. Do not run mac-approve again. Ask the user to switch to the browser and click Allow; the waiting browser command then continues. If they see no prompt, retry the browser command once",
  ],
  [
    "an approval that ended asks the user to open a Chrome window (#1702)",
    "admin.py",
    "def f():\n" +
      "                return (\n" +
      '                    "permission-blocked: the pending Chrome connection ended before approval; "\n' +
      '                    "browser-harness did not retry or create another connection."\n' +
      "                ,)\n",
    "permission-blocked: the pending Chrome connection ended before approval; browser-harness did not retry or create another connection. Chrome rejects the connection at once, with no popup, when it has no open browser window. Ask the user to open a Chrome window and confirm, then retry once; they click Allow on the popup that appears. Do not retry before they confirm.",
  ],
  [
    "a local Allow popup wait ends after 90 s and says what to do unattended (#2521)",
    "admin.py",
    "def f(local=True, explicit_wait=False, startup_wait=60.0):\n" +
      "    approval_wait = None if local and not explicit_wait else startup_wait\n" +
      "    return (\n" +
      '                "permission-blocked: Chrome\'s Allow popup is still open and the pending daemon was left running. "\n' +
      '                "Approve that exact popup; browser-harness did not retry or create another connection."\n' +
      "    , approval_wait)\n",
    "permission-blocked: Chrome's Allow popup is still open and the pending daemon was left running. Approve that exact popup; browser-harness did not retry or create another connection. In an unattended run, stop and tell the user to click Allow in Chrome.|90.0",
  ],
])("%s", async (_name, file, source, expected) => {
  const root = mkdtempSync(join(tmpdir(), "browser-harness-"));
  roots.push(root);
  const bin = await installBrowserHarnessShim(root);
  const venv = join(root, "browser-harness", "0.1.13");
  const pkg = join(venv, "lib", "python3.12", "site-packages");
  mkdirSync(join(venv, "bin"), { recursive: true });
  mkdirSync(join(pkg, "browser_harness"), { recursive: true });
  writeFileSync(join(venv, ".ready"), "");
  writeFileSync(join(venv, "bin", "browser-harness"), "#!/bin/sh\n");
  chmodSync(join(venv, "bin", "browser-harness"), 0o755);
  writeFileSync(join(pkg, "browser_harness", file), source);
  for (const _ of [1, 2]) {
    const run = spawnSync(join(bin ?? "", "browser-harness"), [], {
      env: { ...process.env, BU_NAME: "test" },
    });
    expect(run.status).toBe(0);
  }

  const result = spawnSync(
    "python3",
    [
      "-c",
      `from browser_harness.${file.slice(0, -3)} import f; print(*f(), sep='|')`,
    ],
    { encoding: "utf8", env: { ...process.env, PYTHONPATH: pkg } },
  );
  expect(result.stdout).toBe(`${expected}\n`);
});

it.skipIf(!supported)(
  "a timeout names a JS dialog open on the agent's tab (#1233)",
  async () => {
    const root = mkdtempSync(join(tmpdir(), "browser-harness-"));
    roots.push(root);
    const bin = await installBrowserHarnessShim(root);
    const venv = join(root, "browser-harness", "0.1.13");
    const pkg = join(
      venv,
      "lib",
      "python3.12",
      "site-packages",
      "browser_harness",
    );
    mkdirSync(join(venv, "bin"), { recursive: true });
    mkdirSync(pkg, { recursive: true });
    writeFileSync(join(venv, ".ready"), "");
    writeFileSync(
      join(venv, "bin", "python"),
      '#!/bin/sh\nexec python3 "$@"\n',
    );
    writeFileSync(join(venv, "bin", "browser-harness"), "#!/bin/sh\n");
    chmodSync(join(venv, "bin", "python"), 0o755);
    chmodSync(join(venv, "bin", "browser-harness"), 0o755);
    // 0.1.13's _send() and cdp() with its constants inlined; ipc and NAME stand in for its imports.
    writeFileSync(
      join(pkg, "helpers.py"),
      [
        "ipc = NAME = None",
        "class _IPCResponseTimeout(TimeoutError): pass",
        "def _send(req, response_timeout=5.0):",
        "    c, token = ipc.connect(NAME, timeout=5.0)",
        "    try:",
        "        c.settimeout(response_timeout)",
        "        try:",
        "            r = ipc.request(c, token, req)",
        "        except TimeoutError as e:",
        '            label = req.get("method") or req.get("meta") or "request"',
        "            raise _IPCResponseTimeout(",
        '                f"{label} timed out after {response_timeout:g}s waiting for the daemon"',
        "            ) from e",
        "    finally:",
        "        c.close()",
        '    if "error" in r: raise RuntimeError(r["error"])',
        "    return r",
        "def cdp(method, session_id=None, _response_timeout=5.0, **params):",
        "    return _send(",
        '        {"method": method, "params": params, "session_id": session_id},',
        "        response_timeout=_response_timeout,",
        '    ).get("result", {})',
        "",
      ].join("\n"),
    );
    for (const _ of [1, 2]) {
      const run = spawnSync(join(bin ?? "", "browser-harness"), [], {
        env: { ...process.env, BU_NAME: "test" },
      });
      expect(run.status).toBe(0);
    }

    // Each row: the daemon's pending dialog ("slow": no answer, "saturated":
    // no connect), its current_tab reply ({} is a dropped reply), an explicit
    // session, and whether the timeout names the dialog plus the longest
    // connect timeout the dialog check used (0: no check).
    const tab = { targetId: "T1" };
    const dialog = { frameId: "T1", type: "beforeunload" };
    const rows = [
      [dialog, tab, null, "True 1"],
      [{ ...dialog, frameId: "T2" }, tab, null, "False 1"],
      [null, tab, null, "False 1"],
      [dialog, tab, "S9", "False 0"],
      ["slow", tab, null, "False 1"],
      ["saturated", tab, null, "False 1"],
      [{ type: "beforeunload" }, {}, null, "False 1"],
    ] as const;
    const driver = [
      "import importlib.util, json, sys, types",
      'spec = importlib.util.spec_from_file_location("h", sys.argv[1])',
      "m = importlib.util.module_from_spec(spec); spec.loader.exec_module(m)",
      "for pending, reply, session in json.loads(sys.argv[2]):",
      "    calls = []",
      "    def connect(name, timeout, pending=pending):",
      "        calls.append(timeout)",
      '        if pending == "saturated" and len(calls) > 1: raise TimeoutError()',
      "        return types.SimpleNamespace(settimeout=lambda t: None, close=lambda: None), None",
      "    def request(c, token, req, pending=pending, reply=reply):",
      '        if "method" in req or pending == "slow": raise TimeoutError()',
      '        return reply if req["meta"] == "current_tab" else {"dialog": pending}',
      "    m.ipc = types.SimpleNamespace(connect=connect, request=request)",
      "    try: m.cdp('Page.navigate', session_id=session, url='x')",
      "    except TimeoutError as e: print('beforeunload dialog' in str(e), max(calls[1:], default=0))",
    ];
    const result = spawnSync(
      "python3",
      [
        "-c",
        driver.join("\n"),
        join(pkg, "helpers.py"),
        JSON.stringify(rows.map((row) => row.slice(0, 3))),
      ],
      { encoding: "utf8" },
    );
    expect(result.stdout.trim().split("\n")).toEqual(rows.map((row) => row[3]));
  },
);
