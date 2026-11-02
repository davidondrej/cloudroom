import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { z } from "zod";
import type { AppDeps } from "../../types.js";
import { POPUPS, type Popup, type PopupDetail } from "../system/telemetry.js";
import { cloudroom } from "./commands.js";

const STAR_ANSWERS = ["starred", "opened", "dismissed", "already", "closed"] as const;
type StarAnswer = (typeof STAR_ANSWERS)[number];
export type StarSurface = "popup" | "card";
export type StarAsk = { surface: StarSurface; at: number; answer: StarAnswer | null };
export type PopupState = { closed: Popup[]; shownAt: number | null; credits: boolean; checklistHides: number; starAsks: StarAsk[] };
const DAY = 86_400_000;
const RECHECK_MS = 10 * 60_000;
const MAX_STAR_CARDS = 3;
const STAR_CARD_EVERY_MS = 3 * DAY;
const FINAL: ReadonlySet<StarAnswer | null> = new Set(["starred", "opened", "already", "closed"]);
const asksSchema = z.array(z.object({ surface: z.enum(["popup", "card"]), at: z.string(), answer: z.enum(STAR_ANSWERS).nullable() })).catch([]);
const stateSchema = z.object({ closed: z.array(z.string()), shown_at: z.string().nullable(), credits: z.boolean(), checklist_hides: z.number().int().catch(0), star_asks: asksSchema });
const savedSchema = z.object({ closed: z.record(z.string(), z.string()).catch({}), shown_at: z.string().nullable().catch(null), star_asks: asksSchema })
  .catch({ closed: {}, shown_at: null, star_asks: [] });
const localFile = (deps: AppDeps) => join(deps.config.dataDir, "cloudroom-popups.json");
let cache: { key: string; at: number; value: PopupState } | null = null;

const toState = (value: z.infer<typeof stateSchema>): PopupState => ({
  closed: POPUPS.filter((popup) => value.closed.includes(popup)),
  shownAt: value.shown_at ? Date.parse(value.shown_at) : null,
  credits: value.credits,
  checklistHides: value.checklist_hides,
  starAsks: value.star_asks.map((ask) => ({ ...ask, at: Date.parse(ask.at) })),
});
const readLocal = async (deps: AppDeps) => savedSchema.parse(await readFile(localFile(deps), "utf8").then(JSON.parse, () => ({})));
const localState = (saved: z.infer<typeof savedSchema>) =>
  toState({ closed: Object.keys(saved.closed), shown_at: saved.shown_at, credits: false, checklist_hides: 0, star_asks: saved.star_asks });
const starSurface = (popup: Popup): StarSurface | null => popup === "star" ? "popup" : popup === "star_card" ? "card" : null;

export const starDone = (state: PopupState) => state.starAsks.some((ask) => FINAL.has(ask.answer));

export function canAskStar(state: PopupState, surface: StarSurface, now = Date.now()): boolean {
  const asks = state.starAsks;
  if (starDone(state) || asks.some((ask) => now - ask.at < DAY)) return false;
  if (surface === "popup") {
    return !state.closed.includes("star") && !asks.some((ask) => ask.surface === "popup") && (state.shownAt === null || now - state.shownAt >= DAY);
  }
  const cards = asks.filter((ask) => ask.surface === "card");
  return cards.length < MAX_STAR_CARDS && cards.every((ask) => now - ask.at >= STAR_CARD_EVERY_MS);
}

export function nextStarAsk(state: PopupState, due: { card: boolean; popup: boolean }, now = Date.now()): StarSurface | null {
  if (due.popup && canAskStar(state, "popup", now)) return "popup";
  return due.card && canAskStar(state, "card", now) ? "card" : null;
}

