import type { BbPluginApi } from "@get-bb/plugin-sdk";

export default async function plugin(bb: BbPluginApi) {
  const settings = bb.settings.define({
    skills: {
      type: "boolean",
      label: "Enable bundled skills",
      description: "Make the selected Cloudroom guide skills available to agents.",
      default: true,
    },
    bbCli: {
      type: "boolean",
      label: "Cloudroom CLI skill",
      description: "Inspect and manage Cloudroom through the CLI.",
      default: true,
    },
    pluginAuthoring: {
      type: "boolean",
      label: "Plugin authoring skill",
      description: "Create and change Cloudroom plugins and SDK extensions.",
      default: true,
    },
    skillCreator: {
      type: "boolean",
      label: "Skill creator skill",
      description: "Create and improve Cloudroom skills.",
      default: true,
    },
  });
  let current = await settings.get();
  settings.onChange((next) => {
    current = next;
  });
  bb.agents.configure(() => ({
    tools: [],
    skills: current.skills
      ? [
          ...(current.bbCli ? ["room-cli"] : []),
          ...(current.pluginAuthoring ? ["plugin-authoring"] : []),
          ...(current.skillCreator ? ["skill-creator"] : []),
        ]
      : [],
  }));
}
