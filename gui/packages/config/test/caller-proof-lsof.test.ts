import { execFile } from "node:child_process";
import { EventEmitter } from "node:events";
import { afterEach, expect, it, vi } from "vitest";
import {
  checkOpenWithoutCallerProof,
  isOpenWithoutCallerProof,
} from "../src/caller-proof.js";

vi.mock("node:child_process", () => ({ execFile: vi.fn() }));

type Done = (error: unknown, stdout: string, stderr?: string) => void;
const platform = process.platform;

afterEach(() => {
  vi.restoreAllMocks();
  vi.useRealTimers();
  Object.defineProperty(process, "platform", { value: platform });
});

it.skipIf(process.getuid === undefined)(
  "a stuck macOS lsof refuses reads without hanging, locking out the socket or starting another (#2203)",
  async () => {
    vi.useFakeTimers();
    Object.defineProperty(process, "platform", { value: "darwin" });
    // Each lsof only exits ("close") or calls back when the test says so.
    const runs: Array<{ child: EventEmitter; done: Done }> = [];
    vi.mocked(execFile).mockImplementation(((...args: unknown[]) => {
      const child = new EventEmitter();
      runs.push({ child, done: args.at(-1) as Done });
      return child;
    }) as never);
    const socket = (remotePort: number) => ({
      localAddress: "127.0.0.1",
      localPort: 39886,
      remoteAddress: "127.0.0.1",
      remotePort,
    });
    const read = (peer: ReturnType<typeof socket>) =>
      isOpenWithoutCallerProof("GET", "/api/v1/threads", peer);
    const kept = socket(50001);

    // Stuck in the kernel: the run's own read and one queued behind it drain.
    const first = read(kept);
    await vi.advanceTimersByTimeAsync(0);
    const queued = read(socket(50002));
    await vi.advanceTimersByTimeAsync(6_000);
    await expect(first).resolves.toBe(false);
    await expect(queued).resolves.toBe(false);
    // No answer is "unanswered", so the server says busy, not sandboxed (#2435).
    await expect(
      checkOpenWithoutCallerProof("GET", "/api/v1/threads", socket(50006)),
    ).resolves.toBe("unanswered");
    // While it is still stuck, reads are refused at once without another lsof.
    await expect(read(socket(50003))).resolves.toBe(false);
    // A kill that failed calls back early, but lsof is alive: no second run.
    runs[0]!.done(Object.assign(new Error("kill"), { code: "EPERM" }), "");
    await expect(read(socket(50004))).resolves.toBe(false);
    expect(runs).toHaveLength(1);

    // Once it exits, the same keep-alive socket is checked again and passes.
    runs[0]!.child.emit("close");
    const again = read(kept);
    await vi.advanceTimersByTimeAsync(0);
    expect(runs).toHaveLength(2);
    runs[1]!.done(null, "p1\nn127.0.0.1:50001->127.0.0.1:39886\n");
    runs[1]!.child.emit("close");
    await expect(again).resolves.toBe(true);

    // One that never exits gives its slot up 30 s after the kill: a new lookup runs.
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const later = socket(50005);
    void read(later);
    await vi.advanceTimersByTimeAsync(35_000);
    expect(runs).toHaveLength(3);
    expect(warn).toHaveBeenCalledTimes(1);
    const fresh = read(later);
    await vi.advanceTimersByTimeAsync(0);
    expect(runs).toHaveLength(4);
    runs[3]!.done(null, "p1\nn127.0.0.1:50005->127.0.0.1:39886\n");
    await expect(fresh).resolves.toBe(true);

    // A listing without the caller (another user, say) is still a refusal.
    const other = checkOpenWithoutCallerProof(
      "GET",
      "/api/v1/threads",
      socket(50007),
    );
    runs[3]!.child.emit("close");
    await vi.advanceTimersByTimeAsync(0);
    runs[4]!.done(null, "p1\n");
    await expect(other).resolves.toBe("refused");

    // An lsof that couldn't list processes says busy, and stays refused on that socket.
    const failed = socket(50008);
    const busy = checkOpenWithoutCallerProof("GET", "/api/v1/threads", failed);
    runs[4]!.child.emit("close");
    await vi.advanceTimersByTimeAsync(0);
    runs[5]!.done(
      Object.assign(new Error("exit 1"), { code: 1 }),
      "",
      "lsof: can't get PID list: Operation not permitted\n",
    );
    await expect(busy).resolves.toBe("unanswered");
    await expect(
      checkOpenWithoutCallerProof("GET", "/api/v1/threads", failed),
    ).resolves.toBe("unanswered");
    expect(runs).toHaveLength(6);
  },
);
