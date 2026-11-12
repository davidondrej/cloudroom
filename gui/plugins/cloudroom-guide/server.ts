import type { BbPluginApi } from "@get-bb/plugin-sdk";

/** One switch per bundled skill: setting → [skill, label, description]. */
const SKILLS = {
  roomCli: ["room-cli", "Cloudroom CLI skill", "Inspect and manage Cloudroom through the CLI."],
  pluginAuthoring: [
    "plugin-authoring",
    "Plugin authoring skill",
    "Create and change Cloudroom plugins and SDK extensions.",
  ],
  skillCreator: ["skill-creator", "Skill creator skill", "Create and improve Cloudroom skills."],
} as const;

const toggle = (label: string, description: string) =>
  ({ type: "boolean", label, description, default: true }) as const;

export default async function plugin(bb: BbPluginApi) {
  const settings = bb.settings.define({
    skills: toggle(
      "Enable bundled skills",
      "Make the selected Cloudroom guide skills available to agents.",
    ),
    roomCli: toggle(SKILLS.roomCli[1], SKILLS.roomCli[2]),
    pluginAuthoring: toggle(SKILLS.pluginAuthoring[1], SKILLS.pluginAuthoring[2]),
    skillCreator: toggle(SKILLS.skillCreator[1], SKILLS.skillCreator[2]),
  });
  let on = await settings.get();
  settings.onChange((next) => {
    on = next;
  });
  bb.agents.configure(() => ({
    tools: [],
    skills: (["roomCli", "pluginAuthoring", "skillCreator"] as const)
      .filter((key) => on.skills && on[key])
      .map((key) => SKILLS[key][0]),
  }));
}
