// Full access must stay quiet when Claude Code updates. This runs the real
// Claude CLI against a fake model (no tokens): each turn asks for one risky
// Bash command, and every ask Claude still sends in bypass mode must be one
// the bridge waives. Nightly against the latest Claude (claude-live.yml);
// skipped unless CLAUDE_LIVE_BIN points at a `claude` binary.
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { query, type Options } from "@anthropic-ai/claude-agent-sdk";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  CLAUDE_BYPASS_WAIVABLE_REMOVAL_CHECK_PATTERNS as PATTERNS,
  isClaudeBypassWaivableRemovalCheck,
} from "../bridge.js";
import { buildSdkPermissionOptions } from "../sdk-session.js";

const CLAUDE_BIN = process.env.CLAUDE_LIVE_BIN;
const [CANT_PARSE, DANGEROUS_RM, SHELL_C] = PATTERNS;

// Each makes Claude 2.1.332 ask despite bypass mode, with a reason the named
// pattern matches. They run in a temp folder and every ask is denied.
const CASES = [
  { command: "rm -rf .", pattern: DANGEROUS_RM },
  { command: "rm -rf $(echo ./sub)", pattern: DANGEROUS_RM },
  // zsh-only syntax Claude's parser can't read: the v169 report.
  { command: "print -l ${(k)commands} >/dev/null", pattern: CANT_PARSE },
  { command: "print -l ${(k)commands} >/dev/null; rm -f ./x.txt", pattern: DANGEROUS_RM },
  { command: "zsh -c 'print -l ${(k)commands}; rm -f ./x.txt'", pattern: SHELL_C },
];

const PROMPT_PREFIX = "RUN:";
let server: Server;
let root: string;

// Text of every user message block, to find the command the prompt carries.
function userTexts(messages: unknown[]): string[] {
  return messages.flatMap((message) => {
    const content = (message as { content?: unknown }).content;
    if (typeof content === "string") return [content];
    return Array.isArray(content)
      ? content.flatMap((block: { text?: unknown }) =>
          typeof block.text === "string" ? [block.text] : [],
        )
      : [];
  });
}

// Answers a turn that offers Bash with a call to the prompt's command, then "done".
function fakeModelReply(body: string): object[] {
  const request = JSON.parse(body) as {
    model?: string;
    messages?: unknown[];
    tools?: { name?: string }[];
  };
  const messages = request.messages ?? [];
  const command = userTexts(messages)
    .find((text) => text.startsWith(PROMPT_PREFIX))
    ?.slice(PROMPT_PREFIX.length);
  const callBash =
    command !== undefined &&
    request.tools?.some((tool) => tool.name === "Bash") === true &&
    !JSON.stringify(messages).includes('"tool_result"');
  const block = callBash
    ? [
        {
          type: "content_block_start",
          index: 0,
          content_block: { type: "tool_use", id: `toolu_${Date.now()}`, name: "Bash", input: {} },
        },
        {
          type: "content_block_delta",
          index: 0,
          delta: { type: "input_json_delta", partial_json: JSON.stringify({ command, description: "test" }) },
        },
      ]
    : [
        { type: "content_block_start", index: 0, content_block: { type: "text", text: "" } },
        { type: "content_block_delta", index: 0, delta: { type: "text_delta", text: "done" } },
      ];
  return [
    {
      type: "message_start",
      message: {
        id: "msg_live",
        type: "message",
        role: "assistant",
        model: request.model ?? "claude-test",
        content: [],
        stop_reason: null,
        stop_sequence: null,
        usage: { input_tokens: 1, output_tokens: 1 },
      },
    },
    ...block,
    { type: "content_block_stop", index: 0 },
    {
      type: "message_delta",
      delta: { stop_reason: callBash ? "tool_use" : "end_turn", stop_sequence: null },
      usage: { output_tokens: 1 },
    },
    { type: "message_stop" },
  ];
}

