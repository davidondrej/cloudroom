import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { z } from "zod";
import type { AppDeps } from "../../types.js";
import { POPUPS, type CornerAnswer, type CornerCard, type Popup, type PopupDetail } from "../system/telemetry.js";
import { cloudroom } from "./commands.js";

const STAR_ANSWERS = ["starred", "opened", "dismissed", "already", "closed"] as const;
type StarAnswer = (typeof STAR_ANSWERS)[number];
export type StarSurface = "popup" | "card";
export type StarAsk = { surface: StarSurface; at: number; answer: StarAnswer | null };
/** One showing of a card at the top right: when it started, and what the user did with it. */
export type CornerEntry = { card: string; key: string; at: number; answer: string | null; answeredAt: number | null };
/** `cards`: when each budgeted card above the chat input showed (the star card and the Cloud cards).
 *  `corner`: the account's last 12 showings of the cards at the top right, oldest first. */
export type PopupState = { closed: Popup[]; shownAt: number | null; credits: boolean; checklistHides: number; starAsks: StarAsk[]; cards: number[]; corner: CornerEntry[] };
const DAY = 86_400_000;
// One weekly budget for the cards above the chat input, per account (ADR 20261111-222457). The database enforces it too.
const CARD_BUDGET = 3;
const BUDGETED: readonly Popup[] = ["star_card", "cloud_card"];
// The cards at the top right (ADR 20261115-004019, docs/scopes/corner-cards.md). The website holds the same rules and
// the database enforces them. `quiet`: never shows in the QUIET_DAYS after any corner card was answered.
// `everyDays`: may come back that long after its last showing. Without it, a card shows once per key.
// `afterOpenDays`: after the first `opened` answer, allow one more showing that many days later, then stop forever
// (even if that second showing is closed). Only this server checks it, against the account's last 12 showings: the
// website and the database don't know the rule (ADR 20261126-170245, docs/scopes/corner-cards.md).
// The call ticket comes back 3 days after it was closed or clicked, while the website still says the account is owed one.
// `build` is the note on the chat input: once per round, its key (docs/scopes/build-next.md).
const CORNER_RULES: Record<CornerCard, { quiet?: true; everyDays?: number; afterOpenDays?: number }> = { invite: {}, call: { everyDays: 3 }, checklist: {}, wrapped: {}, scan: { quiet: true, everyDays: 45 }, partner: { everyDays: 14, afterOpenDays: 30 }, build: {} };
const QUIET_DAYS = 3;
const CORNER_KEPT = 12;
const RECHECK_MS = 10 * 60_000;
const MAX_STAR_CARDS = 3;
const STAR_CARD_EVERY_MS = 3 * DAY;
const FINAL: ReadonlySet<StarAnswer | null> = new Set(["starred", "opened", "already", "closed"]);
const asksSchema = z.array(z.object({ surface: z.enum(["popup", "card"]), at: z.string(), answer: z.enum(STAR_ANSWERS).nullable() })).catch([]);
const cardsSchema = z.array(z.string()).catch([]);
const cornerSchema = z.array(z.object({ card: z.string(), key: z.string(), at: z.string(), answer: z.string().nullable().catch(null), answered_at: z.string().nullable().catch(null) })).catch([]);
const stateSchema = z.object({ closed: z.array(z.string()), shown_at: z.string().nullable(), credits: z.boolean(), checklist_hides: z.number().int().catch(0), star_asks: asksSchema, cards: cardsSchema, corner: cornerSchema });
const savedSchema = z.object({ closed: z.record(z.string(), z.string()).catch({}), shown_at: z.string().nullable().catch(null), star_asks: asksSchema, cards: cardsSchema, corner: cornerSchema })
  .catch({ closed: {}, shown_at: null, star_asks: [], cards: [], corner: [] });
const localFile = (deps: AppDeps) => join(deps.config.dataDir, "cloudroom-popups.json");
let cache: { key: string; at: number; value: PopupState } | null = null;

const toState = (value: z.infer<typeof stateSchema>): PopupState => ({
  closed: POPUPS.filter((popup) => value.closed.includes(popup)),
  shownAt: value.shown_at ? Date.parse(value.shown_at) : null,
  credits: value.credits,
  checklistHides: value.checklist_hides,
  starAsks: value.star_asks.map((ask) => ({ ...ask, at: Date.parse(ask.at) })),
  cards: value.cards.map((at) => Date.parse(at)),
  corner: value.corner.map((entry) => ({ card: entry.card, key: entry.key, at: Date.parse(entry.at), answer: entry.answer, answeredAt: entry.answered_at ? Date.parse(entry.answered_at) : null })),
});
const readLocal = async (deps: AppDeps) => savedSchema.parse(await readFile(localFile(deps), "utf8").then(JSON.parse, () => ({})));
const localState = (saved: z.infer<typeof savedSchema>) =>
  toState({ closed: Object.keys(saved.closed), shown_at: saved.shown_at, credits: false, checklist_hides: 0, star_asks: saved.star_asks, cards: saved.cards, corner: saved.corner });