export function applyPopupEvent(state: PopupState, popup: Popup, event: "shown" | "closed", detail: PopupDetail | undefined, now: number): PopupState {
  const surface = starSurface(popup);
  if (event === "shown") {
    return { ...state, shownAt: surface === "card" ? state.shownAt : now, starAsks: surface ? [...state.starAsks, { surface, at: now, answer: null }] : state.starAsks };
  }
  if (!surface) return { ...state, closed: [...new Set([...state.closed, popup])] };
  const answer: StarAnswer = detail === undefined ? "dismissed" : detail === "migrated" ? "closed" : detail;
  const open = state.starAsks.map((ask) => ask.surface === surface && ask.answer === null).lastIndexOf(true);
  const starAsks = open < 0 ? [...state.starAsks, { surface, at: now, answer }] : state.starAsks.map((ask, index) => index === open ? { ...ask, answer } : ask);
  const closed = surface === "popup" || FINAL.has(answer) ? [...new Set([...state.closed, "star" as const])] : state.closed;
  return { ...state, closed, starAsks };
}

async function load(deps: AppDeps, signedIn: boolean): Promise<PopupState | null> {
  if (signedIn) {
    const parsed = stateSchema.safeParse(await cloudroom(deps).sandboxes.popups({}).catch(() => null));
    return parsed.success ? toState(parsed.data) : null;
  }
  return localState(await readLocal(deps));
}

export async function popupState(deps: AppDeps): Promise<PopupState | null> {
  const account = await cloudroom(deps).sandboxes.account();
  const key = account?.userId ?? "local";
  if (cache?.key !== key || Date.now() - cache.at > RECHECK_MS) {
    const value = await load(deps, account !== null);
    if (!value) return cache?.key === key ? cache.value : null;
    cache = { key, at: Date.now(), value };
  }
  return cache.value;
}

async function saveLocal(deps: AppDeps, popup: Popup, event: "shown" | "closed", detail: PopupDetail | undefined): Promise<boolean> {
  const saved = await readLocal(deps), now = Date.now(), state = localState(saved), surface = starSurface(popup);
  const allowed = surface ? canAskStar(state, surface, now) : !state.closed.includes(popup) && (state.shownAt === null || now - state.shownAt >= DAY);
  if (event === "shown" && !allowed) return false;
  const next = applyPopupEvent(state, popup, event, detail, now);
  const iso = (at: number) => new Date(at).toISOString();
  await writeFile(localFile(deps), JSON.stringify({
    closed: Object.fromEntries(next.closed.map((closed) => [closed, saved.closed[closed] ?? iso(now)])),
    shown_at: next.shownAt === null ? null : iso(next.shownAt),
    star_asks: next.starAsks.map((ask) => ({ ...ask, at: iso(ask.at) })),
  }), { mode: 0o600 });
  return true;
}

export async function recordPopup(deps: AppDeps, popup: Popup, event: "shown" | "closed", detail?: PopupDetail): Promise<boolean> {
  const account = await cloudroom(deps).sandboxes.account();
  const answer: Record<string, string> = starSurface(popup) && event === "closed" ? { detail: detail ?? "dismissed" } : {};
  const ok = account
    ? z.object({ ok: z.boolean() }).parse(await cloudroom(deps).sandboxes.popups({ popup, event, ...answer })).ok
    : await saveLocal(deps, popup, event, detail);
  if (cache?.key === (account?.userId ?? "local")) cache.value = applyPopupEvent(cache.value, popup, event, detail, Date.now());
  if (ok) deps.telemetry.capture({ name: "popup", properties: { popup, action: detail ?? (event === "shown" ? "viewed" : "closed") } });
  return ok;
}

export async function recordChecklistHide(deps: AppDeps): Promise<number | null> {
  const account = await cloudroom(deps).sandboxes.account();
  if (!account) return null;
  const { hides } = z.object({ hides: z.number().int() }).parse(await cloudroom(deps).sandboxes.popups({ checklist: "hidden" }));
  if (cache?.key === account.userId) cache.value = { ...cache.value, checklistHides: hides };
  return hides;
}
