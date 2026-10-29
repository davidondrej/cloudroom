import { expect, it, vi } from "vitest";

const crossSpawn = vi.hoisted(() => vi.fn());
vi.mock("cross-spawn", () => ({ default: crossSpawn }));

it("starts captured-output commands without a console window", async () => {
  const { PassThrough } = await import("node:stream");
  const { EventEmitter } = await import("node:events");
  const child = Object.assign(new EventEmitter(), {
    stdout: new PassThrough(),
    stderr: new PassThrough(),
  });
  crossSpawn.mockReturnValue(child);
  const { spawnPortableOutputProcess } = await import("../src/index.js");
  spawnPortableOutputProcess({ command: "git", args: ["--version"] });
  expect(crossSpawn).toHaveBeenCalledWith(
    "git",
    ["--version"],
    expect.objectContaining({ windowsHide: true }),
  );
});
