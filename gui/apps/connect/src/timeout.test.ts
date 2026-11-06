import { describe, expect, it } from "vitest";
import { RelayTimeout, timedDb } from "./timeout";

const never = () => new Promise<never>(() => {});

/** A fake D1 whose queries answer from `answers` in order; `never` means the answer is lost. */
function fakeDb(answers: (() => Promise<unknown>)[]) {
  let calls = 0;
  const statement = { bind: () => statement, first: () => answers[calls++]!() };
  return { db: { prepare: () => statement } as unknown as D1Database, calls: () => calls };
}

describe("timedDb", () => {
  it("retries a lost read once and returns the answer", async () => {
    const fake = fakeDb([never, () => Promise.resolve({ id: "s1" })]);
    await expect(timedDb(fake.db, 20).prepare("SELECT * FROM server WHERE handle = ?").bind("h").first()).resolves.toEqual({ id: "s1" });
    expect(fake.calls()).toBe(2);
  });

  it("fails a read that is lost twice instead of hanging", async () => {
    const fake = fakeDb([never, never]);
    await expect(timedDb(fake.db, 20).prepare("SELECT 1").first()).rejects.toBeInstanceOf(RelayTimeout);
  });

  it("never retries a write, which may have happened", async () => {
    const fake = fakeDb([never, () => Promise.resolve(null)]);
    await expect(timedDb(fake.db, 20).prepare("DELETE FROM code WHERE code_hash = ?").bind("x").first()).rejects.toBeInstanceOf(RelayTimeout);
    expect(fake.calls()).toBe(1);
  });
});
