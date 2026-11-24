import { afterEach, beforeEach, expect, it } from "vitest";
import {
  FULL_PERMISSION_OPTIONS,
  type FakePiBridgeHarness,
  startFakePiBridge,
} from "./test-support.js";

const THREAD_ID = "thr_compactnoop";

let harness: FakePiBridgeHarness;

beforeEach(async () => {
  harness = await startFakePiBridge({
    prefix: "bb-pi-compaction-",
    initialize: true,
  });
});

afterEach(async () => {
  await harness.teardown();
});

it("reports a refused manual compaction as skipped, after the compaction_end delivery", async () => {
  await harness.request(2, "thread/start", {
    threadId: THREAD_ID,
    cwd: harness.workspaceDir,
    instructionMode: "append",
    options: FULL_PERMISSION_OPTIONS,
  });
  await harness.request(3, "turn/start", {
    threadId: THREAD_ID,
    providerThreadId: THREAD_ID,
    clientRequestId: "creq_cmpctnpabc",
    input: [
      {
        type: "text",
        text: "/compact",
        mentions: [
          {
            start: 0,
            end: 8,
            resource: {
              kind: "command",
              trigger: "/",
              name: "compact",
              source: "command",
              origin: "builtin",
              label: "compact",
              argumentHint: null,
            },
          },
        ],
      },
    ],
    options: FULL_PERMISSION_OPTIONS,
  });
  await harness.waitFor(
    () =>
      harness.deltasOf(THREAD_ID).filter((d) => d.kind === "turn.boundary")
        .length >= 2,
    "both turn boundaries",
  );

  const kinds = harness
    .deltasOf(THREAD_ID)
    .map((d) =>
      d.kind === "turn.boundary"
        ? `turn.boundary:${String(d.status)}`
        : String(d.kind),
    );
  const warning = harness
    .deltasOf(THREAD_ID)
    .find((d) => d.kind === "provider.warning");
  expect(warning).toMatchObject({ category: "compaction-skipped" });
  expect(kinds.indexOf("provider.warning")).toBeLessThan(
    kinds.indexOf("turn.boundary:completed"),
  );
  expect(kinds.filter((k) => k.startsWith("turn.boundary"))).toEqual([
    "turn.boundary:completed",
    "turn.boundary:completed",
  ]);
}, 30_000);

it.each([
  ["/overflow-fail", "failed"],
  ["/overflow-retry", "completed"],
])(
  "settles %s after Pi's overflow compaction as %s",
  async (text, status) => {
    await harness.startThread(THREAD_ID);
    await harness.request(3, "turn/start", {
      threadId: THREAD_ID,
      providerThreadId: THREAD_ID,
      clientRequestId: "creq_vrfwabcdeg",
      input: [{ type: "text", text }],
      options: FULL_PERMISSION_OPTIONS,
    });
    const settlements = () =>
      harness
        .deltasOf(THREAD_ID)
        .filter((d) => d.kind === "turn.boundary" || d.settlesTurn === true);
    await harness.waitFor(() => settlements().length >= 2, "run and prompt");

    expect(settlements().map((d) => d.status ?? "failed")).toEqual([
      status,
      status,
    ]);
    if (status === "failed") {
      expect(settlements()[0]).toMatchObject({
        detail: expect.stringContaining("Context overflow recovery failed"),
      });
    }
  },
  30_000,
);
