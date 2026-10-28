import { z } from "zod/mini";

export interface PlanMeter {
  label: string;
  used: number;
  limit: number;
  unit: string;
}

export interface PlanSummary {
  plan: string;
  period: string;
  meters: PlanMeter[];
}

// Cloud Credits in the rolling 30 days (ADR 0307); null credits while metering is stale.
const creditsSchema = z.object({
  plan: z.string(),
  credits: z.nullable(z.number()),
  creditsLimit: z.number(),
});

export function fromCredits(usage: z.infer<typeof creditsSchema>): PlanSummary {
  return {
    plan: usage.plan,
    period: "last 30 days",
    meters: usage.credits === null
      ? []
      : [{ label: "credits", used: usage.credits, limit: usage.creditsLimit, unit: " credits" }],
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
