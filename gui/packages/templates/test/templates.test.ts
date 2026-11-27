import { describe, expect, it, vi } from "vitest";
import {
  renderTemplate,
  type TemplateId,
  type TemplateVariables,
} from "../src/index.js";
import { templateDefinitions } from "../src/generated/templates.generated.js";

describe("@cloudroom/templates", () => {
  it("documents project creation machine routing", () => {
    const guide = renderTemplate("roomGuideProjects", {});

    expect(guide).toContain("room-cli project create --name");
    expect(guide).toContain("--machine <id-or-name>");
    expect(guide).toContain("--host <id-or-name>");
    expect(guide).toContain("local CLI machine fallback");
  });

  it("documents automation updates that keep omitted settings", () => {
    const guide = renderTemplate("roomGuideAutomations", {});

    expect(guide).toContain("room-cli loop update <loopId>");
    expect(guide).toContain("and keeps every");
    expect(guide).toContain("--env-json");
    expect(guide).toContain("--reasoning <none|low|medium|high");
    expect(guide).toContain("--service-tier default|fast|none");
    expect(guide).toContain("--permission-mode <accept-edits|auto|full>");
    expect(guide).not.toContain("workspace-write|readonly");
  });

  it("documents project-aware thread references", () => {
    const guide = renderTemplate("roomGuideThreads", {});

    expect(guide).toContain("@thread:thr_abc123");
    expect(guide).toContain("do not construct thread URLs manually");
  });

  it("renders agent thread messages without inline reply guidance", () => {
    const rendered = renderTemplate("agentThreadMessage", {
      senderThreadId: "thr_sender",
      messageText: "Please check the failing test.",
    });

    expect(rendered).toBe(
      [
        "[message from thread:thr_sender]",
        "",
        "Please check the failing test.",
      ].join("\n"),
    );
  });

  const systemPrompt = (kind: "local" | "cloud", windows = false) =>
    renderTemplate("standardAgentAppendInstructions", {
      local: kind === "local" ? "on" : "",
      cloud: kind === "cloud" ? "on" : "",
      bugReports: "",
      mac: windows ? "" : "on",
      vps: "",
      windows: windows ? "on" : "",
    });

  it("renders standardAgentAppendInstructions without user-question guidance", () => {
    for (const rendered of [systemPrompt("local"), systemPrompt("cloud")]) {
      expect(rendered).toContain("You are working inside Cloudroom");
      expect(rendered).toContain("IDE for managing coding agents");
      expect(rendered).toContain("Mention threads as @thread:thr_abc123");
      expect(rendered).toContain("Never build thread URLs");
      expect(rendered).not.toContain(
        "Ask the user a blocking question only when",
      );
      expect(rendered).not.toMatch(/\{\{|\n\n\n/u);
      // #2257: the "Built with Cloudroom" line goes on new PR and issue descriptions, never on reviews.
      expect(rendered).toContain("(the description only, never reviews or comments)");
    }
    // Each kind of thread gets only its own lines.
    const local = systemPrompt("local");
    const cloud = systemPrompt("cloud");
    expect(local).toContain("run `room-cli status --json` before acting");
    expect(local).not.toMatch(/## Cloud sandboxes|room-cli files wait|--shared-sandbox/u);
    expect(cloud).toContain("## Cloud sandboxes");
    expect(cloud).toContain("room-cli files wait");
    // #2628: Cloud agents wait for a running setup script before installing.
    expect(cloud).toContain(
      "`/var/lib/cloudroom-setup/status` says `running`? Wait up to 10 minutes",
    );
    expect(local).not.toContain("cloudroom-setup");
    expect(cloud).not.toMatch(/Local children share|ask before installing/u);
    // #1281: Cloud agents explain that a GH_TOKEN API key overrides the GitHub login.
    expect(cloud).toContain("a Cloud API key may be overriding the GitHub login.");
    expect(local).not.toContain("GH_TOKEN");
    // #1182: a used-up API quota makes `gh auth status` say "invalid".
    expect(cloud).toContain(
      "Check `gh api rate_limit` before you report a bad login.",
    );
    // #936: blobless Cloud clones get one batch fetch before history-wide reads.
    expect(cloud).toContain(String.raw`[ -z "$ids" ] || printf '%s\n' "$ids" | GIT_TERMINAL_PROMPT=0 timeout 900 git -c fetch.negotiationAlgorithm=noop fetch -q --no-tags --recurse-submodules=no --no-write-fetch-head origin --stdin`);
    expect(local).not.toContain("negotiationAlgorithm");
    // #2107: a Git command whose lazy fetch fails aborts only its own rebase, gets its autostash back, then batch fetches and reruns.
    expect(cloud).toContain(
      "`git rebase --abort` if that command was a rebase, `for r in MERGE_AUTOSTASH CHECKOUT_AUTOSTASH_HEAD; do git rev-parse -q --verify $r >/dev/null && git stash apply $r && git update-ref -d $r; done; true`, that batch fetch, then that command again.",
    );
    // #1739: Codex can SIGTERM a plain retained server; Cloud agents start servers with a TTY or detached.
    expect(cloud).toContain("setsid nohup <cmd> > /tmp/<name>.log 2>&1 < /dev/null &");
    expect(local).not.toContain("setsid nohup");
    // #2165: Cloud /var/tmp can be noexec, so executables go to /tmp.
    expect(cloud).toContain(
      "Put generated executables in `/tmp` or the project.",
    );
    expect(local).not.toContain("/var/tmp");
    // #2538: a quiet background wait can stop after 10 minutes (Metal), so agents set a wake instead.
    expect(cloud).toContain("a quiet wait (polling, `sleep`, a Monitor) can stop after 10 minutes.");
    expect(cloud).not.toContain("awake for 2 hours, then stop");
  });

  it("offers Mac access everywhere and Local computer use only off Windows", () => {
    expect(systemPrompt("cloud")).toContain("room-cli mac pull");
    expect(systemPrompt("local")).toContain("read the `computer-use` skill");
    expect(systemPrompt("local") + systemPrompt("cloud")).not.toMatch(/\bMac\b(?! access)|laptop/u);
    // #958: Windows Cloud threads reach the user's computer through Git Bash, like a Mac.
    expect(systemPrompt("cloud", true)).toContain("room-cli mac pull");
    expect(systemPrompt("local", true) + systemPrompt("cloud", true)).not.toContain("run it on the user's computer");
    expect(systemPrompt("local", true)).not.toContain("read the `computer-use` skill");
    expect(systemPrompt("local", true) + systemPrompt("cloud", true)).not.toContain("Windows computer");
  });

  it("renders child thread needs-attention messages with blocker summaries", () => {
    const rendered = renderTemplate("systemMessageChildThreadNeedsAttention", {
      blockerSummary: [
        "Blocked on command approval:",
        "Command: git push",
      ].join("\n"),
      threadMention: "@thread:thr_child",
    });

    expect(rendered).toBe(
      [
        "[system]",
        "",
        "@thread:thr_child needs help.",
        "Blocked on command approval:",
        "Command: git push",
        "",
        "Review the blocker. If you can resolve it from existing context, reply to the thread with guidance. Otherwise, ask the user for the missing decision.",
      ].join("\n"),
    );
  });

  it("renders child thread ownership messages", () => {
    expect(
      renderTemplate("systemMessageThreadOwnershipAssigned", {
        threadMention: "@thread:thr_child",
      }),
    ).toBe(
      [
        "[system]",
        "",
        "@thread:thr_child is now a child of this thread.",
      ].join("\n"),
    );
    expect(
      renderTemplate("systemMessageThreadOwnershipRemoved", {
        threadMention: "@thread:thr_child",
      }),
    ).toBe(
      [
        "[system]",
        "",
        "@thread:thr_child is no longer a child of this thread.",
      ].join("\n"),
    );
  });

  it("renders if blocks only when their variable is set", () => {
    const variables = {
      title: "Fix login",
      firstMessage: "Login fails",
      recentMessages: "- Login fails",
    };
    const bare = renderTemplate("generateThreadPurpose", variables);
    const full = renderTemplate("generateThreadPurpose", {
      ...variables,
      previousPurpose: "Goal: Fixing login.\nPercent: 50",
      agentReply: "Use $& and {{title}}.",
    });

    expect(bare.slice(bare.indexOf("Thread name:"))).toBe(
      [
        "Thread name: Fix login",
        "",
        "The user's first message:",
        "Login fails",
        "",
        "The user's latest messages:",
        "- Login fails",
      ].join("\n"),
    );
    expect(full.slice(full.indexOf("Previous note:"))).toBe(
      [
        "Previous note:",
        "Goal: Fixing login.",
        "Percent: 50",
        "Keep the goal word for word.",
        "Change it only when the user changed the main goal, or to the past tense once it is reached.",
        "If the latest reply brought nothing new, keep the state word for word too.",
        "",
        "Thread name: Fix login",
        "",
        "The user's first message:",
        "Login fails",
        "",
        "The user's latest messages:",
        "- Login fails",
        "",
        "The agent's latest reply:",
        "Use $& and {{title}}.",
      ].join("\n"),
    );
  });

  it("renders all templates without error", () => {
    const templates = templateDefinitions;

    const placeholderVariables: Record<string, Record<string, string>> = {};
    for (const template of templates) {
      const vars: Record<string, string> = {};
      for (const varName of Object.keys(template.variables)) {
        vars[varName] = `__placeholder_${varName}__`;
      }
      placeholderVariables[template.id] = vars;
    }

    for (const template of templates) {
      const vars = placeholderVariables[
        template.id
      ] as TemplateVariables[TemplateId];
      expect(() =>
        renderTemplate(template.id as TemplateId, vars),
      ).not.toThrow();
    }
  });

  it("throws on unsupported syntax instead of dropping it", async () => {
    const bodies = [
      "\\{{title}}",
      "{{#each items}}x{{/each}}",
      "{{#if title}}\nx\n{{else}}\ny\n{{/if}}",
      "{{#if title}}\n".repeat(50_000),
    ];
    for (const body of bodies) {
      vi.resetModules();
      vi.doMock("../src/generated/templates.generated.js", () => ({
        templateDefinitions: [{ id: "probe", body }],
      }));
      const { renderTemplate: render } =
        await import("../src/render-template.js");
      expect(() => render("probe" as TemplateId, {} as never)).toThrow(
        "unsupported syntax",
      );
    }
    vi.doUnmock("../src/generated/templates.generated.js");
  });
});
