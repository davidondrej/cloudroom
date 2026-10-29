import type { Hono } from "hono";
import { z } from "zod";
import { browserRequestProblem } from "../browser-request-guard.js";
import type { AppDeps } from "../types.js";

const uiPerfBatchSchema = z
  .object({
    entries: z
      .array(
        z
          .object({
            metric: z.enum(["app_ready", "thread_open", "ui_freeze"]),
            ms: z.number().int().nonnegative().max(3_600_000),
            threadId: z.string().max(64).optional(),
          })
          .strict(),
      )
      .min(1)
      .max(100),
  })
  .strict();

export function registerUiPerfRoutes(app: Hono, deps: AppDeps): void {
  app.post("/api/v1/perf", async (context) => {
    const problem = browserRequestProblem(context, deps, {
      requireJsonForMutation: true,
    });
    if (problem)
      return context.json({ message: problem.error }, problem.status);
    const batch = uiPerfBatchSchema.safeParse(
      await context.req.json().catch(() => null),
    );
    if (!batch.success)
      return context.json({ message: "Invalid perf batch" }, 400);
    for (const entry of batch.data.entries) {
      deps.logger.info(entry, "UI perf");
    }
    return context.body(null, 204);
  });
}
