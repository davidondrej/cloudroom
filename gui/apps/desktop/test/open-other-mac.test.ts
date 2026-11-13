import { describe, expect, it } from "vitest";
import { openWithRetries, type ComputersResult } from "../src/computers.js";

describe("openWithRetries", () => {
  const run = (answers: ComputersResult<string>[]) => {
    let tries = 0;
    const opened = openWithRetries<string>({
      current: () => true,
      open: async () => answers[tries++] ?? { ok: false, reason: "offline" },
      sleep: async () => {},
    });
    return opened.then((url) => ({ url, tries }));
  };

  it("keeps trying a Mac that blinks offline", async () => {
    expect(
      await run([
        { ok: false, reason: "offline" },
        { ok: true, value: "https://pro.cloudroom.run" },
      ]),
    ).toEqual({
      url: "https://pro.cloudroom.run",
      tries: 2,
    });
  });

  it("gives up at once when trying again cannot help", async () => {
    expect(await run([{ ok: false, reason: "no-credential" }])).toEqual({
      url: null,
      tries: 1,
    });
  });
});
