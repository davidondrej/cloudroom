import type {
  EditableSkillScope,
  SkillScope,
  SkillSummary,
} from "@cloudroom/server-contract";

const SKILL_ROOT_LABELS: Record<
  Exclude<SkillScope, "provider-user" | "provider-project">,
  string
> = {
  "bb-builtin": "Built-in",
  "bb-user": "Cloudroom · user",
  "bb-project": "Cloudroom · project",
  "shared-user": "Shared · user",
  "shared-project": "Shared · project",
  plugin: "Plugin",
};

export function skillScopeLabel(
  skill: Pick<SkillSummary, "scope" | "provider">,
  providerDisplayName?: string,
): string {
  if (skill.scope === "provider-user" || skill.scope === "provider-project") {
    const root = skill.scope === "provider-user" ? "user" : "project";
    const provider = skill.provider;
    const providerLabel =
      providerDisplayName ?? (provider === null ? "Provider" : provider);
    return `${providerLabel} · ${root}`;
  }
  return SKILL_ROOT_LABELS[skill.scope];
}

export function isSkillEditable(
  skill: SkillSummary,
): skill is SkillSummary & { scope: EditableSkillScope } {
  switch (skill.scope) {
    case "bb-user":
    case "bb-project":
      return true;
    case "provider-user":
    case "provider-project":
      return skill.manageable;
    case "shared-user":
    case "shared-project":
    case "bb-builtin":
    case "plugin":
      return false;
  }
}

/** One skill and every agent's copy of it. `copies[0]` is the one a row opens. */
export interface SkillGroup {
  id: string;
  name: string;
  copies: readonly SkillSummary[];
}

function skillLevel(skill: SkillSummary): string {
  switch (skill.scope) {
    case "bb-builtin":
      return "builtin";
    case "plugin":
      // Two plugins can each ship a different skill with the same name.
      return `plugin:${skill.pluginId ?? ""}`;
    case "bb-project":
    case "provider-project":
    case "shared-project":
      return "project";
    case "bb-user":
    case "provider-user":
    case "shared-user":
      return "user";
  }
}

/**
 * The server lists one entry per SKILL.md, so a skill installed for Codex,
 * Claude Code and Cursor comes back 3 times. Group copies by name and level:
 * a project skill and a personal skill with the same name stay separate.
 */
export function groupSkillCopies(
  skills: readonly SkillSummary[],
): SkillGroup[] {
  const groups = new Map<string, SkillSummary[]>();
  for (const skill of skills) {
    const key = `${skillLevel(skill)}\0${skill.name}`;
    const copies = groups.get(key);
    if (copies === undefined) groups.set(key, [skill]);
    else copies.push(skill);
  }
  return [...groups.values()].map((copies) => ({
    id: copies[0].id,
    name: copies[0].name,
    copies,
  }));
}
