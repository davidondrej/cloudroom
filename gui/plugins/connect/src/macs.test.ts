import { afterEach, describe, expect, it, vi } from "vitest";
import { SetupJobs } from "./macs.js";

afterEach(() => {
  vi.unstubAllEnvs();
});

async function finished(jobs: SetupJobs, jobId: string) {
  let output = "";
  for (;;) {
    const status = jobs.status(jobId, output.length);
    output += status.output;
    if (status.exitCode !== null) return { output, exitCode: status.exitCode };
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
}

describe("setup jobs another Mac starts here", () => {
  it("runs the installer with stdin, reports output and exit code, and keeps Cloudroom's own settings out", async () => {
    vi.stubEnv("BB_DATA_DIR", "/Users/me/.cloudroom");
    vi.stubEnv("ROOM_THREAD_ID", "thr_secret");
    const jobs = new SetupJobs();
    const { jobId } = jobs.start(
      ["sh", "-c", 'cat; echo "data=${BB_DATA_DIR:-none} thread=${ROOM_THREAD_ID:-none}"; exit 3'],
      "payload\n",
    );
    expect(() => jobs.start(["sh", "-c", "true"], "")).toThrow(/already being set up/);
    expect(await finished(jobs, jobId)).toEqual({
      output: "payload\ndata=none thread=none\n",
      exitCode: 3,
    });
    expect(() => jobs.status("nope", 0)).toThrow(/Unknown setup job/);
  });
});