// Isolated from the developer's own Claude: fresh home, config and folder.
function liveOptions(stderr: (data: string) => void): Options {
  const cwd = mkdtempSync(join(root, "work-"));
  mkdirSync(join(cwd, "sub"));
  writeFileSync(join(cwd, "x.txt"), "x");
  const { port } = server.address() as AddressInfo;
  return {
    cwd,
    model: "sonnet",
    pathToClaudeCodeExecutable: CLAUDE_BIN,
    settingSources: [],
    maxTurns: 3,
    stderr,
    env: {
      PATH: process.env.PATH,
      HOME: mkdtempSync(join(root, "home-")),
      SHELL: "/bin/zsh",
      ANTHROPIC_BASE_URL: `http://127.0.0.1:${port}`,
      ANTHROPIC_API_KEY: "sk-ant-fake",
      CLAUDE_CONFIG_DIR: mkdtempSync(join(root, "config-")),
      CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: "1",
    },
  };
}

describe.skipIf(!CLAUDE_BIN)("real Claude in full access", () => {
  beforeAll(async () => {
    root = mkdtempSync(join(tmpdir(), "claude-live-"));
    server = createServer((req, res) => {
      let body = "";
      req.on("data", (chunk: Buffer) => (body += chunk.toString()));
      req.on("end", () => {
        if (req.url?.startsWith("/v1/messages?") !== true && req.url !== "/v1/messages") {
          res.writeHead(200, { "content-type": "application/json" }).end('{"input_tokens":1}');
          return;
        }
        res.writeHead(200, { "content-type": "text/event-stream" });
        for (const event of fakeModelReply(body)) {
          res.write(`event: ${(event as { type: string }).type}\ndata: ${JSON.stringify(event)}\n\n`);
        }
        res.end();
      });
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  });

  afterAll(() => {
    server?.close();
    if (root) rmSync(root, { recursive: true, force: true });
  });

  it("has a case for every waiver pattern", () => {
    expect(new Set(CASES.map((testCase) => testCase.pattern)).size).toBe(PATTERNS.length);
  });

  it.each(CASES)("waives Claude's ask for: $command", async ({ command, pattern }) => {
    let stderr = "";
    let initMode: string | undefined;
    let isError = true;
    const reasons: string[] = [];
    const unwaived: string[] = [];
    const session = query({
      prompt: `${PROMPT_PREFIX}${command}`,
      options: {
        ...liveOptions((data) => (stderr += data)),
        ...buildSdkPermissionOptions({
          permissionMode: "bypassPermissions",
          approvedPlanPermissionMode: undefined,
        }),
        canUseTool: async (toolName, _input, options) => {
          const reason = options.decisionReason ?? "";
          reasons.push(reason);
          const waived = isClaudeBypassWaivableRemovalCheck({
            toolName,
            decisionReason: options.decisionReason,
            matchedAskRule: options.matchedAskRule,
            blockedPath: options.blockedPath,
          });
          if (!waived) unwaived.push(`${toolName}: ${reason}`);
          return { behavior: "deny", message: "Denied by the live test." };
        },
      },
    });
    for await (const message of session) {
      if (message.type === "system" && message.subtype === "init") initMode = message.permissionMode;
      if (message.type === "result") {
        isError = message.is_error;
        break;
      }
    }

    expect(initMode, `Claude did not start in bypass mode. stderr:\n${stderr}`).toBe("bypassPermissions");
    expect(isError, `Claude's run failed. stderr:\n${stderr}`).toBe(false);
    // Full access would show a card again: Claude reworded or added a check.
    // Update CLAUDE_BYPASS_WAIVABLE_REMOVAL_CHECK_PATTERNS in bridge.ts.
    expect(unwaived).toEqual([]);
    // Claude stopped asking, or asks for another reason: swap in a command that hits the pattern.
    expect(reasons.length, "Claude no longer asks about this command").toBeGreaterThan(0);
    expect(reasons.filter((reason) => !pattern.test(reason))).toEqual([]);
  }, 60_000);

  it("lets a Full access session that starts in Plan mode switch to bypass", async () => {
    let stderr = "";
    async function* idle(): AsyncGenerator<never> {
      await new Promise((resolve) => setTimeout(resolve, 30_000));
    }
    const session = query({
      prompt: idle(),
      options: {
        ...liveOptions((data) => (stderr += data)),
        ...buildSdkPermissionOptions({
          permissionMode: "plan",
          approvedPlanPermissionMode: "bypassPermissions",
        }),
      },
    });
    try {
      await expect(
        session.setPermissionMode("bypassPermissions"),
        `stderr:\n${stderr}`,
      ).resolves.toBeUndefined();
    } finally {
      session.close();
    }
  }, 60_000);
});
