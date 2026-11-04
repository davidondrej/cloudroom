import { describe, expect, it } from "vitest";
import {
  parseCompressedBytes,
  parseTopFootprints,
  threadOverLimit,
} from "./memory-guard.js";

const GIB = 2 ** 30;
const URL = "http://127.0.0.1:39886";
const tags = (threadId: string, url = URL) => [
  `ROOM_THREAD_ID=${threadId}`,
  `ROOM_SERVER_URL=${url}`,
];
const row = (pid: number, env: string[], exe?: string) => ({
  pid,
  ppid: 1,
  env,
  started: "1",
  ...(exe ? { exe } : {}),
});

describe("memory guard", () => {
  it("reads compressed memory from vm_stat and footprints from top", () => {
    expect(
      parseCompressedBytes(
        "Mach Virtual Memory Statistics: (page size of 16384 bytes)\n" +
          "Pages free:                                  912.\n" +
          "Pages stored in compressor:             35000000.\n",
      ),
    ).toBe(35_000_000 * 16_384);
    expect(parseCompressedBytes("garbage")).toBeNull();
    expect(
      parseTopFootprints(
        "Processes: 991 total\n\nPID    MEM\n50007  246G+\n633    1116M\n1318   480K-\n9      N/A\n",
      ),
    ).toEqual(
      new Map([
        [50007, 246 * GIB],
        [633, 1116 * 2 ** 20],
        [1318, 480 * 2 ** 10],
      ]),
    );
  });

  it("names the thread from the 2026-11-02 panic, and nothing else", () => {
    // Footprints from the panic report: one thread's git processes held 600+ GB
    // on a 128 GB Mac, next to a normal thread, an app, and another profile.
    const rows = [
      row(39953, tags("thr_k678gz6mvd")),
      row(50007, tags("thr_k678gz6mvd")),
      row(50501, tags("thr_k678gz6mvd")),
      row(50815, tags("thr_k678gz6mvd")),
      row(6116, tags("thr_7vq6edxw74")),
      row(633, []),
      row(700, tags("thr_otherprofile", "http://127.0.0.1:1")),
      row(
        800,
        tags("thr_ollama"),
        "/Applications/Ollama.app/Contents/MacOS/Ollama",
      ),
    ];
    const footprints = new Map([
      [39953, 0.2 * GIB],
      [50007, 246.55 * GIB],
      [50501, 191.42 * GIB],
      [50815, 164.14 * GIB],
      [6116, 2 * GIB],
      [633, 1.09 * GIB],
      [700, 900 * GIB],
      [800, 900 * GIB],
    ]);
    const limitBytes = 64 * GIB;
    const hit = threadOverLimit({
      rows,
      footprints,
      serverUrl: URL,
      limitBytes,
    });
    expect(hit?.threadId).toBe("thr_k678gz6mvd");
    expect(hit?.usedBytes).toBeCloseTo((0.2 + 246.55 + 191.42 + 164.14) * GIB);
    // An installed app is never killed, so it never counts, and a thread that
    // was just killed never hides the next offender.
    expect(
      threadOverLimit({
        rows,
        footprints,
        serverUrl: URL,
        limitBytes,
        skipThreadIds: new Set(["thr_k678gz6mvd"]),
      }),
    ).toBeNull();
    // A busy but normal thread stays untouched.
    expect(
      threadOverLimit({
        rows: rows.filter((r) => r.pid === 6116),
        footprints,
        serverUrl: URL,
        limitBytes,
      }),
    ).toBeNull();
  });
});
