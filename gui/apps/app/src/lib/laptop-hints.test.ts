import { describe, expect, it } from "vitest";
import { pickLaptopHint, type LaptopInput } from "./laptop-hints";

const NOW = 1_800_000_000_000;
const MIN = 60_000;
const HOUR = 60 * MIN;
const calm = { battery: null, cpuBusySince: null, memoryRedSince: null, hotSince: null, diskFreeGb: 200 };
const base: LaptopInput = { vitals: calm, drops: 0, online: true, place: "new-thread", github: true, paid: true, lastNewCloudAt: null, shown: [], active: null, now: NOW };
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
  });

  it("puts battery first and keeps running threads to battery and internet", () => {
    const busy = { ...calm, battery: 20, diskFreeGb: 5, memoryRedSince: NOW - 5 * MIN };
    expect(pick({ vitals: busy })).toBe("battery");
    expect(pick({ vitals: { ...busy, battery: null }, place: "running" })).toBeNull();
    expect(pick({ drops: 4, github: false, place: "running" })).toBe("network");
  });

  it("skips people who started a Cloud thread recently", () => {
    const low = { vitals: { ...calm, battery: 20 } };
    expect(pick({ ...low, lastNewCloudAt: NOW - 23 * HOUR })).toBeNull();
    expect(pick({ ...low, lastNewCloudAt: NOW - 25 * HOUR })).toBe("battery");
    expect(pick({ ...low, paid: false, lastNewCloudAt: NOW - 11 * HOUR })).toBeNull();
    expect(pick({ ...low, paid: false, lastNewCloudAt: NOW - 13 * HOUR })).toBe("battery");
  });

  it("caps hints at 2 a week and each reason at once a week", () => {
    const low = { vitals: { ...calm, battery: 20, diskFreeGb: 5 } };
    expect(pick({ ...low, shown: [{ kind: "battery", at: NOW - HOUR }] })).toBe("disk");
    expect(pick({ ...low, shown: [{ kind: "battery", at: NOW - HOUR }], active: "battery" })).toBe("battery");
    expect(pick({ ...low, shown: [{ kind: "network", at: NOW - HOUR }, { kind: "load", at: NOW - 2 * HOUR }] })).toBeNull();
    expect(pick({ ...low, shown: [{ kind: "battery", at: NOW - 8 * 24 * HOUR }] })).toBe("battery");
  });
});
