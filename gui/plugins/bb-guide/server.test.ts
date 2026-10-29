import { readdirSync } from "node:fs";
import { describe, expect, it } from "vitest";
import {
  createFakePluginHost,
  makePluginAgentConfigurationContext,
} from "@get-bb/plugin-sdk/testing";
import plugin from "./server.js";

const bundledSkills = readdirSync(new URL("./skills", import.meta.url), {
  withFileTypes: true,
})
  .filter((entry) => entry.isDirectory())
  .map((entry) => entry.name);

it("keeps the skill switches across reloads", async () => {
  const { bb, harness } = createFakePluginHost({
    pluginId: "bb-guide",
    agentSkillIds: bundledSkills,
  });
  try {
    await plugin(bb);
    const skills = async () =>
      (
        await harness.behavior.resolveAgentConfiguration(
          makePluginAgentConfigurationContext(),
        )
      ).skills;
    expect((await skills()).sort()).toEqual([...bundledSkills].sort());
    await harness.behavior.setSettings({ pluginAuthoring: false });
    expect(await skills()).toEqual(["room-cli", "skill-creator"]);
    await harness.behavior.setSettings({ skills: false });
    expect(await skills()).toEqual([]);
    await harness.lifecycle.reload(plugin);
    expect(await skills()).toEqual([]);
    await harness.behavior.setSettings({ skills: true });
    expect(await skills()).toEqual(["room-cli", "skill-creator"]);
  } finally {
    await harness.lifecycle.dispose();
  }
});

describe("individual skill selection", () => {
  it.each([
    ["bbCli", ["plugin-authoring", "skill-creator"]],
    ["pluginAuthoring", ["room-cli", "skill-creator"]],
    ["skillCreator", ["room-cli", "plugin-authoring"]],
  ])("disables %s", async (key, expected) => {
    const { bb, harness } = createFakePluginHost({
      pluginId: "bb-guide",
      agentSkillIds: bundledSkills,
    });
    try {
      await plugin(bb);
      await harness.behavior.setSettings({ [key]: false });
      expect(
        (
          await harness.behavior.resolveAgentConfiguration(
            makePluginAgentConfigurationContext(),
          )
        ).skills,
      ).toEqual(expected);
    } finally {
      await harness.lifecycle.dispose();
    }
  });
});
