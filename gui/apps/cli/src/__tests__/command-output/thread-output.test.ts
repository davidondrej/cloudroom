import { describe, expect, it, vi } from "vitest";
import {
  collectLogLines,
  setupCommandOutputTestEnvironment,
  runCommand,
  stubServerApi,
} from "../helpers/command-output-harness.js";
import type { CommandRegistrar } from "../helpers/command-output-harness.js";
import * as fixtures from "../helpers/command-output-fixtures.js";
import { registerThreadCommands } from "../../commands/thread/index.js";

describe("room-cli thread output command output", () => {
  setupCommandOutputTestEnvironment();

  const register: CommandRegistrar = (program) =>
    registerThreadCommands(program, () => "http://server");

  it("room-cli thread output requires a thread id or --self", async () => {
    vi.stubEnv("ROOM_THREAD_ID", "thread-output-context");
    const getOutput = vi.fn(async () => ({ output: "FINAL" }));
    stubServerApi({ "v1.threads.:id.output.$get": getOutput });

    await expect(runCommand(["thread", "output"], register)).rejects.toThrow(
      "process.exit:1",
    );

    expect(getOutput).not.toHaveBeenCalled();
    expect(collectLogLines(vi.mocked(console.error))).toContain(
      "Error: Missing thread ID. Pass <threadId> or use --self.",
    );
  });

  it("room-cli thread output --self resolves from ROOM_THREAD_ID", async () => {
    vi.stubEnv("ROOM_THREAD_ID", "thread-output-context");
    const getOutput = vi.fn(async () => ({ output: "FINAL" }));
    stubServerApi({ "v1.threads.:id.output.$get": getOutput });

    await runCommand(["thread", "output", "--self"], register);

    expect(getOutput).toHaveBeenCalledWith({
      param: { id: "thread-output-context" },
    });
    expect(collectLogLines(vi.mocked(console.error))).not.toContain(
      "Thread thread-output-context (from ROOM_THREAD_ID)",
    );
    expect(collectLogLines(vi.mocked(console.log))).toContain("FINAL");
  });

  it("room-cli thread output --json prints the raw output payload", async () => {
    const getOutput = vi.fn(async () => ({ output: "FINAL" }));
    stubServerApi({ "v1.threads.:id.output.$get": getOutput });

    await runCommand(
      ["thread", "output", "thread-json-output", "--json"],
      register,
    );

    expect(
      JSON.parse(String(vi.mocked(console.log).mock.calls[0]?.[0])),
    ).toEqual({
      output: "FINAL",
    });
  });

  it("room-cli thread output <id> prints only the final output", async () => {
    const getOutput = vi.fn(async () => ({ output: "FINAL" }));
    const getTimeline = vi.fn(async () => fixtures.makeTimelineResponse([]));
    stubServerApi({
      "v1.threads.:id.output.$get": getOutput,
      "v1.threads.:id.timeline.$get": getTimeline,
    });

    await runCommand(["thread", "output", "thread-plain"], register);

    expect(getOutput).toHaveBeenCalledWith({ param: { id: "thread-plain" } });
    expect(getTimeline).not.toHaveBeenCalled();
    expect(collectLogLines(vi.mocked(console.log))).toContain("FINAL");
  });

  it("room-cli thread output --all walks older timeline pages and prints the whole thread", async () => {
    const makeUserRow = (id: string, seq: number, text: string) => ({
      ...fixtures.makePendingSteerTimelineRow(),
      ...fixtures.makeTimelineBase({ id, sourceSeqStart: seq }),
      text,
      turnRequest: {
        isGrouped: false,
        kind: "message" as const,
        status: "accepted" as const,
      },
    });
    const getOutput = vi.fn(async () => ({ output: "FINAL" }));
    const getTimeline = vi.fn(
      async (input: {
        query: { beforeAnchorSeq?: string; beforeAnchorId?: string };
      }) => {
        if (input.query.beforeAnchorSeq === undefined) {
          return {
            ...fixtures.makeTimelineResponse([
              makeUserRow("user-2", 20, "second prompt"),
            ]),
            timelinePage: {
              kind: "latest" as const,
              segmentLimit: 100,
              returnedSegmentCount: 1,
              hasOlderRows: true,
              olderCursor: { anchorSeq: 20, anchorId: "user-2" },
            },
          };
        }
        return {
          ...fixtures.makeTimelineResponse([
            makeUserRow("user-1", 10, "first prompt"),
          ]),
          timelinePage: {
            kind: "older" as const,
            segmentLimit: 100,
            returnedSegmentCount: 1,
            hasOlderRows: false,
            olderCursor: null,
          },
        };
      },
    );
    stubServerApi({
      "v1.threads.:id.output.$get": getOutput,
      "v1.threads.:id.timeline.$get": getTimeline,
    });

    await runCommand(["thread", "output", "thread-all", "--all"], register);

    expect(getOutput).not.toHaveBeenCalled();
    expect(getTimeline.mock.calls.map((call) => call[0].query)).toEqual([
      { segmentLimit: "100" },
      { segmentLimit: "100", beforeAnchorSeq: "20", beforeAnchorId: "user-2" },
    ]);
    const output = String(vi.mocked(console.log).mock.calls[0]?.[0]);
    expect(output.indexOf("first prompt")).toBeGreaterThan(-1);
    expect(output.indexOf("first prompt")).toBeLessThan(
      output.indexOf("second prompt"),
    );
    expect(output).not.toContain("older history omitted");
  });

  it("room-cli thread output --all --json pages through every event and prints JSON", async () => {
    const events = Array.from({ length: 102 }, (_, index) => ({
      id: `evt-${index + 1}`,
      scope: { kind: "thread" },
      threadId: "thread-all-json",
      type: "system/error",
      data: { code: "provider_unavailable" },
      createdAt: 20 + index,
      seq: index + 1,
    }));
    const getOutput = vi.fn(async () => ({ output: "FINAL" }));
    const getEvents = vi.fn(
      async (input: { query: { afterSeq?: string; limit?: string } }) => {
        const afterSeq = Number(input.query.afterSeq ?? 0);
        const limit = Math.min(Number(input.query.limit), 100);
        return events.filter((event) => event.seq > afterSeq).slice(0, limit);
      },
    );
    stubServerApi({
      "v1.threads.:id.output.$get": getOutput,
      "v1.threads.:id.events.$get": getEvents,
    });

    await runCommand(
      ["thread", "output", "thread-all-json", "--all", "--json"],
      register,
    );

    expect(getOutput).not.toHaveBeenCalled();
    const printed = JSON.parse(
      String(vi.mocked(console.log).mock.calls[0]?.[0]),
    ) as Array<{ seq: number }>;
    expect(printed).toHaveLength(102);
    expect(printed[0]?.seq).toBe(1);
    expect(printed[101]?.seq).toBe(102);
    expect(collectLogLines(vi.mocked(console.error))).toEqual([]);
  });
});
