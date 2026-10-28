import { getThread } from "@cloudroom/db";
import { z } from "zod";
import type { AppDeps } from "../../types.js";
import { deleteThreadOnMac } from "../threads/thread-lifecycle.js";
import { cloudroom } from "./commands.js";
import { sandboxThread } from "./sandboxes.js";
import { bindings } from "./store.js";

export const autoDeleteDaysSchema = z.union([z.literal(30), z.literal(90), z.literal(180), z.literal(365), z.null()]);
export type AutoDeleteDays = z.infer<typeof autoDeleteDaysSchema>;
const limitSchema = z.object({ name: z.string().max(40), days: z.number().int().positive(), label: z.string().max(40) }).nullable().catch(null);
const settingSchema = z.object({ days: autoDeleteDaysSchema, kept: z.number().int().positive().nullable().catch(null), plan: limitSchema, upgrade: limitSchema });
const deletedSchema = z.object({ threads: z.array(z.string()) });

export async function readAutoDelete(deps: AppDeps) {
  return settingSchema.parse(await cloudroom(deps).sandboxes.autoDelete({ action: "get" }));
}

export async function saveAutoDelete(deps: AppDeps, days: AutoDeleteDays) {
  return settingSchema.parse(await cloudroom(deps).sandboxes.autoDelete({ action: "set", days }));
}

export function startAutoDeleteSync(deps: AppDeps): void {
  const sync = async () => {
    const gone = new Set(deletedSchema.parse(await cloudroom(deps).sandboxes.autoDelete({ action: "deleted" })).threads);
    if (!gone.size) return;
    for (const saved of bindings(deps.db)) {
      const sandbox = sandboxThread(saved.coreUrl);
      const thread = sandbox && gone.has(sandbox) ? getThread(deps.db, saved.threadId) : null;
      if (thread && thread.deletedAt === null) deleteThreadOnMac(deps, thread);
    }
  };
  const run = () => void sync().catch(() => {});
  setTimeout(run, 60_000).unref();
  setInterval(run, 6 * 3600_000).unref();
}
