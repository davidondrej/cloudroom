import {
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
import { PassThrough } from "node:stream";
import { afterEach, describe, expect, it } from "vitest";
import {
  BRIDGE_RECORDING_PROCESS_SCOPE,
  createBridgeRecorder,
  createRecordingLineSplitter,
  type BridgeRecordingEntry,
} from "./bridge-recorder.js";

let dir: string;

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

function readLane(scope: string, direction: string): BridgeRecordingEntry[] {
  return readFileSync(join(dir, scope, `${direction}.ndjson`), "utf8")
    .split("\n")
    .filter((line) => line.length > 0)
    .map((line) => JSON.parse(line) as BridgeRecordingEntry);
}

describe("bridge recorder", () => {
  it("routes responses to the scope of the request they answer", () => {
    dir = mkdtempSync(join(tmpdir(), "bb-bridge-recorder-"));
    const recorder = createBridgeRecorder({ dir });

    recorder.recordRuntimeLine(
      "runtime→bridge",
      JSON.stringify({
        jsonrpc: "2.0",
        id: 1,
        method: "initialize",
        params: {},
      }),
    );
    recorder.recordRuntimeLine(
      "bridge→runtime",
      JSON.stringify({ jsonrpc: "2.0", id: 1, result: { protocolVersion: 1 } }),
    );
    recorder.recordRuntimeLine(
      "runtime→bridge",
      JSON.stringify({
        jsonrpc: "2.0",
        id: 2,
        method: "thread/start",
        params: { threadId: "thr_a" },
      }),
    );
    recorder.recordRuntimeLine(
      "bridge→runtime",
      JSON.stringify({
        jsonrpc: "2.0",
        id: "br-7",
        method: "interaction/request",
        params: { threadId: "thr_a" },
      }),
    );
    recorder.recordRuntimeLine(
      "runtime→bridge",
      JSON.stringify({
        jsonrpc: "2.0",
        id: "br-7",
        result: { decision: "allow" },
      }),
    );
    recorder.recordRuntimeLine(
      "bridge→runtime",
      JSON.stringify({
        jsonrpc: "2.0",
        id: 2,
        result: { providerThreadId: "p" },
      }),
    );
    recorder.recordRuntimeLine(
      "bridge→runtime",
      JSON.stringify({
        jsonrpc: "2.0",
        method: "thread/delta",
        params: { threadId: "thr_a", deltas: [] },
      }),
    );
    recorder.close();

    expect(readdirSync(dir).sort()).toEqual([
      BRIDGE_RECORDING_PROCESS_SCOPE,
      "thr_a",
    ]);
    expect(
      readLane(BRIDGE_RECORDING_PROCESS_SCOPE, "runtime→bridge").map(
        (entry) => JSON.parse(entry.line).method,
      ),
    ).toEqual(["initialize"]);
    expect(
      readLane(BRIDGE_RECORDING_PROCESS_SCOPE, "bridge→runtime").map(
        (entry) => JSON.parse(entry.line).id,
      ),
    ).toEqual([1]);
    expect(
      readLane("thr_a", "runtime→bridge").map(
        (entry) => JSON.parse(entry.line).id,
      ),
    ).toEqual([2, "br-7"]);
    const outbound = readLane("thr_a", "bridge→runtime");
    expect(outbound.map((entry) => JSON.parse(entry.line).id)).toEqual([
      "br-7",
      2,
      undefined,
    ]);
    const all = [
      ...readLane(BRIDGE_RECORDING_PROCESS_SCOPE, "runtime→bridge"),
      ...readLane(BRIDGE_RECORDING_PROCESS_SCOPE, "bridge→runtime"),
      ...readLane("thr_a", "runtime→bridge"),
      ...outbound,
    ]
      .sort((left, right) => left.seq - right.seq)
      .map((entry) => entry.seq);
    expect(all).toEqual([1, 2, 3, 4, 5, 6, 7]);
  });

  it("tees a child's stdout and stdin writes as provider lanes", () => {
    dir = mkdtempSync(join(tmpdir(), "bb-bridge-recorder-"));
    const recorder = createBridgeRecorder({ dir });
    const stdin = new PassThrough();
    const stdout = new PassThrough();
    recorder.recordChildIo({ stdin, stdout }, { threadId: "thr_b" });

    stdin.write('{"jsonrpc":"2.0","id":1,"method":"initialize"}\n');
    stdout.write('{"jsonrpc":"2.0",');
    stdout.write(
      '"id":1,"result":{}}\n{"jsonrpc":"2.0","method":"turn/started"}\n',
    );
    recorder.close();

    expect(
      readLane("thr_b", "bridge→provider").map((entry) => entry.line),
    ).toEqual(['{"jsonrpc":"2.0","id":1,"method":"initialize"}']);
    expect(
      readLane("thr_b", "provider→bridge").map((entry) => entry.line),
    ).toEqual([
      '{"jsonrpc":"2.0","id":1,"result":{}}',
      '{"jsonrpc":"2.0","method":"turn/started"}',
    ]);
  });

  it("masks credentials and keeps recordings owner-only", () => {
    dir = mkdtempSync(join(tmpdir(), "bb-bridge-recorder-"));
    // An older run left a world-readable scope folder and lane behind.
    mkdirSync(join(dir, "thr_old"), { mode: 0o755 });
    writeFileSync(join(dir, "thr_old", "bridge→provider.ndjson"), "", {
      mode: 0o644,
    });
    const fakeOauth = "fake-oauth-token-0123456789abcdef";
    const fakeAccess = "fake-access-token-0123456789abcdef";
    const fakeBearer = "fakebearer0123456789abcdef";
    const plain = '{"jsonrpc":"2.0", "method":"turn/started","params":{}}';
    const recorder = createBridgeRecorder({ dir });

    recorder.recordRuntimeLine(
      "runtime→bridge",
      JSON.stringify({
        id: 1,
        method: "thread/start",
        params: {
          threadId: "thr_new",
          config: {
            envVars: { CLAUDE_CODE_OAUTH_TOKEN: fakeOauth, LANG: "C" },
          },
        },
      }),
    );
    recorder.record({
      direction: "bridge→provider",
      threadId: "thr_old",
      line: JSON.stringify({
        method: "account/login/start",
        params: { accessToken: fakeAccess, chatgptAccountId: "acct_1" },
      }),
    });
    recorder.record({
      direction: "bridge→provider",
      threadId: "thr_old",
      line: `Authorization: Bearer ${fakeBearer}`,
    });
    recorder.record({
      direction: "provider→bridge",
      threadId: "thr_new",
      line: plain,
    });
    recorder.close();

    const lanes = [
      ["thr_new", "runtime→bridge"],
      ["thr_new", "provider→bridge"],
      ["thr_old", "bridge→provider"],
    ] as const;
    const text = lanes
      .map(([scope, lane]) =>
        readFileSync(join(dir, scope, `${lane}.ndjson`), "utf8"),
      )
      .join("");
    for (const secret of [fakeOauth, fakeAccess, fakeBearer]) {
      expect(text).not.toContain(secret);
    }
    expect(text).toContain("LANG");
    expect(text).toContain("acct_1");
    expect(readLane("thr_new", "provider→bridge")[0]?.line).toBe(plain);

    if (process.platform !== "win32") {
      for (const scope of ["thr_new", "thr_old"]) {
        expect(statSync(join(dir, scope)).mode & 0o777).toBe(0o700);
      }
      for (const [scope, lane] of lanes) {
        expect(statSync(join(dir, scope, `${lane}.ndjson`)).mode & 0o777).toBe(
          0o600,
        );
      }
    }
  });

  it("stays fast on long whitespace and never writes a line it cannot mask", () => {
    dir = mkdtempSync(join(tmpdir(), "bb-bridge-recorder-"));
    const recorder = createBridgeRecorder({ dir });
    const fakeAccess = "fake-access-token-0123456789abcdef";
    const spaced = `{"a":1${" ".repeat(1_000_000)}}`;
    const started = performance.now();
    recorder.record({
      direction: "provider→bridge",
      threadId: null,
      line: spaced,
    });
    expect(performance.now() - started).toBeLessThan(500);
    const deep = `{"accessToken":"${fakeAccess}","x":${"[".repeat(100_000)}${"]".repeat(100_000)}}`;
    recorder.record({
      direction: "bridge→provider",
      threadId: null,
      line: deep,
    });
    recorder.close();

    expect(
      readLane(BRIDGE_RECORDING_PROCESS_SCOPE, "provider→bridge")[0]?.line,
    ).toBe(spaced);
    expect(
      readLane(BRIDGE_RECORDING_PROCESS_SCOPE, "bridge→provider")[0]?.line,
    ).toBe('{"redacted":"unparseable"}');
  });

  it("drops an oversized line instead of holding it", () => {
    const lines: string[] = [];
    const splitter = createRecordingLineSplitter((line) => lines.push(line), 8);
    splitter.push("short\n");
    splitter.push("this line is far too long");
    splitter.push(" and keeps going\nafter\n");
    expect(lines).toEqual(["short", "after"]);
  });
});
