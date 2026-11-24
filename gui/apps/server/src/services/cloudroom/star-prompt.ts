import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { z } from "zod";
import type { AppDeps } from "../../types.js";
import { nextStarAsk, popupState, recordPopup, starDone } from "./popups.js";
import { macGithubToken } from "./sandboxes.js";
import { timeInApp } from "./time-in-app.js";

const REPO = "davidondrej/cloudroom";
const REPO_URL = `https://github.com/${REPO}`;
const CARD_AFTER_PROMPTS = 4;
const POPUP_AFTER_MINUTES = 60;
const STARS_CACHE_MS = 60 * 60_000;
type Deps = Pick<AppDeps, "config">;
type StarPrompt = { eligible: boolean; card: boolean; done: boolean; login: string | null; url: string; days: number; stars: number | null };

const github = (token: string, path: string, method: "GET" | "PUT" = "GET") => fetch(`https://api.github.com${path}`, {
  method, redirect: "error", signal: AbortSignal.timeout(10_000),
  headers: { Accept: "application/vnd.github+json", ...(token ? { Authorization: `Bearer ${token}` } : {}) },
}).catch(() => null);

const promptsFile = (deps: Deps) => join(deps.config.dataDir, "cloudroom-prompts.json");
const prompts = new Map<string, Promise<number>>();
function promptCount(deps: Deps): Promise<number> {
  let count = prompts.get(deps.config.dataDir);
  if (!count) {
    count = readFile(promptsFile(deps), "utf8").then((text) => z.object({ prompts: z.number().int() }).parse(JSON.parse(text)).prompts).catch(() => 0);
    prompts.set(deps.config.dataDir, count);
  }
  return count;
}

export function noteUserPrompt(deps: Deps): void {
  const next = promptCount(deps).then((count) => count + 1);
  prompts.set(deps.config.dataDir, next);
  void next.then((count) => count <= CARD_AFTER_PROMPTS ? writeFile(promptsFile(deps), JSON.stringify({ prompts: count }), { mode: 0o600 }) : undefined).catch(() => {});
}

let stars: { at: number; count: number | null } | null = null;
async function repoStars(token: string): Promise<number | null> {
  if (stars && Date.now() - stars.at < STARS_CACHE_MS) return stars.count;
  const response = await github(token, `/repos/${REPO}`);
  const count = response?.ok ? z.object({ stargazers_count: z.number().int() }).safeParse(await response.json().catch(() => null)).data?.stargazers_count ?? null : null;
  stars = { at: Date.now(), count };
  return count;
}

export async function starPrompt(deps: AppDeps): Promise<StarPrompt> {
  const [{ days: minutesByDay }, sent] = await Promise.all([timeInApp(deps), promptCount(deps)]);
  const minutes = Object.values(minutesByDay).reduce((sum, day) => sum + day, 0);
  const days = Object.keys(minutesByDay).length;
  const none = { eligible: false, card: false, done: false, login: null, url: REPO_URL, days, stars: null };
  const due = { card: sent >= CARD_AFTER_PROMPTS, popup: minutes >= POPUP_AFTER_MINUTES || days >= 2 };
  if (!due.card && !due.popup) return none;
  const state = await popupState(deps);
  if (!state || starDone(state)) return { ...none, done: state !== null };
  const next = nextStarAsk(state, due);
  if (!next) return none;
  const token = await macGithubToken();
  const [user, starred, count] = await Promise.all([token ? github(token, "/user") : null, token ? github(token, `/user/starred/${REPO}`) : null, repoStars(token)]);
  if (starred?.status === 204) {
    await recordPopup(deps, next === "card" ? "star_card" : "star", "closed", "already").catch(() => {});
    return { ...none, done: true };
  }
  const login = user?.ok ? z.object({ login: z.string() }).safeParse(await user.json().catch(() => null)).data?.login ?? null : null;
  return { ...none, eligible: next === "popup", card: next === "card", login, stars: count };
}

export async function starRepo(): Promise<{ starred: boolean }> {
  const token = await macGithubToken();
  return { starred: token !== "" && (await github(token, `/user/starred/${REPO}`, "PUT"))?.status === 204 };
}
