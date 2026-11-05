import { describe, expect, it } from "vitest";
import { busiestWeekday, smoothSeries, splitSkills } from "./SkillUsageSection";

const skill = (name: string, daily: number[]) => ({
  name,
  daily,
  total: daily.reduce((sum, count) => sum + count, 0),
});

describe("skill usage helpers", () => {
  it("smooths without changing the series length or going negative", () => {
    const smoothed = smoothSeries([0, 0, 10, 0, 0]);
    expect(smoothed).toHaveLength(5);
    expect(smoothed[2]).toBeLessThan(10);
    expect(smoothed[0]).toBeGreaterThan(0);
    expect(Math.min(...smoothed)).toBeGreaterThanOrEqual(0);
  });

  it("lists installed skills with no runs as never used, once each", () => {
    const used = [skill("designs", [3]), skill("prod-push", [1])];
    const result = splitSkills(used, [
      "prod-push",
      "zeta",
      "cloudroom:alpha",
      "alpha",
    ]);
    expect(result.used.map(({ name }) => name)).toEqual([
      "designs",
      "prod-push",
    ]);
    expect(result.unused).toEqual(["alpha", "zeta"]);
  });

  it("finds the busiest weekday from the range start", () => {
    // 2026-11-02 is a Monday.
    expect(busiestWeekday([skill("a", [1, 5, 0])], "2026-11-02")).toBe("Tue");
    expect(busiestWeekday([skill("a", [0, 0])], "2026-11-02")).toBeNull();
  });
});
