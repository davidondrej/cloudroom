// #1248: streamed pieces of one item are joined before they are saved. The timeline must show exactly what it
// showed when every piece was its own event.
import {
  buildThreadEventRow,
  joinStreamDeltas,
  threadEventSchema,
  turnScope,
  type ThreadEvent,
} from "@cloudroom/domain";
import { describe, expect, it } from "vitest";
import { renderTimelineFixture } from "./timeline-test-harness.js";

const THREAD_ID = "thr_join";
const TURN_ID = "turn-1";
const base = {
  threadId: THREAD_ID,
  providerThreadId: "provider-1",
  scope: turnScope(TURN_ID),
};

/** What the daemon's sink and the Cloud stream do: join each event onto the one before it when that is allowed. */
function joinInOrder(events: readonly ThreadEvent[]): ThreadEvent[] {
  const joined: ThreadEvent[] = [];
  for (const event of events) {
    const last = joined.at(-1);
    const both = last ? joinStreamDeltas(last, event) : null;
    if (both) joined[joined.length - 1] = both;
    else joined.push(event);
  }
  return joined;
}

function render(events: readonly ThreadEvent[], threadStatus: "active" | "idle") {
  const rendered = renderTimelineFixture({
    events: events.map((event, index) =>
      buildThreadEventRow({
        id: `evt-${index}`,
        threadId: THREAD_ID,
        seq: index + 1,
        // One clock tick for every event, so nothing shown depends on how many rows a stream took.
        createdAt: 1_000,
        scope: event.scope,
        event,
      }),
    ),
    projectionOptions: { threadStatus, turnMessageDetail: "full" },
  });
  return {
    text: rendered.text,
    // The projected messages without the fields that count rows.
    messages: JSON.parse(
      JSON.stringify(rendered.messages, (key, value: unknown) =>
        ["id", "sourceSeqStart", "sourceSeqEnd", "sourceSeq", "seq"].includes(key)
          ? undefined
          : value,
      ),
    ) as unknown,
  };
}

function event(value: Record<string, unknown>): ThreadEvent {
  return threadEventSchema.parse({ ...base, ...value });
}

const delta = (
  type: string,
  itemId: string,
  text: string,
  extra: Record<string, unknown> = {},
) => event({ type, itemId, delta: text, ...extra });

const item = (type: "item/started" | "item/completed", value: Record<string, unknown>) =>
  event({ type, item: value });

function command(id: string, status: "pending" | "completed", output: string) {
  return {
    type: "commandExecution",
    id,
    command: "/bin/zsh -lc 'pnpm test'",
    cwd: "/repo",
    status,
    approvalStatus: null,
    aggregatedOutput: output,
    ...(status === "completed" ? { exitCode: 0, durationMs: 10 } : {}),
  };
}

function expectSameTimeline(events: readonly ThreadEvent[]) {
  const joined = joinInOrder(events);
  for (const threadStatus of ["active", "idle"] as const) {
    expect(render(joined, threadStatus)).toEqual(render(events, threadStatus));
  }
  return joined;
}

