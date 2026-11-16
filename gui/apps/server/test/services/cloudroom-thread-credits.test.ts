import { expect, it } from "vitest";
import { commandLabel, commandSpans, splitCredits, type StartedCommand } from "../../src/services/cloudroom/thread-credits.js";

const MIN = 60_000, T = 1_800_000_000_000;
const commands = (started: StartedCommand[], ended: [string, number][] = [], turnEnds: [string, number][] = [], currentTurn: string | null = null) =>
  ({ started, ended: new Map(ended), turnEnds: new Map(turnEnds), currentTurn });

it("ends an interrupted command with its turn, so it never takes a later turn's credits", () => {
  const spans = commandSpans(commands([
    { item: "a", turn: "t1", at: T, command: "pnpm test" }, // interrupted: no end of its own; t1 ended
    { item: "b", turn: "t0", at: T - 10 * MIN, command: "cargo build" }, // its turn never ended and isn't current: dropped
    { item: "c", turn: "t2", at: T + 5 * MIN, command: "tsx fuzz.ts" }, // still running in the working turn
  ], [], [["t1", T + MIN]], "t2"), true, T + 7 * MIN);
  expect(spans).toEqual([
    { start: T, end: T + MIN, name: "pnpm test" },
    { start: T + 5 * MIN, end: T + 7 * MIN, name: "tsx fuzz.ts" },
  ]);
  const split = splitCredits(30, [[T + MIN, 60_000], [T + 6 * MIN, 60_000], [T + 7 * MIN, 60_000]], spans);
  expect(split.rows).toEqual([{ name: "tsx fuzz.ts", credits: 20, ms: 2 * MIN }, { name: "pnpm test", credits: 10, ms: MIN }]);
});

it("keeps the billed total when no CPU minutes have arrived yet", () => {
  expect(splitCredits(110, [], [])).toEqual({ credits: 110, pending: true, rows: [] });
  expect(splitCredits(0.2, [[T, 1000]], [])).toEqual({ credits: 0, pending: false, rows: [] });
});

it("shows rows that add up to the total", () => {
  const minutes: [number, number][] = [[T + MIN, 1000], [T + 2 * MIN, 1000], [T + 3 * MIN, 1000]];
  const spans = [0, 1, 2].map((i) => ({ start: T + i * MIN, end: T + (i + 1) * MIN, name: `tool${i}` }));
  const two = splitCredits(2, minutes, spans);
  expect(two.rows.reduce((sum, row) => sum + row.credits, 0)).toBe(2);
  const many = splitCredits(110, Array.from({ length: 9 }, (_, i) => [T + (i + 1) * MIN, 1000 + i * 137] as [number, number]),
    Array.from({ length: 9 }, (_, i) => ({ start: T + i * MIN, end: T + (i + 1) * MIN, name: `step${i}` })));
  expect(many.rows).toHaveLength(5);
  expect(many.rows.at(-1)).toMatchObject({ name: "5 more commands", rest: true });
  expect(many.rows.reduce((sum, row) => sum + row.credits, 0)).toBe(110);
});

it("splits a minute shared by two commands by how long each ran", () => {
  const split = splitCredits(40, [[T + MIN, 60_000]], [
    { start: T, end: T + 45_000, name: "vitest" },
    { start: T + 45_000, end: T + MIN, name: "tsc" },
  ]);
  expect(split.rows).toEqual([{ name: "vitest", credits: 30, ms: 45_000 }, { name: "tsc", credits: 10, ms: 15_000 }]);
});

it("labels a command by its program and what it runs, never its other arguments", () => {
  expect(commandLabel("/bin/bash -lc 'cd gui && pnpm exec vitest run src'")).toBe("vitest");
  expect(commandLabel("API_KEY=secret timeout 60 node scripts/run.js --token abc")).toBe("node run.js");
  expect(commandLabel("corepack pnpm install --frozen-lockfile")).toBe("pnpm install");
  expect(commandLabel("curl -H 'Authorization: Bearer xyz' https://example.com")).toBe("curl");
});