const starSurface = (popup: Popup): StarSurface | null => popup === "star" ? "popup" : popup === "star_card" ? "card" : null;

export const starDone = (state: PopupState) => state.starAsks.some((ask) => FINAL.has(ask.answer));

/** How many more cards above the chat input this account may see this week. */
export const cardsLeft = (state: PopupState, now = Date.now()) => Math.max(0, CARD_BUDGET - state.cards.filter((at) => now - at < 7 * DAY).length);

export function canAskStar(state: PopupState, surface: StarSurface, now = Date.now()): boolean {
  const asks = state.starAsks;
  if (starDone(state) || asks.some((ask) => now - ask.at < DAY)) return false;
  if (surface === "popup") {
    return !state.closed.includes("star") && !asks.some((ask) => ask.surface === "popup") && (state.shownAt === null || now - state.shownAt >= DAY);
  }
  const cards = asks.filter((ask) => ask.surface === "card");
  return cardsLeft(state, now) > 0 && cards.length < MAX_STAR_CARDS && cards.every((ask) => now - ask.at >= STAR_CARD_EVERY_MS);
}

export function nextStarAsk(state: PopupState, due: { card: boolean; popup: boolean }, now = Date.now()): StarSurface | null {
  if (due.popup && canAskStar(state, "popup", now)) return "popup";
  return due.card && canAskStar(state, "card", now) ? "card" : null;
}

/** Whether a card at the top right may show now. A `quiet` card never shows in the quiet days after any answer.
 *  A showing that is still open may show. An `afterOpenDays` card shows once more that many days after its first
 *  `opened` answer, then stops once that showing is answered. Otherwise a new showing must pass `everyDays` (or once per key). */
export function cornerMay(log: CornerEntry[], card: CornerCard, key: string, now = Date.now()): boolean {
  const { quiet, everyDays, afterOpenDays } = CORNER_RULES[card];
  if (quiet && log.some((entry) => entry.answeredAt !== null && now - entry.answeredAt < QUIET_DAYS * DAY)) return false;
  const mine = log.filter((entry) => entry.card === card), same = mine.filter((entry) => entry.key === key);
  if (same.some((entry) => entry.answer === null)) return true;
  if (afterOpenDays !== undefined) {
    const firstOpen = mine.findIndex((entry) => entry.answer === "opened");
    if (firstOpen >= 0) {
      const openedAt = mine[firstOpen]!.answeredAt ?? mine[firstOpen]!.at;
      // Ignore a same-day duplicate answer from another device that still had the same showing open.
      if (mine.slice(firstOpen + 1).some((entry) => entry.answer !== null && (entry.answeredAt ?? entry.at) - openedAt >= DAY)) return false;
      if (now - openedAt < afterOpenDays * DAY) return false;
    }
  }
  return everyDays === undefined ? same.length === 0 : !mine.some((entry) => now - (entry.answeredAt ?? entry.at) < everyDays * DAY);
}

/** The record after a show or an answer. An answer closes the open showing; with none open it is saved as its own entry. */
export function applyCornerEvent(log: CornerEntry[], card: CornerCard, key: string, event: "shown" | CornerAnswer, now: number): CornerEntry[] {
  const open = log.map((entry) => entry.card === card && entry.key === key && entry.answer === null).lastIndexOf(true);
  if (event === "shown") return open >= 0 ? log : [...log, { card, key, at: now, answer: null, answeredAt: null }].slice(-CORNER_KEPT);
  if (open >= 0) return log.map((entry, index) => index === open ? { ...entry, answer: event, answeredAt: now } : entry);
  return [...log, { card, key, at: now, answer: event, answeredAt: now }].slice(-CORNER_KEPT);
}

