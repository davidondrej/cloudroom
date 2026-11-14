import { expect, it } from "vitest";
import { cloudServiceTier } from "../../src/services/cloudroom/teleport.js";

it.each([
  [undefined, "default"],
  ["default", "default"],
  ["fast", "fast"],
  ["ultrafast", "default"],
] as const)("teleports a %s tier to Cloud as %s", (tier, expected) => {
  expect(cloudServiceTier(tier)).toBe(expected);
});
