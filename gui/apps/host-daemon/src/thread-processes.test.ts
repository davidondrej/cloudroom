import { execFileSync } from "node:child_process";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  macRows,
  pickThreadProcesses,
  stopThreadProcesses,
  type ProcessRow,
} from "./thread-processes.js";

const URL = "http://127.0.0.1:1";
const tags = (id: string, url = URL) => [
  "PATH=/bin",
  `ROOM_THREAD_ID=${id}`,
  `ROOM_SERVER_URL=${url}`,
];
const row = (pid: number, ppid: number, env: string[], exe?: string) => ({
  pid,
  ppid,
  env,
  started: "1",
  ...(exe ? { exe } : {}),
});

afterEach(() => vi.restoreAllMocks());

describe("pickThreadProcesses", () => {
  it("picks only what escaped, never apps, the harness tree, or the daemon's ancestors", () => {
    const rows = [
      row(1, 0, []),
      row(10, 1, tags("thr_abc")),
      row(20, 10, []),
      row(30, 20, []),
      row(40, 30, tags("thr_abc")),
      row(41, 40, tags("thr_abc")),
      row(50, 1, tags("thr_abc")),
      row(51, 1, tags("thr_abcd")),
      row(52, 1, []),
      row(
        53,
        1,
        tags("thr_abc"),
        "/Applications/Ollama.app/Contents/MacOS/Ollama",
      ),
      row(54, 1, tags("thr_abc", "http://127.0.0.1:2")),
      row(
        56,
        1,
        tags("thr_abc"),
        "/opt/homebrew/Cellar/python@3.15/3.15.0_1/Frameworks/Python.framework/Versions/3.15/Resources/Python.app/Contents/MacOS/Python",
      ),
      row(55, 1, ["FOO=x ROOM_THREAD_ID=thr_abc", `ROOM_SERVER_URL=${URL}`]),
    ];
    const pick = (threadId: string, serverUrl: string | undefined) =>
      pickThreadProcesses(rows, { threadId, serverUrl, selfPid: 20 }).map(
        (picked) => picked.pid,
      );
    expect(pick("thr_abc", URL)).toEqual([50, 56]);
    // The memory guard also kills what still runs under the daemon, but never
    // the daemon's own line, another thread, or another profile's processes.
    expect(
      pickThreadProcesses(rows, {
        threadId: "thr_abc",
        serverUrl: URL,
        selfPid: 20,
        includeLive: true,
      }).map((picked) => picked.pid),
    ).toEqual([40, 41, 50, 56]);
    expect(pick("not a thread", URL)).toEqual([]);
    expect(pick("thr_abc", undefined)).toEqual([]);
    expect(pick("thr_abc", "")).toEqual([]);
  });

  it("reads macOS environments without the command line", () => {
    const command = `grep ROOM_THREAD_ID=thr_abc ROOM_SERVER_URL=${URL}`;
    const rows = macRows(
      new Map([[7, "    1 Mon Nov  2 04:27:48 2026 /usr/bin/grep"]]),
      new Map([[7, command]]),
      new Map([[7, `${command} PATH=/bin ROOM_THREAD_ID=thr_other`]]),
    );
    expect(rows).toEqual([
      {
        pid: 7,
        ppid: 1,
        env: ["PATH=/bin", "ROOM_THREAD_ID=thr_other"],
        started: "Mon Nov  2 04:27:48 2026",
        exe: "/usr/bin/grep",
      },
    ]);
    expect(
      pickThreadProcesses(rows, {
        threadId: "thr_abc",
        serverUrl: URL,
        selfPid: 99,
      }),
    ).toEqual([]);
  });
});

describe("stopThreadProcesses", () => {
  it("never signals a process ID that now belongs to another process", async () => {
    const kill = vi.spyOn(process, "kill").mockImplementation(() => true);
    const escaped: ProcessRow = row(4242, 1, tags("thr_abc"));
    const table = {
      list: async () => [escaped],
      started: async () => new Map([[4242, "2"]]),
    };
    expect(await stopThreadProcesses("thr_abc", URL, table)).toBe(0);
    expect(kill).not.toHaveBeenCalled();
  });

  it.runIf(process.platform === "linux")(
    "stops a server that escaped with nohup",
    async () => {
      const env = {
        ...process.env,
        ROOM_THREAD_ID: "thr_processtest",
        ROOM_SERVER_URL: URL,
      };
      const pid = Number(
        execFileSync("sh", ["-c", "nohup sleep 60 >/dev/null 2>&1 & echo $!"], {
          env,
        }).toString(),
      );
      const alive = () => {
        try {
          process.kill(pid, 0);
          return true;
        } catch {
          return false;
        }
      };
      expect(alive()).toBe(true);
      expect(await stopThreadProcesses("thr_processtest", URL)).toBe(1);
      expect(alive()).toBe(false);
    },
  );
});
