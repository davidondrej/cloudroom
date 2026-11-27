import { describe, expect, it } from "vitest";
import { codexLinuxThreadStartError } from "./linux-sandbox.js";

describe("codexLinuxThreadStartError", () => {
  it("turns Codex's raw AGENTS.md loopback failure into Linux setup guidance (#2828)", () => {
    const raw =
      "error creating thread: failed to load AGENTS.md instructions for environment `local`: fs sandbox helper failed with status exit status: 1: bwrap: loopback: Failed RTM_NEWADDR: Operation not permitted";
    const guidance = codexLinuxThreadStartError(raw);
    expect(guidance).toContain(
      "Codex can't start its sandbox on this Linux computer",
    );
    expect(guidance).toContain("Failed RTM_NEWADDR: Operation not permitted");
    expect(guidance?.slice(0, 300)).toContain(
      "https://developers.openai.com/codex/concepts/sandboxing#prerequisites",
    );
    expect(
      codexLinuxThreadStartError("error creating thread: model not found"),
    ).toBeNull();
  });
});
