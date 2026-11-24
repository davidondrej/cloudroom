import { appSettingsValues, type DbConnection } from "@cloudroom/db";
import { eq } from "drizzle-orm";

// The first agent: a thread Cloudroom started by itself when first-run setup ended, in apps from v151. Removed
// (ADR 20261121-193244), so nothing saves an ID here any more. Installs that got one keep its ID in this settings row:
// the checklist and thread counters still skip that thread, and its usage events still carry `first_agent`.
const KEY = "cloudroom_first_agent_thread";

/** The first agent's thread, or null on an install that never got one. */
export const firstAgentThreadId = (db: DbConnection): string | null =>
  db.select({ value: appSettingsValues.value }).from(appSettingsValues).where(eq(appSettingsValues.key, KEY)).get()?.value ?? null;

/** `{ first_agent: true }` for the first agent's thread, else nothing: spread it into an event's properties. */
export const firstAgentTag = (db: DbConnection, threadId: string): { first_agent?: true } =>
  firstAgentThreadId(db) === threadId ? { first_agent: true } : {};