describe("joined streamed pieces show the same timeline", () => {
  it("joins the pieces of a reply into one event", () => {
    const events = [
      event({ type: "turn/started" }),
      item("item/started", { type: "agentMessage", id: "msg", text: "" }),
      delta("item/agentMessage/delta", "msg", "First line\nSecond "),
      delta("item/agentMessage/delta", "msg", "line\nThird"),
      delta("item/agentMessage/delta", "msg", " line, unfinished"),
    ];

    const joined = expectSameTimeline(events);

    expect(joined).toHaveLength(3);
    expect(render(joined, "active").text).toContain("Second line");
  });

  it("keeps a reset of command output apart, so old output does not come back", () => {
    const events = [
      event({ type: "turn/started" }),
      item("item/started", command("cmd", "pending", "")),
      delta("item/commandExecution/outputDelta", "cmd", "old 1\n"),
      delta("item/commandExecution/outputDelta", "cmd", "old 2\n"),
      delta("item/commandExecution/outputDelta", "cmd", "new 1\n", { reset: true }),
      delta("item/commandExecution/outputDelta", "cmd", "new 2\n"),
    ];

    const joined = expectSameTimeline(events);

    expect(joined.slice(2)).toEqual([
      delta("item/commandExecution/outputDelta", "cmd", "old 1\nold 2\n"),
      delta("item/commandExecution/outputDelta", "cmd", "new 1\nnew 2\n", { reset: true }),
    ]);
  });

  it("keeps text that an interruption cut off, and the text of a nested agent, where they were", () => {
    expectSameTimeline([
      event({ type: "turn/started" }),
      item("item/started", { type: "agentMessage", id: "msg", text: "" }),
      delta("item/agentMessage/delta", "msg", "Half a "),
      delta("item/agentMessage/delta", "msg", "sentence\nand"),
      // The same item ID under a tool call is another message.
      delta("item/agentMessage/delta", "msg", "nested ", { parentToolCallId: "tool" }),
      delta("item/agentMessage/delta", "msg", "text\n", { parentToolCallId: "tool" }),
      delta("item/agentMessage/delta", "msg", " more"),
      event({ type: "turn/completed", status: "interrupted" }),
    ]);
  });

  it("shows the same timeline for random streams of every kind of piece", () => {
    let seed = 0x1248;
    const random = (limit: number) => {
      seed = (seed * 1103515245 + 12345) & 0x7fffffff;
      return seed % limit;
    };
    const words = ["alpha", "beta\n", "gamma ", "delta", "\n", "epsilon\n\n", " zeta"];
    const piece = () =>
      Array.from({ length: 1 + random(3) }, () => words[random(words.length)]).join("");

    let fewerRows = 0;
    for (let stream = 0; stream < 300; stream += 1) {
      const events: ThreadEvent[] = [event({ type: "turn/started" })];
      const texts = new Map<string, string>();
      const open = new Set<string>();
      const kinds = ["message", "message", "plan", "reasoning", "command", "patch"] as const;
      const ids = kinds.map((kind, index) => `${kind}-${index}`);
      const steps = 5 + random(40);
      for (let step = 0; step < steps; step += 1) {
        // Runs of pieces for one item are the common case; switching items between pieces is the hard one.
        const slot = random(4) === 0 ? random(kinds.length) : stream % kinds.length;
        const kind = kinds[slot]!;
        const id = ids[slot]!;
        const text = piece();
        const nested = random(10) === 0 ? { parentToolCallId: "tool" } : {};
        const add = (type: string, extra: Record<string, unknown> = {}) => {
          events.push(delta(type, id, text, { ...nested, ...extra }));
          texts.set(id, (extra.reset ? "" : (texts.get(id) ?? "")) + text);
        };
        if (!open.has(id)) {
          open.add(id);
          if (kind === "message") events.push(item("item/started", { type: "agentMessage", id, text: "" }));
          if (kind === "reasoning") events.push(item("item/started", { type: "reasoning", id, summary: [], content: [] }));
          if (kind === "command") events.push(item("item/started", command(id, "pending", "")));
        }
        if (kind === "message") add("item/agentMessage/delta");
        else if (kind === "plan") add("item/plan/delta");
        else if (kind === "reasoning") add(random(2) ? "item/reasoning/summaryTextDelta" : "item/reasoning/textDelta");
        else if (kind === "command") add("item/commandExecution/outputDelta", random(6) === 0 ? { reset: true } : {});
        else add("item/fileChange/outputDelta");
        // Some items finish and a new one takes their place; the rest are still streaming when the timeline is read.
        if (random(12) === 0 && kind !== "plan" && kind !== "patch") {
          const done = texts.get(id) ?? "";
          if (kind === "message") events.push(item("item/completed", { type: "agentMessage", id, text: done }));
          if (kind === "reasoning") events.push(item("item/completed", { type: "reasoning", id, summary: [done], content: [] }));
          if (kind === "command") events.push(item("item/completed", command(id, "completed", done)));
          ids[slot] = `${kind}-${slot}-${step}`;
        }
      }
      if (random(3) === 0)
        events.push(event({ type: "turn/completed", status: random(2) ? "completed" : "interrupted" }));

      const joined = expectSameTimeline(events);
      if (joined.length < events.length) fewerRows += 1;
    }
    // The streams must really exercise joining, not pass because nothing joined.
    expect(fewerRows).toBeGreaterThan(250);
  });
});
