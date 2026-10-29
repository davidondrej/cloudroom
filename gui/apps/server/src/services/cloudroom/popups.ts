import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { z } from "zod";
import type { AppDeps } from "../../types.js";
import { POPUPS, type Popup, type PopupDetail } from "../system/telemetry.js";
import { cloudroom } from "./commands.js";

export type PopupState = { closed: Popup[]; shownAt: number | null; credits: boolean };
const DAY = 86_400_000;
const RECHECK_MS = 10 * 60_000;
const stateSchema = z.object({ closed: z.array(z.string()), shown_at: z.string().nullable(), credits: z.boolean() });
const savedSchema = z.object({ closed: z.record(z.string(), z.string()).catch({}), shown_at: z.string().nullable().catch(null) }).catch({ closed: {}, shown_at: null });
const localFile = (deps: AppDeps) => join(deps.config.dataDir, "cloudroom-popups.json");
let cache: { key: string; at: number; value: PopupState } | null = null;

const toState = (value: z.infer<typeof stateSchema>): PopupState => ({
  closed: POPUPS.filter((popup) => value.closed.includes(popup)),
  shownAt: value.shown_at ? Date.parse(value.shown_at) : null,
  credits: value.credits,
});
const readLocal = async (deps: AppDeps) => savedSchema.parse(await readFile(localFile(deps), "utf8").then(JSON.parse, () => ({})));

async function load(deps: AppDeps, signedIn: boolean): Promise<PopupState | null> {
  if (signedIn) {
    const parsed = stateSchema.safeParse(await cloudroom(deps).sandboxes.popups({}).catch(() => null));
    return parsed.success ? toState(parsed.data) : null;
  }
  const saved = await readLocal(deps);
  return toState({ closed: Object.keys(saved.closed), shown_at: saved.shown_at, credits: false });
}

export async function popupState(deps: AppDeps): Promise<PopupState | null> {
  const account = await cloudroom(deps).sandboxes.account();
  const key = account?.userId ?? "local";
  if (cache?.key !== key || Date.now() - cache.at > RECHECK_MS) {
    const value = await load(deps, account !== null);
    if (!value) return null;
    cache = { key, at: Date.now(), value };
  }
  return cache.value;
}

async function saveLocal(deps: AppDeps, popup: Popup, event: "shown" | "closed"): Promise<boolean> {
  const saved = await readLocal(deps), now = new Date().toISOString();
  if (event === "shown" && (popup in saved.closed || (saved.shown_at !== null && Date.now() - Date.parse(saved.shown_at) < DAY))) return false;
  const next = event === "shown" ? { ...saved, shown_at: now } : { ...saved, closed: { ...saved.closed, [popup]: saved.closed[popup] ?? now } };
  await writeFile(localFile(deps), JSON.stringify(next), { mode: 0o600 });
  return true;
}

export async function recordPopup(deps: AppDeps, popup: Popup, event: "shown" | "closed", detail?: PopupDetail): Promise<boolean> {
  const account = await cloudroom(deps).sandboxes.account();
  const ok = account
    ? z.object({ ok: z.boolean() }).parse(await cloudroom(deps).sandboxes.popups({ popup, event })).ok
    : await saveLocal(deps, popup, event);
  if (cache?.key === (account?.userId ?? "local")) {
    cache.value = event === "shown" ? { ...cache.value, shownAt: Date.now() } : { ...cache.value, closed: [...new Set([...cache.value.closed, popup])] };
  }
  if (ok) deps.telemetry.capture({ name: "popup", properties: { popup, action: detail ?? (event === "shown" ? "viewed" : "closed") } });
  return ok;
}
