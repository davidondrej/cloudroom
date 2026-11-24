import { describe, expect, it } from "vitest";
import { BACK_CHECK_MS, createReturnWatch, openWithRetries, type ComputersResult } from "../src/computers.js";

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

describe("createReturnWatch", () => {
  const watch = () => {
    let now = 0;
    const returnWatch = createReturnWatch(() => now);
    return { next: (live: boolean, at: number) => ((now = at), returnWatch.next(live)), reset: returnWatch.reset };
  };

  it("goes back only to a Mac that stayed online", () => {
    const { next } = watch();
    expect(next(true, 0)).toBe("check-again");
    expect(next(true, BACK_CHECK_MS / 2)).toBe("wait");
    expect(next(true, BACK_CHECK_MS)).toBe("return");
  });

  it("ignores a closed-lid Mac that woke for a moment", () => {
    const { next } = watch();
    expect(next(true, 0)).toBe("check-again");
    expect(next(false, BACK_CHECK_MS)).toBe("wait");
    expect(next(true, 2 * BACK_CHECK_MS)).toBe("check-again");
  });

  it("starts over after a try", () => {
    const { next, reset } = watch();
    next(true, 0);
    reset();
    expect(next(true, BACK_CHECK_MS)).toBe("check-again");
  });
});
