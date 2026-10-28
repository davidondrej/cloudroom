import { describe, expect, it, vi } from "vitest";
import {
  setupCommandOutputTestEnvironment,
  collectLogLines,
  runCommand,
} from "../helpers/command-output-harness.js";
import type { CommandRegistrar } from "../helpers/command-output-harness.js";
import { registerManagerCommands } from "../../commands/manager.js";

describe("room-cli manager command output", () => {
  setupCommandOutputTestEnvironment();

  const register: CommandRegistrar = (program) =>
    registerManagerCommands(program);

  it("room-cli manager exits with a parent-thread replacement message", async () => {
    await expect(runCommand(["manager"], register)).rejects.toThrow(
      "process.exit:1",
    );

    const error = collectLogLines(vi.mocked(console.error)).join("\n");
    expect(error).toContain("Manager threads were replaced by parent threads.");
    expect(error).toContain("room-cli thread spawn --parent-thread <id>");
  });

  it("room-cli manager subcommands exit with the same replacement message", async () => {
    await expect(
      runCommand(["manager", "list", "project-123"], register),
    ).rejects.toThrow("process.exit:1");

    const error = collectLogLines(vi.mocked(console.error)).join("\n");
    expect(error).toContain("Manager threads were replaced by parent threads.");
    expect(error).toContain("room-cli thread list --parent-thread <id>");
  });
});
