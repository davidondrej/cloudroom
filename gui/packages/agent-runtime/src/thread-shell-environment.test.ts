import { describe, expect, it } from "vitest";
import { resolveThreadEnvironment } from "./thread-shell-environment.js";

describe("resolveThreadEnvironment", () => {
  it("masks shell secrets in diagnostics but passes them to the provider (#1938)", () => {
    const { envVars, entries } = resolveThreadEnvironment({
      environmentId: "env-1",
      threadId: "thread-1",
      baseShellEnv: { GH_TOKEN: "fake-gh-token", PATH: "/usr/bin" },
      contributedEnv: [],
    });
    expect(envVars.GH_TOKEN).toBe("fake-gh-token");
    expect(entries).toContainEqual({
      name: "GH_TOKEN",
      source: "shell",
      value: { masked: true },
    });
    expect(entries).toContainEqual({
      name: "PATH",
      source: "shell",
      value: "/usr/bin",
    });
    expect(JSON.stringify(entries)).not.toContain("fake-gh-token");
  });
});
