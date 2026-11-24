import { describe, expect, it } from "vitest";
import { LOOP_TEMPLATES } from "../templates.js";
import {
  cronCadence,
  formatDetailScheduleStatusLabel,
  formatOverviewScheduleMetadata,
  formatScheduleStatusLabel,
  getOneShotLifecycle,
  matchesAutomationStatusFilters,
  oneShotLifecycleAllowsToggle,
} from "../lib/format-schedule.js";

const NOW = 2_000;

describe("automation list and detail states", () => {
  it("omits paused detail metadata without hiding an active next run", () => {
    const pausedSchedule = {
      enabled: false,
      nextRunAt: null,
      trigger: {
        triggerType: "schedule" as const,
        cron: "0 * * * *",
        timezone: "UTC",
      },
      now: NOW,
    };

    expect(formatDetailScheduleStatusLabel(pausedSchedule)).toBeNull();
    expect(
      formatDetailScheduleStatusLabel({
        ...pausedSchedule,
        enabled: true,
        nextRunAt: NOW + 60_000,
      }),
    ).toMatch(/^Next /);
  });

  it("filters active versus paused automations", () => {
    expect(
      matchesAutomationStatusFilters({ enabled: true, nextRunAt: NOW }, []),
    ).toBe(true);
    expect(
      matchesAutomationStatusFilters({ enabled: true, nextRunAt: NOW }, [
        "active",
      ]),
    ).toBe(true);
    expect(
      matchesAutomationStatusFilters({ enabled: false, nextRunAt: null }, [
        "paused",
      ]),
    ).toBe(true);
    expect(
      matchesAutomationStatusFilters(
        {
          enabled: false,
          nextRunAt: null,
          trigger: { triggerType: "once", runAt: NOW - 1 },
          runCount: 1,
          lastRunStatus: "running",
          now: NOW,
        },
        ["active"],
      ),
    ).toBe(true);
    expect(
      matchesAutomationStatusFilters(
        {
          enabled: false,
          nextRunAt: null,
          trigger: { triggerType: "once", runAt: NOW - 1 },
          runCount: 1,
          lastRunStatus: "succeeded",
          now: NOW,
        },
        ["paused"],
      ),
    ).toBe(true);
    expect(
      matchesAutomationStatusFilters(
        {
          enabled: false,
          nextRunAt: null,
          trigger: { triggerType: "once", runAt: NOW - 1 },
          runCount: 0,
          lastRunStatus: null,
          now: NOW,
        },
        ["paused"],
      ),
    ).toBe(false);
    expect(
      matchesAutomationStatusFilters({ enabled: false, nextRunAt: null }, [
        "active",
        "paused",
      ]),
    ).toBe(true);
  });
});

