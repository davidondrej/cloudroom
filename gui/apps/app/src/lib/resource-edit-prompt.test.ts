import { describe, expect, it } from "vitest";
import {
  buildAutomationEditThreadPrompt,
  buildPluginEditThreadPrompt,
  buildSkillEditThreadPrompt,
} from "@cloudroom/shared-ui/resource-edit-prompt";

describe("resource edit thread prompts", () => {
  it("gives the thread an unambiguous writable resource locator", () => {
    expect(
      buildPluginEditThreadPrompt({
        name: "Pattern Atlas",
        path: "/Users/me/plugins/pattern-atlas",
      }),
    ).toBe(
      'Edit the Cloudroom plugin "Pattern Atlas" at /Users/me/plugins/pattern-atlas. I want to ',
    );
    expect(
      buildSkillEditThreadPrompt({
        id: "skill_abc123",
        name: "Review PR",
        path: "/Users/me/.bb/skills/review-pr/SKILL.md",
      }),
    ).toBe(
      'Edit the Cloudroom skill "Review PR" (ID skill_abc123) at /Users/me/.bb/skills/review-pr/SKILL.md. Inspect it with room-cli skill show skill_abc123 --json and pass that revision to room-cli skill update when saving. I want to ',
    );
    expect(
      buildAutomationEditThreadPrompt({
        name: "Daily triage",
        projectId: "proj_123",
        automationId: "auto_456",
      }),
    ).toBe(
      'Edit the Cloudroom loop "Daily triage" (ID auto_456) in project proj_123. I want to ',
    );
  });
});
