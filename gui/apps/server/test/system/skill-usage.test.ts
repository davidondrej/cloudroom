import { describe, expect, it } from "vitest";
import { sql } from "drizzle-orm";
import {
  createConnection,
  createProject,
  createThread,
  migrate,
  noopNotifier,
  upsertHost,
} from "@cloudroom/db";
import type { PromptInput } from "@cloudroom/domain";
import {
  buildSkillUsage,
  readSkillUsage,
  skillNameFromUse,
  type SkillUseRow,
} from "../../src/services/system/skill-usage.js";

const DAY = 24 * 60 * 60 * 1000;
const NOW = Date.UTC(2026, 10, 5, 12);

function skillPrompt(
  name: string,
  source: "skill" | "command" = "skill",
): PromptInput[] {
  return [
    {
      type: "text",
      text: `/${name} go`,
      mentions: [
        {
          start: 0,
          end: name.length + 1,
          resource: {
            kind: "command",
            trigger: "/",
            name,
            source,
            origin: "user",
            label: name,
            argumentHint: null,
          },
        },
      ],
    },
  ];
}

function setup() {
  const db = createConnection(":memory:");
  migrate(db);
  const host = upsertHost(db, noopNotifier, { name: "test-host" });
  const project = createProject(db, noopNotifier, {
    name: "Project",
    source: { type: "local_path", hostId: host.id, path: "/tmp/project" },
  }).project;
  let sequence = 0;
  const insert = (
    threadId: string,
    type: string,
    turnId: string | null,
    data: Record<string, unknown>,
    at: number,
  ) => {
    sequence += 1;
    const item = data.item as { id?: string; type?: string } | undefined;
    db.run(sql`INSERT INTO events (id, thread_id, scope_kind, turn_id, provider_thread_id, sequence, type, item_id, item_kind, data, created_at)
      VALUES (${`evt_${sequence}`}, ${threadId}, ${turnId ? "turn" : "thread"}, ${turnId}, 'provider_1', ${sequence}, ${type}, ${item?.id ?? null}, ${item?.type ?? null}, ${JSON.stringify(data)}, ${at})`);
  };
  /** Writes one thread's history. Calling it twice mimics a fork's copied events. */
  const writeHistory = () => {
    const threadId = createThread(db, noopNotifier, {
      projectId: project.id,
      providerId: "claude-code",
    }).id;
    const prompt = (
      input: PromptInput[],
      requestId: number,
      at: number,
      extra = {},
    ) =>
      insert(
        threadId,
        "client/turn/requested",
        null,
        { requestId, input, ...extra },
        at,
      );
    const item = (turnId: string, value: Record<string, unknown>, at = NOW) =>
      insert(
        threadId,
        "item/completed",
        turnId,
        { item: { status: "completed", ...value } },
        at,
      );
    prompt(skillPrompt("designs"), 1, NOW - DAY);
    prompt(skillPrompt("designs"), 1, NOW - DAY + 5, { retryAttempt: 2 });
    prompt(skillPrompt("compact", "command"), 2, NOW);
    item("turn_1", {
      type: "toolCall",
      id: "i1",
      tool: "Skill",
      arguments: { skill: "code-review" },
    });
    item("turn_1", {
      type: "toolCall",
      id: "i2",
      tool: "WebSearch",
      arguments: { skill: "nope" },
    });
    item("turn_1", {
      type: "toolCall",
      id: "i3",
      tool: "Skill",
      arguments: { skill: 123 },
    });
    item("turn_2", {
      type: "commandExecution",
      id: "i4",
      command: "cat /x/skills/release/SKILL.md",
      cwd: "/",
      approvalStatus: "none",
    });
    item("turn_3", {
      type: "toolCall",
      id: "i5",
      tool: "Read",
      arguments: { file_path: "/home/u/.claude/skills/dataviz/SKILL.md" },
    });
    item("turn_4", {
      type: "toolCall",
      id: "i6",
      tool: "Bash",
      arguments: { command: "sed -n 1,80p ~/skills/simplify/SKILL.md" },
    });
    item(
      "turn_5",
      {
        type: "toolCall",
        id: "i7",
        tool: "Skill",
        arguments: { skill: "code-review" },
      },
      NOW - 200 * DAY,
    );
  };
  return { db, writeHistory };
}

describe("skill usage", () => {
  it("reads skill names from tool calls, file reads, and shell reads", () => {
    expect(
      skillNameFromUse({ kind: "name", value: "cloudroom:room-cli" }),
    ).toBe("room-cli");
    expect(
      skillNameFromUse({
        kind: "path",
        value: "/home/u/.claude/skills/designs/SKILL.md",
      }),
    ).toBe("designs");
    expect(
      skillNameFromUse({
        kind: "command",
        value:
          "/bin/zsh -lc \"sed -n '1,200p' ~/.codex/skills/prod-push/SKILL.md\"",
      }),
    ).toBe("prod-push");
    expect(
      skillNameFromUse({
        kind: "command",
        value: "grep -l x a/SKILL.md b/SKILL.md",
      }),
    ).toBeNull();
    expect(
      skillNameFromUse({
        kind: "command",
        value: "echo hi > skills/x/SKILL.md",
      }),
    ).toBeNull();
    expect(
      skillNameFromUse({
        kind: "command",
        value: "sed -i 's/a/b/' skills/x/SKILL.md",
      }),
    ).toBeNull();
    expect(skillNameFromUse({ kind: "name", value: null })).toBeNull();
    expect(skillNameFromUse({ kind: "name", value: 123 })).toBeNull();
  });

  it("buckets runs by local day and counts one skill once per turn", () => {
    const rows: SkillUseRow[] = [
      { kind: "name", value: "designs", at: NOW, key: "t:1:a" },
      { kind: "path", value: "/s/designs/SKILL.md", at: NOW, key: "t:1:a" },
      { kind: "name", value: "designs", at: NOW - DAY, key: "t:1:b" },
      { kind: "name", value: "simplify", at: NOW, key: "t:1:a" },
      { kind: "name", value: "simplify", at: NOW - 40 * DAY, key: "t:1:c" },
    ];
    const usage = buildSkillUsage(rows, {
      days: 30,
      now: NOW,
      utcOffsetMinutes: 60,
    });
    expect(usage.startDate).toBe("2026-10-07");
    expect(usage.skills.map(({ name, total }) => [name, total])).toEqual([
      ["designs", 2],
      ["simplify", 1],
    ]);
    expect(usage.skills[0]!.daily.slice(-2)).toEqual([1, 1]);
  });

  it("counts Local and Cloud shapes once, and ignores forks, retries, and bad values", () => {
    const { db, writeHistory } = setup();
    writeHistory();
    writeHistory(); // A fork: same events, ids, and times in a second thread.

    const usage = readSkillUsage({ db }, { days: "90" }, NOW);
    expect(usage.days).toBe(90);
    expect(usage.skills.map(({ name, total }) => [name, total])).toEqual([
      ["code-review", 1],
      ["dataviz", 1],
      ["designs", 1],
      ["release", 1],
      ["simplify", 1],
    ]);
  });
});
