import { describe, expect, it } from "vitest";
import {
  ANTIGRAVITY_ACP_MAINTENANCE,
  __testing,
} from "./antigravity-maintenance.js";

// `agy -p "/usage" --output-format json` on a Google AI Ultra plan (Antigravity CLI 1.5.8).
const ULTRA_USAGE = JSON.stringify({
  conversation_id: "",
  status: "SUCCESS",
  response:
    "Gemini Models\tWeekly Limit Remaining\t98%\t2026-11-20T07:01:04Z\n",
  num_turns: 0,
  command: {
    name: "usage",
    data: {
      description:
        "Within each group, models share a weekly limit and a 5-hour limit.",
      groups: [
        {
          name: "Gemini Models",
          description: "Models within this group: Gemini Flash, Gemini Pro",
          buckets: [
            {
              id: "gemini-weekly",
              name: "Weekly Limit Remaining",
              window: "weekly",
              remaining_fraction: 0.9769778251647949,
              reset_time: "2026-11-20T07:01:04Z",
            },
            {
              id: "gemini-5h",
              name: "Five Hour Limit Remaining",
              window: "5h",
              remaining_fraction: 0.9542551636695862,
              reset_time: "2026-11-13T23:39:20Z",
            },
          ],
        },
        {
          name: "Claude and GPT models",
          description:
            "Models within this group: Claude Opus, Claude Sonnet, GPT-OSS",
          buckets: [
            {
              id: "3p-weekly",
              name: "Weekly Limit Remaining",
              window: "weekly",
              remaining_fraction: 1,
              reset_time: "2026-11-20T19:28:26Z",
            },
            {
              id: "3p-5h",
              name: "Five Hour Limit Remaining",
              window: "5h",
              remaining_fraction: 0.25,
              reset_time: "2026-11-14T00:28:26Z",
            },
          ],
        },
      ],
    },
  },
});

describe("Antigravity maintenance", () => {
  it("reads each model group's five-hour and weekly limits as used percentages", () => {
    expect(__testing.normalizeUsage(`${ULTRA_USAGE}\n`)).toEqual({
      status: "ok",
      accountEmail: null,
      planLabel: null,
      windows: [
        {
          kind: "five-hour",
          model: "gemini",
          label: "Gemini · Five-hour limit",
          usedPercent: 5,
          resetsAt: "2026-11-13T23:39:20.000Z",
        },
        {
          kind: "weekly",
          model: "gemini",
          label: "Gemini · Weekly limit",
          usedPercent: 2,
          resetsAt: "2026-11-20T07:01:04.000Z",
        },
        {
          kind: "five-hour",
          model: "claude/gpt",
          label: "Claude and GPT · Five-hour limit",
          usedPercent: 75,
          resetsAt: "2026-11-14T00:28:26.000Z",
        },
        {
          kind: "weekly",
          model: "claude/gpt",
          label: "Claude and GPT · Weekly limit",
          usedPercent: 0,
          resetsAt: "2026-11-20T19:28:26.000Z",
        },
      ],
    });
  });

  it("keeps a window it does not know under the CLI's own name", () => {
    const usage = __testing.normalizeUsage(
      JSON.stringify({
        status: "SUCCESS",
        command: {
          data: {
            groups: [
              {
                name: "Gemini Models",
                buckets: [
                  {
                    name: "Monthly Limit Remaining",
                    window: "monthly",
                    remaining_fraction: 0.4,
                  },
                ],
              },
            ],
          },
        },
      }),
    );
    expect(usage).toMatchObject({
      status: "ok",
      windows: [
        {
          kind: "custom",
          label: "Gemini · Monthly Limit",
          usedPercent: 60,
          resetsAt: null,
        },
      ],
    });
  });

  it("reads the result after the CLI's own notices", () => {
    expect(
      __testing.normalizeUsage(`A new version is available.\n${ULTRA_USAGE}\n`),
    ).toMatchObject({ status: "ok" });
  });

  it("reports a failed or unreadable answer as an error, never as zero usage", () => {
    expect(
      __testing.normalizeUsage(
        JSON.stringify({ status: "ERROR", error: "quota service unavailable" }),
      ),
    ).toEqual({
      status: "error",
      message: "quota service unavailable",
      planLabel: null,
      accountEmail: null,
    });
    expect(__testing.normalizeUsage("not json")).toMatchObject({
      status: "error",
      message: "Antigravity usage response was malformed.",
    });
    expect(
      __testing.normalizeUsage(
        JSON.stringify({
          status: "ERROR",
          error: "authentication failed or timed out",
        }),
      ),
    ).toEqual({ status: "unauthenticated" });
  });

  it("signs in through the ACP terminal login and installs with Google's script", () => {
    expect(ANTIGRAVITY_ACP_MAINTENANCE.loginCommand).toBe("agy acp --login");
    expect(ANTIGRAVITY_ACP_MAINTENANCE.installer().displayCommand).toContain(
      "https://antigravity.google/cli/install.",
    );
  });
});
