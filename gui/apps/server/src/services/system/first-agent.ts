import { appSettingsValues, type DbConnection } from "@cloudroom/db";
import { eq } from "drizzle-orm";

// The first agent (ADR 20261111-220912): the one thread Cloudroom starts by itself when first-run setup ends. No thread
// saves how it was started, so its ID is kept as one settings row, to tag that thread's reply, failure, and follow-up
// messages with `first_agent` in the usage events.
const KEY = "cloudroom_first_agent_thread";

export function rememberFirstAgent(db: DbConnection, threadId: string): void {
  const row = { value: threadId, updatedAt: Date.now() };
  db.insert(appSettingsValues).values({ key: KEY, ...row }).onConflictDoUpdate({ target: appSettingsValues.key, set: row }).run();
}

/** The first agent's thread, or null on an install that never got one. */
export const firstAgentThreadId = (db: DbConnection): string | null =>
  db.select({ value: appSettingsValues.value }).from(appSettingsValues).where(eq(appSettingsValues.key, KEY)).get()?.value ?? null;

/** `{ first_agent: true }` for the first agent's thread, else nothing: spread it into an event's properties. */
export const firstAgentTag = (db: DbConnection, threadId: string): { first_agent?: true } =>
  firstAgentThreadId(db) === threadId ? { first_agent: true } : {};