describe("one-shot automation lifecycle", () => {
  it("omits row state repeated by icons or controls and separates the next-run label", () => {
    expect(
      formatOverviewScheduleMetadata({
        enabled: false,
        nextRunAt: null,
        trigger: { triggerType: "once", runAt: NOW - 1_000 },
        runCount: 1,
        lastRunStatus: "failed",
        now: NOW,
      }),
    ).toBeNull();

    expect(
      formatOverviewScheduleMetadata({
        enabled: false,
        nextRunAt: null,
        trigger: { triggerType: "once", runAt: NOW - 1_000 },
        runCount: 1,
        lastRunStatus: "succeeded",
        now: NOW,
      }),
    ).toBeNull();

    expect(
      formatOverviewScheduleMetadata({
        enabled: false,
        nextRunAt: NOW + 60_000,
        trigger: {
          triggerType: "schedule",
          cron: "0 * * * *",
          timezone: "UTC",
        },
        now: NOW,
      }),
    ).toBeNull();

    expect(
      formatOverviewScheduleMetadata({
        enabled: false,
        nextRunAt: null,
        trigger: { triggerType: "once", runAt: NOW - 1 },
        runCount: 0,
        lastRunStatus: null,
        now: NOW,
      }),
    ).toBeNull();

    const next = formatOverviewScheduleMetadata({
      enabled: true,
      nextRunAt: NOW + 60_000,
      trigger: {
        triggerType: "schedule",
        cron: "0 * * * *",
        timezone: "UTC",
      },
      now: NOW,
    });
    expect(next?.isNextRun).toBe(true);
    expect(next?.text).not.toContain("Next");
  });

  it("allows pausing a scheduled run and resuming a future paused run", () => {
    const trigger = { triggerType: "once" as const, runAt: NOW + 1_000 };

    expect(
      getOneShotLifecycle({
        enabled: true,
        trigger,
        runCount: 0,
        lastRunStatus: null,
        now: NOW,
      }),
    ).toBe("scheduled");
    expect(
      getOneShotLifecycle({
        enabled: false,
        trigger,
        runCount: 0,
        lastRunStatus: null,
        now: NOW,
      }),
    ).toBe("paused");
    expect(oneShotLifecycleAllowsToggle("scheduled")).toBe(true);
    expect(oneShotLifecycleAllowsToggle("paused")).toBe(true);
  });

  it("locks a paused run once its deadline has expired", () => {
    const trigger = { triggerType: "once" as const, runAt: NOW - 1 };
    const lifecycle = getOneShotLifecycle({
      enabled: false,
      trigger,
      runCount: 0,
      lastRunStatus: null,
      now: NOW,
    });

    expect(lifecycle).toBe("expired");
    expect(oneShotLifecycleAllowsToggle(lifecycle)).toBe(false);
    expect(
      formatScheduleStatusLabel({
        enabled: false,
        nextRunAt: null,
        trigger,
        runCount: 0,
        lastRunStatus: null,
        now: NOW,
      }),
    ).toBe("Expired — edit to reschedule");
  });

  it.each([
    ["running", "running", "Running"],
    ["succeeded", "completed", "Completed"],
    ["failed", "failed", "Failed"],
    ["skipped", "skipped", "Skipped"],
  ] as const)(
    "shows a terminal %s run truthfully",
    (lastRunStatus, expectedLifecycle, expectedLabel) => {
      const trigger = { triggerType: "once" as const, runAt: NOW - 1 };
      const lifecycle = getOneShotLifecycle({
        enabled: false,
        trigger,
        runCount: 1,
        lastRunStatus,
        now: NOW,
      });

      expect(lifecycle).toBe(expectedLifecycle);
      expect(oneShotLifecycleAllowsToggle(lifecycle)).toBe(false);
      expect(
        formatScheduleStatusLabel({
          enabled: false,
          nextRunAt: null,
          trigger,
          runCount: 1,
          lastRunStatus,
          now: NOW,
        }),
      ).toBe(expectedLabel);
    },
  );
});

describe("cronCadence", () => {
  it("shortens the schedules templates use", () => {
    expect(cronCadence("0 */2 * * *")).toBe("Every 2h");
    expect(cronCadence("0 * * * *")).toBe("Every 1h");
    expect(cronCadence("*/30 * * * *")).toBe("Every 30m");
    expect(cronCadence("0 3 * * *")).toBe("Daily 3AM");
    expect(cronCadence("30 15 * * *")).toBe("Daily 3:30PM");
    expect(cronCadence("0 0 * * *")).toBe("Daily 12AM");
    expect(cronCadence("0 8-22/3 * * *")).toBe("Every 3h, 8AM-10PM");
    expect(cronCadence("0 8 */2 * *")).toBe("Every 2d, 8AM");
  });

  it("never shortens a schedule it would get wrong", () => {
    // Weekdays only, two times a day, and every 2 hours on some days are not "Daily" or "Every".
    for (const cron of ["0 9 * * 1-5", "0 9,17 * * *", "0 */2 1 * *"]) {
      const label = cronCadence(cron);
      expect(label, cron).not.toMatch(/^(Daily \d|Every \d+[mhd])/u);
      expect(label, cron).not.toBe("");
    }
  });

  it("has a short label for every template", () => {
    for (const template of LOOP_TEMPLATES)
      expect(cronCadence(template.cron), template.id).toMatch(
        /^(Daily|Every) \d/u,
      );
  });
});
