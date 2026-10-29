import { execFile } from "node:child_process";

export type HerdrAgentState = "idle" | "working" | "blocked";

export interface HerdrReporter {
  report(state: HerdrAgentState, message?: string): void;
  release(): Promise<void>;
}

const SOURCE = "cloudroom";
const REPORT_TIMEOUT_MS = 2000;

export function createHerdrReporter(args: {
  sessionId: string;
  resumeArgv: readonly string[];
}): HerdrReporter | null {
  const bin = process.env.HERDR_BIN_PATH;
  const pane = process.env.HERDR_PANE_ID;
  if (process.env.HERDR_ENV !== "1" || !bin || !pane) return null;

  let seq = 0;
  let lastReport = "";
  const run = (command: string, extra: readonly string[]) => {
    seq = Math.max(seq + 1, Date.now());
    const argv = ["pane", command, pane, "--source", SOURCE, "--agent", SOURCE];
    return new Promise<void>((resolve) => {
      execFile(bin, [...argv, "--seq", String(seq), ...extra], { timeout: REPORT_TIMEOUT_MS }, () =>
        resolve(),
      );
    });
  };

  return {
    report(state, message) {
      const key = `${state}\n${message ?? ""}`;
      if (key === lastReport) return;
      lastReport = key;
      void run("report-agent", [
        "--state",
        state,
        ...(message ? ["--message", message] : []),
        "--agent-session-id",
        args.sessionId,
        "--",
        ...args.resumeArgv,
      ]);
    },
    release: () => run("release-agent", []),
  };
}
