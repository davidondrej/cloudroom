import { expect, it, vi } from "vitest";
import {
  isPiLockContention,
  runPiTransientAuthConstruction,
} from "./rpc-session.js";

it("exhausts the initial construction and eight transient-auth retries deterministically", async () => {
  const errors = Array.from(
    { length: 9 },
    (_, index) => new Error(`mismatch ${index + 1}`),
  );
  const attempt = vi.fn(async () => ({
    ok: false as const,
    error: errors[attempt.mock.calls.length - 1]!,
  }));
  const discardFailedAttempt = vi.fn();
  const waitBeforeRetry = vi.fn(async () => undefined);

  await expect(
    runPiTransientAuthConstruction({
      attempt,
      discardFailedAttempt,
      isClosed: () => false,
      waitBeforeRetry,
    }),
  ).rejects.toBe(errors[8]);

  expect(attempt).toHaveBeenCalledTimes(9);
  expect(discardFailedAttempt).toHaveBeenCalledTimes(8);
  expect(waitBeforeRetry).toHaveBeenCalledTimes(8);
});

it("never spawns again for a session closed during the retry wait", async () => {
  let closed = false;
  const error = new Error("locked");
  const attempt = vi.fn(async () => ({ ok: false as const, error }));
  await expect(
    runPiTransientAuthConstruction({
      attempt,
      discardFailedAttempt: () => undefined,
      isClosed: () => closed,
      waitBeforeRetry: async () => {
        closed = true;
      },
    }),
  ).rejects.toBe(error);
  expect(attempt).toHaveBeenCalledTimes(1);
});

it("sees Pi's lock crash through colored stderr", () => {
  expect(isPiLockContention("{\n  code: \u001b[32m'ELOCKED'\u001b[39m\n}")).toBe(true);
  expect(isPiLockContention("Error: EACCES")).toBe(false);
});
