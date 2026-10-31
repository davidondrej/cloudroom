import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { PromptInput } from "@get-bb/plugin-sdk/provider-bridge";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { expandClaudeSkillInput } from "../skill-input.js";
import type { SdkSessionOptions } from "../sdk-session.js";

describe("selected Claude skills", () => {
  let home: string;
  let options: SdkSessionOptions;

  beforeEach(() => {
    home = mkdtempSync(join(tmpdir(), "bb-claude-skill-input-"));
    mkdirSync(join(home, "project", ".git"), { recursive: true });
    for (const [name, header] of [
      ["native", "model: sonnet\nallowed-tools: Bash"],
      ["plain", "description: plain"],
    ]) {
      mkdirSync(join(home, ".claude", "skills", name), { recursive: true });
      writeFileSync(
        join(home, ".claude", "skills", name, "SKILL.md"),
        `---\nname: ${name}\n${header}\n---\nDo ${name} for $ARGUMENTS.\n`,
      );
    }
    options = {
      cwd: join(home, "project"),
      env: { HOME: home },
    } as unknown as SdkSessionOptions;
  });

  afterEach(() => rmSync(home, { recursive: true, force: true }));

  const tagged = (text: string, ...names: string[]): PromptInput[] => [
    {
      type: "text",
      text,
      mentions: names.map((name) => {
        const start = text.indexOf(`/${name}`);
        return {
          start,
          end: start + name.length + 1,
          resource: { kind: "command", source: "skill", name, origin: "user" },
        };
      }),
    } as PromptInput,
  ];

  it("leaves a leading skill with Claude Code settings for Claude Code to run", async () => {
    const output = await expandClaudeSkillInput(
      tagged("/native fix it with /plain", "native", "plain"),
      options,
    );
    expect(output).toEqual([
      { type: "text", text: "/native fix it with /plain", mentions: [] },
    ]);
  });

  it("loads plain skills and refuses settings skills later in the message", async () => {
    const output = await expandClaudeSkillInput(
      tagged("/plain the tests", "plain"),
      options,
    );
    expect(output[0]).toMatchObject({ visibility: "agent-only" });
    expect((output[0] as { text: string }).text).toContain(
      "Do plain for the tests.",
    );
    await expect(
      expandClaudeSkillInput(tagged("please /native", "native"), options),
    ).rejects.toThrow(
      "/native uses Claude Code settings, so it only runs when /native starts your message.",
    );
  });
});
