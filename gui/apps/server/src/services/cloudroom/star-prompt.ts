import { z } from "zod";
import type { AppDeps } from "../../types.js";
import { popupState, recordPopup } from "./popups.js";
import { macGithubToken } from "./sandboxes.js";
import { timeInApp } from "./time-in-app.js";

const REPO = "davidondrej/cloudroom-core";
const REPO_URL = `https://github.com/${REPO}`;

const github = (token: string, path: string, method: "GET" | "PUT" = "GET") => fetch(`https://api.github.com${path}`, {
  method, redirect: "error", headers: { Accept: "application/vnd.github+json", Authorization: `Bearer ${token}` }, signal: AbortSignal.timeout(10_000),
}).catch(() => null);

export async function starPrompt(deps: AppDeps): Promise<{ eligible: boolean; login: string | null; url: string; days: number }> {
  const { days: minutesByDay } = await timeInApp(deps);
  const minutes = Object.values(minutesByDay).reduce((sum, day) => sum + day, 0);
  const days = Object.keys(minutesByDay).length;
  const no = { eligible: false, login: null, url: REPO_URL, days };
  if (minutes < 60 && days < 2) return no;
  const state = await popupState(deps);
  if (!state || state.closed.includes("star")) return no;
  const token = await macGithubToken();
  const [user, starred] = token ? await Promise.all([github(token, "/user"), github(token, `/user/starred/${REPO}`)]) : [null, null];
  if (starred?.status === 204) {
    await recordPopup(deps, "star", "closed", "already").catch(() => {});
    return no;
  }
  const login = user?.ok ? z.object({ login: z.string() }).safeParse(await user.json().catch(() => null)).data?.login ?? null : null;
  return { eligible: true, login, url: REPO_URL, days };
}

export async function starRepo(): Promise<{ starred: boolean }> {
  const token = await macGithubToken();
  return { starred: token !== "" && (await github(token, `/user/starred/${REPO}`, "PUT"))?.status === 204 };
}
