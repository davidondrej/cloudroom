import { describe, expect, it } from "vitest";
import { CloudThreadEvents, type CloudRecord } from "./cloud-timeline";

type Input = Omit<CloudRecord, "sequence" | "timestamp_ms">;

// The phone (Mac off) builds the desktop's chat items from the records the website passes on: receipts, states, text
// deltas, item records, and Codex's native frames. Desktop: gui/apps/server/test/services/cloudroom-items.test.ts.
function shown(records: Input[]) {
  const feed = new CloudThreadEvents("thr_test");
  const all: Input[] = [
    { kind: "receipt", data: { request_id: "t1", command: "prompt", state: "accepted", input: { text: "check" } } },
    { kind: "state", data: { state: "starting_turn", request_id: "t1" } },
    ...records,
  ];
  feed.add(all.map((record, index) => ({ ...record, sequence: index + 1, timestamp_ms: 1700000000000 + index })));
  return feed.events.flatMap(({ event }) => {
    if (event.type !== "item/started" && event.type !== "item/completed") return [];
    const item = event.item as { type: string; id: string; status?: string; tool?: string; text?: string };
    return [[event.type, item.type, item.id, item.status ?? item.text ?? "", item.tool ?? ""].join(" ").trim()];
  });
}

describe("Cloud thread items on the phone", () => {
  it("shows an ACP agent's replies, reasoning, and tool calls", () => {
    const base = { harness: "cursor", request_id: "t1" };
    const tool = { toolCallId: "tool", title: "Run pwd", kind: "execute", rawInput: { command: "pwd" } };
    expect(shown([
      { kind: "item_completed", data: { ...base, item_id: "think", item_type: "reasoning", text: "Plan" } },
      { kind: "item_started", data: { ...base, item_id: "msg", item_type: "agentMessage" } },
      { kind: "text_delta", data: { ...base, item_id: "msg", delta: "Hello" } },
      { kind: "item_completed", data: { ...base, item_id: "msg", item_type: "agentMessage", text: "Hello" } },
      { kind: "item_started", data: { ...base, item_id: "tool", tool: { ...tool, status: "pending" } } },
      { kind: "item_completed", data: { ...base, item_id: "tool", tool: { ...tool, status: "completed", rawOutput: { output: "/code" } } } },
    ])).toEqual([
      "item/completed reasoning t1:think",
      "item/started agentMessage t1:msg",
      "item/completed agentMessage t1:msg Hello",
      "item/started toolCall t1:tool pending Run pwd",
      "item/completed toolCall t1:tool completed Run pwd",
    ]);
  });

  it("shows Claude Code tool calls, and hides its server-side tool blocks like the desktop", () => {
    const base = { harness: "claude-code", request_id: "t1" };
    expect(shown([
      { kind: "item_started", data: { ...base, item_id: "tool", item_type: "tool_use", tool_name: "Bash", input: { command: "pwd" } } },
      { kind: "item_completed", data: { ...base, item_id: "tool", item_type: "tool_use", tool_name: "Bash", result: "/code", is_error: false } },
      { kind: "item_started", data: { ...base, item_id: "search", item_type: "server_tool_use", tool_name: "web_search" } },
      { kind: "item_completed", data: { ...base, item_id: "bad", item_type: "tool_use", is_error: true } },
    ])).toEqual([
      "item/started toolCall t1:tool pending Bash",
      "item/completed toolCall t1:tool completed Bash",
      "item/completed toolCall t1:bad failed Claude tool",
    ]);
  });

  it("shows Codex items from its native frames", () => {
    const frame = (method: string, params: object): Input => ({ kind: "item_completed", data: {}, native: { method, params } });
    expect(shown([
      frame("item/completed", { item: { type: "userMessage", id: "user", content: [] } }),
      frame("item/completed", { item: { type: "commandExecution", id: "cmd", command: "pwd", cwd: "/code", status: "completed", exitCode: null, commandActions: [] } }),
      frame("item/completed", { item: { type: "fileChange", id: "edit", status: "declined", changes: [{ path: "a.ts", kind: { type: "update" }, diff: "" }] } }),
      frame("item/started", { item: { type: "somethingNew", id: "odd" } }),
      frame("item/completed", { item: { type: "subAgentActivity", id: "child", agentThreadId: "child-thread" } }),
    ])).toEqual([
      "item/completed commandExecution t1:cmd completed",
      "item/completed fileChange t1:edit failed",
      "item/started toolCall t1:odd pending somethingNew",
    ]);
  });

  it("groups Pi's streamed text into one reply until a tool starts", () => {
    const base = { harness: "pi", request_id: "t1" };
    expect(shown([
      { kind: "text_delta", data: { ...base, delta: "Hel" } },
      { kind: "text_delta", data: { ...base, delta: "lo" } },
      { kind: "item_started", data: { ...base, item_id: "tool", tool_name: "bash" } },
    ])).toEqual([
      "item/started agentMessage t1:pi:3",
      "item/completed agentMessage t1:pi:3 Hello",
      "item/started toolCall t1:tool pending bash",
    ]);
  });
});
