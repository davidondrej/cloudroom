import { describe, expect, it, vi } from "vitest";
import {
  renderTemplate,
  type TemplateId,
  type TemplateVariables,
} from "../src/index.js";
import { templateDefinitions } from "../src/generated/templates.generated.js";

describe("@cloudroom/templates", () => {
  it("documents project creation machine routing", () => {
    const guide = renderTemplate("bbGuideProjects", {});

    expect(guide).toContain("room-cli project create --name");
    expect(guide).toContain("--machine <id-or-name>");
    expect(guide).toContain("--host <id-or-name>");
    expect(guide).toContain("local CLI machine fallback");
  });

  it("documents automation updates that keep omitted settings", () => {
    const guide = renderTemplate("bbGuideAutomations", {});

    expect(guide).toContain("room-cli loop update <loopId>");
    expect(guide).toContain("and keeps every");
    expect(guide).toContain("--env-json");
    expect(guide).toContain("--reasoning <none|low|medium|high");
    expect(guide).toContain("--service-tier default|fast|none");
    expect(guide).toContain("--permission-mode <accept-edits|auto|full>");
    expect(guide).not.toContain("workspace-write|readonly");
  });

  it("documents project-aware thread references", () => {
    const guide = renderTemplate("bbGuideThreads", {});

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
        "[bb message from thread:thr_sender]",
        "",
        "Please check the failing test.",
      ].join("\n"),
    );
  });

  it("renders standardAgentAppendInstructions without user-question guidance", () => {
    const rendered = renderTemplate("standardAgentAppendInstructions", {
      bugReports: "",
      mac: "on",
      windows: "",
    });

    expect(rendered).toContain("You are working inside Cloudroom");
    expect(rendered).toContain("IDE for managing coding agents");
    expect(rendered).toContain("Mention any thread or agent as @thread:thr_abc123");
    expect(rendered).toContain("Do not construct thread URLs manually");
    expect(rendered).not.toContain(
      "Ask the user a blocking question only when",
    );
  });

  it("offers Mac access and Local computer use only off Windows", () => {
    const render = (windows: boolean) =>
      renderTemplate("standardAgentAppendInstructions", {
        bugReports: "",
        mac: windows ? "" : "on",
        windows: windows ? "on" : "",
      });

    expect(render(false)).toContain("room-cli mac pull");
    expect(render(false)).toContain("in Local threads Cloudroom asks the user");
    expect(render(true)).not.toMatch(/room-cli mac (pull|push)|run it on their Mac/u);
    expect(render(true)).not.toContain("in Local threads Cloudroom asks the user");
    expect(render(true)).toContain("save lasting skills in the repo.");
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
        "[bb system]",
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
        "[bb system]",
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
        "[bb system]",
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
      previousPurpose: "Fixing login (50% done)",
      agentReply: "Use $& and {{title}}.",
    });

    expect(bare.slice(bare.indexOf("Update it when"))).toBe(
      [
        "Update it when the user changed direction.",
        "",
        "Thread name: Fix login",
        "",
        "The user's first message:",
        "Login fails",
        "",
        "The user's latest messages:",
        "- Login fails",
      ].join("\n"),
    );
    expect(full.slice(full.indexOf("Update it when"))).toBe(
      [
        "Update it when the user changed direction.",
        "",
        "Previous note (reuse its wording if the goal and state did not change):",
        "Fixing login (50% done)",
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
