import { z } from "zod";

export interface PlanMeter {
  label: string;
  used: number;
  limit: number;
  unit: string;
  /** Overrides the plan's period, e.g. for extra credits, which never refill. */
  period?: string;
}

export interface PlanSummary {
  plan: string;
  period: string;
  /** When plan credits refill (ADR 20261108-142517); null from older websites, whose rows show credits left instead. */
  resetsAt: string | null;
  /** Plan + extra credits left, for the line under the meters, e.g. "478,265 credits left"; null without `resetsAt`. */
  left: string | null;
  meters: PlanMeter[];
}

// Cloud Credits this credit period (ADR 20261108-142517); null credits while metering is stale.
const creditsSchema = z.object({
  plan: z.string(),
  credits: z.nullable(z.number()),
  creditsLimit: z.number(),
  resetsAt: z.optional(z.nullable(z.string())),
  extraCredits: z.optional(z.number()),
  extraCreditsTotal: z.optional(z.number()),
});

/** With extra credits (packs, ADR 0317), they get their own row before the plan's, like the account menu. */
export function fromCredits(usage: z.infer<typeof creditsSchema>): PlanSummary {
  const extra = Math.max(0, usage.extraCredits ?? 0), total = Math.max(extra, usage.extraCreditsTotal ?? 0);
  const plan = { used: usage.credits ?? 0, limit: usage.creditsLimit, unit: " credits" };
  return {
    plan: usage.plan,
    period: "this month",
    resetsAt: usage.resetsAt ?? null,
    left: usage.resetsAt && usage.credits !== null ? `${(Math.max(0, Math.floor(plan.limit - plan.used)) + Math.floor(extra)).toLocaleString("en-US")} credits left` : null,
    meters: usage.credits === null
      ? []
      : extra > 0
        ? [{ label: "extra", used: total - extra, limit: total, unit: " credits", period: "never resets" }, { label: "plan", ...plan }]
        : [{ label: "credits", ...plan }],
  };
}

const accountStatusSchema = z.object({
  planUsage: z.optional(z.nullable(creditsSchema)),
});

export async function loadPlanSummary(
  signal?: AbortSignal,
): Promise<PlanSummary | null> {
  const response = await fetch("/api/v1/cloudroom/account", { signal });
  if (!response.ok) throw new Error(`Plan usage returned HTTP ${response.status}.`);
  const parsed = accountStatusSchema.safeParse(await response.json());
  const usage = parsed.success ? parsed.data.planUsage : null;
  return usage ? fromCredits(usage) : null;
}

export function planMeterPercent(meter: PlanMeter): number {
  return meter.limit > 0 ? Math.min(100, (meter.used / meter.limit) * 100) : 100;
}

export function planMeterLeft(meter: PlanMeter): string {
  return `${Math.max(0, Math.floor(meter.limit - meter.used)).toLocaleString("en-US")}${meter.unit} left`;
}
