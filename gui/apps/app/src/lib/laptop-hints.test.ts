import { describe, expect, it } from "vitest";
import { pickLaptopHint, type LaptopInput } from "./laptop-hints";

const NOW = 1_800_000_000_000;
const MIN = 60_000;
const HOUR = 60 * MIN;
const calm = { battery: null, cpuBusySince: null, memoryRedSince: null, hotSince: null, diskFreeGb: 200, cpu: null, memory: null, heat: null, diskTotalGb: 500, pause: null };
const base: LaptopInput = { vitals: calm, drops: 0, online: true, place: "new-thread", github: true, recentThreads: { local: 20, cloud: 0 }, threadId: null, working: 1, shown: [], active: null, now: NOW };
const pick = (input: Partial<LaptopInput>) => pickLaptopHint({ ...base, ...input });

describe("pickLaptopHint", () => {
  it("shows only at real limits", () => {
    expect(pick({})).toBeNull();
    expect(pick({ vitals: { ...calm, battery: 31 } })).toBeNull();
    expect(pick({ vitals: { ...calm, battery: 30 } })).toBe("battery");
    expect(pick({ vitals: { ...calm, cpuBusySince: NOW - 2.9 * MIN } })).toBeNull();
    expect(pick({ vitals: { ...calm, cpuBusySince: NOW - 3 * MIN } })).toBe("cpu");
    expect(pick({ vitals: { ...calm, memoryRedSince: NOW - 1.5 * MIN } })).toBe("memory");
    expect(pick({ vitals: { ...calm, hotSince: NOW - 1.5 * MIN } })).toBe("heat");
    expect(pick({ vitals: { ...calm, diskFreeGb: 14 } })).toBe("disk");
    expect(pick({ vitals: { ...calm, diskFreeGb: 15 } })).toBeNull();
    expect(pick({ drops: 3 })).toBe("network");
    expect(pick({ drops: 3, online: false })).toBeNull();
    expect(pick({ drops: 3, github: false })).toBeNull();
    // Moments: 3+ agents at once, or a sleep or quit that stopped this thread, for an hour after it ends.
    expect(pick({ working: 2 })).toBeNull();
    expect(pick({ working: 3 })).toBe("crowded");
    const slept = { ...calm, pause: { why: "sleep" as const, from: NOW - 3 * HOUR, to: NOW - 10 * MIN, threads: ["thr_a"] } };
    expect(pick({ vitals: slept, place: "running", threadId: "thr_a" })).toBe("slept");
    expect(pick({ vitals: { ...slept, pause: { ...slept.pause, why: "quit" } }, place: "running", threadId: "thr_a" })).toBe("quit");
    expect(pick({ vitals: slept, place: "running", threadId: "thr_b" })).toBeNull();
    expect(pick({ vitals: slept, threadId: "thr_a" })).toBeNull();
    expect(pick({ vitals: { ...slept, pause: { ...slept.pause, to: NOW - 61 * MIN } }, place: "running", threadId: "thr_a" })).toBeNull();
    expect(pick({ vitals: { ...slept, battery: 20 }, place: "running", threadId: "thr_a", working: 4 })).toBe("battery");
  });

  it("puts battery first, then the slow Mac, internet, and disk, on new and running threads alike", () => {
    const busy = { ...calm, battery: 20, diskFreeGb: 5, memoryRedSince: NOW - 5 * MIN };
    expect(pick({ vitals: busy })).toBe("battery");
    expect(pick({ vitals: { ...busy, battery: null }, place: "running" })).toBe("memory");
    expect(pick({ vitals: { ...calm, diskFreeGb: 5 }, drops: 4, place: "running" })).toBe("network");
    expect(pick({ vitals: { ...calm, diskFreeGb: 5 }, place: "running" })).toBe("disk");
    expect(pick({ drops: 4, github: false, place: "running" })).toBe("network");
  });

  it("shows only to people who mostly use Local: 85%+ of 10 or more threads", () => {
    const low = { vitals: { ...calm, battery: 20 } };
    expect(pick({ ...low, recentThreads: { local: 9, cloud: 0 } })).toBeNull();
    expect(pick({ ...low, recentThreads: { local: 10, cloud: 0 } })).toBe("battery");
    expect(pick({ ...low, recentThreads: { local: 17, cloud: 3 } })).toBe("battery");
    expect(pick({ ...low, recentThreads: { local: 16, cloud: 4 } })).toBeNull();
  });

  it("caps hints at 2 a week and each reason at once a week", () => {
    const low = { vitals: { ...calm, battery: 20, diskFreeGb: 5 } };
    expect(pick({ ...low, shown: [{ kind: "battery", at: NOW - HOUR }] })).toBe("disk");
    expect(pick({ ...low, shown: [{ kind: "battery", at: NOW - HOUR }], active: "battery" })).toBe("battery");
    expect(pick({ ...low, shown: [{ kind: "network", at: NOW - HOUR }, { kind: "load", at: NOW - 2 * HOUR }] })).toBeNull();
    expect(pick({ ...low, shown: [{ kind: "battery", at: NOW - 8 * 24 * HOUR }] })).toBe("battery");
  });
});