export function applyPopupEvent(state: PopupState, popup: Popup, event: "shown" | "closed", detail: PopupDetail | undefined, now: number): PopupState {
  const surface = starSurface(popup);
  if (event === "shown") {
    const starAsks = surface ? [...state.starAsks, { surface, at: now, answer: null }] : state.starAsks;
    return BUDGETED.includes(popup) ? { ...state, starAsks, cards: [...state.cards, now] } : { ...state, starAsks, shownAt: now };
  }
  if (popup === "cloud_card") return state;
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

const iso = (at: number) => new Date(at).toISOString();
/** Signed out, the same record lives in a file in the app's data folder. */
const writeLocal = (deps: AppDeps, saved: z.infer<typeof savedSchema>, next: PopupState, now: number) =>
  writeFile(localFile(deps), JSON.stringify({
    closed: Object.fromEntries(next.closed.map((closed) => [closed, saved.closed[closed] ?? iso(now)])),
    shown_at: next.shownAt === null ? null : iso(next.shownAt),
    star_asks: next.starAsks.map((ask) => ({ ...ask, at: iso(ask.at) })),
    cards: next.cards.filter((at) => now - at < 7 * DAY).map(iso),
    corner: next.corner.map((entry) => ({ card: entry.card, key: entry.key, at: iso(entry.at), answer: entry.answer, answered_at: entry.answeredAt === null ? null : iso(entry.answeredAt) })),
  }), { mode: 0o600 });

async function saveLocal(deps: AppDeps, popup: Popup, event: "shown" | "closed", detail: PopupDetail | undefined): Promise<boolean> {
  const saved = await readLocal(deps), now = Date.now(), state = localState(saved), surface = starSurface(popup);
  const allowed = surface ? canAskStar(state, surface, now) : popup === "cloud_card" ? cardsLeft(state, now) > 0
    : !state.closed.includes(popup) && (state.shownAt === null || now - state.shownAt >= DAY);
  if (event === "shown" && !allowed) return false;
  await writeLocal(deps, saved, applyPopupEvent(state, popup, event, detail, now), now);
  return true;
}

export async function recordPopup(deps: AppDeps, popup: Popup, event: "shown" | "closed", detail?: PopupDetail): Promise<boolean> {
  const account = await cloudroom(deps).sandboxes.account();
  const answer: Record<string, string> = starSurface(popup) && event === "closed" ? { detail: detail ?? "dismissed" } : {};
  const ok = account
    ? z.object({ ok: z.boolean() }).parse(await cloudroom(deps).sandboxes.popups({ popup, event, ...answer })).ok
    : await saveLocal(deps, popup, event, detail);
  // A refused show means another device got there first: read the account again instead of guessing.
  if (cache?.key === (account?.userId ?? "local")) cache = ok ? { ...cache, value: applyPopupEvent(cache.value, popup, event, detail, Date.now()) } : null;
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

/** The account's call ticket: its booking link, its plan, and whether it had a call before. */
export type CallTicket = { link: string; plan: string; again: boolean };
const TICKET_MS = 60 * 60_000;
const ticketSchema = z.object({ ticket: z.object({ link: z.string().startsWith("https://cal.com/"), plan: z.string(), again: z.boolean() }).nullable() });
let ticket: { key: string; at: number; value: CallTicket | null } | null = null;

/** The call ticket at the top right (docs/scopes/calls.md#the-ticket-in-the-app), or null when this account is owed
 *  none. The website decides eligibility (`callEligible` in planUsage) and gives the link; asked at most once an hour
 *  so ineligible Free accounts cost the website nothing. */
export async function callTicket(deps: AppDeps): Promise<CallTicket | null> {
  const sandboxes = cloudroom(deps).sandboxes, account = await sandboxes.account(), plan = sandboxes.currentPlan();
  const eligible = sandboxes.planUsage(false)?.callEligible ?? (Boolean(plan) && plan !== "free");
  if (!account || !plan || !eligible) return null;
  if (ticket?.key !== account.userId || Date.now() - ticket.at > TICKET_MS) {
    const parsed = ticketSchema.safeParse(await sandboxes.popups({ call: "ticket" }).catch(() => null));
    ticket = { key: account.userId, at: Date.now(), value: parsed.success ? parsed.data.ticket : null };
  }
  return ticket.value;
}

/** Claims a showing of a card at the top right, or saves the user's answer to it (docs/scopes/corner-cards.md).
 *  False: the card may not show now. The website is asked only when the record read earlier allows it, so a card
 *  that keeps asking costs nothing. A showing that is already open is not saved twice. */
export async function recordCorner(deps: AppDeps, card: CornerCard, key: string, event: "shown" | CornerAnswer, variant?: string): Promise<boolean> {
  const state = await popupState(deps), now = Date.now();
  if (!state) return false;
  if (event === "shown") {
    if (!cornerMay(state.corner, card, key, now)) return false;
    if (state.corner.some((entry) => entry.card === card && entry.key === key && entry.answer === null)) return true;
  }
  const account = await cloudroom(deps).sandboxes.account();
  const ok = account
    ? z.object({ ok: z.boolean() }).parse(await cloudroom(deps).sandboxes.popups({ corner: card, key, event })).ok
    : await readLocal(deps).then(async (saved) => {
      const local = localState(saved);
      if (event === "shown" && !cornerMay(local.corner, card, key, now)) return false;
      await writeLocal(deps, saved, { ...local, corner: applyCornerEvent(local.corner, card, key, event, now) }, now);
      return true;
    });
  // A refused show means another device answered first: read the account again instead of guessing.
  if (cache?.key === (account?.userId ?? "local")) cache = ok ? { ...cache, value: { ...cache.value, corner: applyCornerEvent(cache.value.corner, card, key, event, now) } } : null;
  if (ok) deps.telemetry.capture({ name: "corner", properties: { card, key, action: event === "shown" ? "viewed" : event, ...(variant ? { variant } : {}) } });
  return ok;
}
