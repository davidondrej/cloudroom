import { describe, expect, it } from "vitest";
import { deleteMachine, machineByCredential, serverByHandle, sha256Hex } from "./store";
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

describe("serverByHandle", () => {
  // A canceled request's lookup never answers. Sharing it froze every later request for that Mac (2026-11-10).
  it("starts its own lookup when another request's lookup never answers", async () => {
    const fake = fakeDb([never, () => Promise.resolve({ id: "s1", handle: "mac1" })]);
    void serverByHandle(fake.db, "mac1");
    await expect(serverByHandle(fake.db, "mac1")).resolves.toMatchObject({ id: "s1" });
  });
});

describe("machineByCredential", () => {
  // The lookup started before the host was removed and answered after. Saving it kept the host working for 15 s.
  it("forgets a removed host even when a lookup of it was under way", async () => {
    const hash = await sha256Hex("key1");
    let answerLate!: (row: unknown) => void;
    const fake = fakeDb([
      () => new Promise((resolve) => (answerLate = resolve)),
      () => Promise.resolve({ handle: "host1", credential_hash: hash }),
      () => Promise.resolve(null),
    ]);
    const early = machineByCredential(fake.db, "key1");
    await new Promise((resolve) => setTimeout(resolve, 5));
    await deleteMachine(fake.db, "mac1", "m1");
    answerLate({ id: "m1", handle: "host1", credential_hash: hash, owner_server_id: "mac1" });
    await early;
    await expect(machineByCredential(fake.db, "key1")).resolves.toBeNull();
  });
});
