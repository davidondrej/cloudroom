import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { createAcpContextEstimate } from "./context-estimate.js";
import {
  cursorConfigDirectory,
  decodeCursorConversationTokenDetails,
} from "./cursor-store-usage.js";

function encodeVarint(value: number): number[] {
  const out: number[] = [];
  let v = value;
  while (v >= 0x80) {
    out.push((v & 0x7f) | 0x80);
    v = Math.floor(v / 128);
  }
  out.push(v);
  return out;
}

function encodeVarintField(field: number, value: number): number[] {
  return [...encodeVarint((field << 3) | 0), ...encodeVarint(value)];
}

function encodeBytesField(field: number, bytes: number[]): number[] {
  return [...encodeVarint((field << 3) | 2), ...encodeVarint(bytes.length), ...bytes];
}

function encodeStringField(field: number, text: string): number[] {
  return encodeBytesField(field, [...new TextEncoder().encode(text)]);
}

function buildRootBlob(args: {
  used: number;
  max: number;
  categories?: Array<{ id: string; label: string; tokens: number }>;
}): Uint8Array {
  const catBytes = (args.categories ?? []).flatMap((cat) =>
    encodeBytesField(3, [
      ...encodeStringField(1, cat.id),
      ...encodeStringField(2, cat.label),
      ...encodeVarintField(3, cat.tokens),
    ]),
  );
  const breakdown = catBytes.length > 0 ? encodeBytesField(3, catBytes) : [];
  const tokenDetails = [
    ...encodeVarintField(1, args.used),
    ...encodeVarintField(2, args.max),
    ...breakdown,
  ];
  return new Uint8Array(encodeBytesField(5, tokenDetails));
}

describe("decodeCursorConversationTokenDetails", () => {
  it("decodes used_tokens, max_tokens, and non-zero breakdown categories", () => {
    const blob = buildRootBlob({
      used: 47_830,
      max: 300_000,
      categories: [
        { id: "system_prompt", label: "System prompt", tokens: 1_825 },
        { id: "summarized_conversation", label: "Summarized", tokens: 0 },
        { id: "conversation", label: "Conversation", tokens: 46_005 },
      ],
    });
    expect(decodeCursorConversationTokenDetails(blob)).toEqual({
      usedTokens: 47_830,
      maxTokens: 300_000,
      categories: [
        { id: "system_prompt", label: "System prompt", tokens: 1_825 },
        { id: "conversation", label: "Conversation", tokens: 46_005 },
      ],
    });
  });

  it("rejects out-of-bounds windows, extreme ratios, and garbage bytes", () => {
    expect(
      decodeCursorConversationTokenDetails(
        buildRootBlob({ used: 100, max: 1_000 }),
      ),
    ).toBeUndefined();
    expect(
      decodeCursorConversationTokenDetails(
        buildRootBlob({ used: 100, max: 50_000_000 }),
      ),
    ).toBeUndefined();
    expect(
      decodeCursorConversationTokenDetails(
        buildRootBlob({ used: 2_000_000, max: 300_000 }),
      ),
    ).toBeUndefined();
    expect(
      decodeCursorConversationTokenDetails(new Uint8Array([0xff, 0x00, 0xfe])),
    ).toBeUndefined();
  });
});

describe("cursorConfigDirectory", () => {
  it("honors CURSOR_CONFIG_DIR, XDG_CONFIG_HOME, and platform home precedence", () => {
    expect(cursorConfigDirectory({ CURSOR_CONFIG_DIR: "/custom/cursor" })).toBe(
      "/custom/cursor",
    );
    expect(cursorConfigDirectory({ XDG_CONFIG_HOME: "/xdg" })).toBe(
      join("/xdg", "cursor"),
    );
    expect(
      cursorConfigDirectory(
        { HOME: "/home/gitbash", USERPROFILE: "C:\\Users\\alice" },
        "win32",
      ),
    ).toBe(join("C:\\Users\\alice", ".cursor"));
    expect(
      cursorConfigDirectory(
        { HOME: "/Users/alice", USERPROFILE: "/ignored" },
        "darwin",
      ),
    ).toBe(join("/Users/alice", ".cursor"));
  });
});

describe("createAcpContextEstimate", () => {
  it("ignores thinking chunks, full-file diff blocks, and binary image file sizes", () => {
    const estimate = createAcpContextEstimate({
      baseTokens: 19_000,
      charsPerToken: 3.4,
      defaultWindowTokens: 300_000,
    });
    estimate.addUpdate({
      sessionUpdate: "agent_thought_chunk",
      content: { type: "text", text: "x".repeat(200_000) },
    });
    estimate.addUpdate({
      sessionUpdate: "tool_call_update",
      toolCallId: "edit-1",
      kind: "edit",
      status: "completed",
      content: [
        {
          type: "diff",
          path: "/tmp/big.ts",
          oldText: "a".repeat(250_000),
          newText: "b".repeat(250_000),
        },
      ],
    });
    estimate.addUpdate({
      sessionUpdate: "tool_call_update",
      toolCallId: "read-img",
      kind: "read",
      status: "completed",
      rawInput: { path: "/tmp/screenshot.png" },
    });

    expect(estimate.used()).toBeLessThan(22_000);
    expect(estimate.windowSize("gemini-4-neon-xhigh")).toBe(300_000);
    expect(estimate.windowSize("claude[context=1m]")).toBe(1_000_000);
  });
});
