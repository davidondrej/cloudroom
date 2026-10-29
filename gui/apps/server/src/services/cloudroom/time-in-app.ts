import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { AppDeps } from "../../types.js";

// Minutes the user actively spends in Cloudroom: an app window reports each focused minute with recent input.
// Local days feed the Time in Cloudroom plugin's heatmap. Finished UTC days ride along with the next day's
// active-day ping to the website (0056), so counting adds no website calls.
type Deps = Pick<AppDeps, "config">;
const file = (deps: Deps) => join(deps.config.dataDir, "cloudroom-time-in-app.json");
const localDay = (at: Date) => at.toLocaleDateString("en-CA");
const utcDay = (at: Date) => at.toISOString().slice(0, 10);

interface TimeState { days: Record<string, number>; unsent: Record<string, number>; minute: number }
const states = new Map<string, Promise<TimeState>>();

function load(deps: Deps): Promise<TimeState> {
  let state = states.get(deps.config.dataDir);
  if (!state) {
    state = readFile(file(deps), "utf8").then((text) => JSON.parse(text) as Partial<TimeState>, () => ({}) as Partial<TimeState>)
      .then((saved) => ({ days: saved.days ?? {}, unsent: saved.unsent ?? {}, minute: 0 }));
    states.set(deps.config.dataDir, state);
  }
  return state;
}

const save = (deps: Deps, state: TimeState) => writeFile(file(deps), JSON.stringify({ days: state.days, unsent: state.unsent }), { mode: 0o600 });

/** Active minutes per local day for the last year, and today's. */
export async function timeInApp(deps: Deps): Promise<{ days: Record<string, number>; today: number }> {
  const { days } = await load(deps);
  return { days, today: days[localDay(new Date())] ?? 0 };
}

/** Counts this minute once, however many windows report it. */
export async function noteActiveMinute(deps: Deps): Promise<void> {
  const state = await load(deps);
  const now = new Date();
  const minute = Math.floor(now.getTime() / 60_000);
  if (minute === state.minute) return;
  state.minute = minute;
  const day = localDay(now);
  if (state.days[day] === undefined) {
    const oldest = localDay(new Date(now.getTime() - 371 * 864e5));
    for (const key of Object.keys(state.days)) if (key < oldest) delete state.days[key];
  }
  state.days[day] = Math.min(1440, (state.days[day] ?? 0) + 1);
  const utc = utcDay(now);
  state.unsent[utc] = Math.min(1440, (state.unsent[utc] ?? 0) + 1);
  await save(deps, state);
}

/** Finished UTC days not yet sent to the website, the last 7 at most. */
export async function unsentMinutes(deps: Deps): Promise<Record<string, number>> {
  const { unsent } = await load(deps);
  const today = utcDay(new Date());
  return Object.fromEntries(Object.entries(unsent).filter(([day]) => day < today).sort().slice(-7));
}

/** Forgets days the website saved, and any finished day too old to send. */
export async function markMinutesSent(deps: Deps, sent: Record<string, number>): Promise<void> {
  const state = await load(deps);
  const oldest = utcDay(new Date(Date.now() - 7 * 864e5));
  for (const day of Object.keys(state.unsent)) if (day in sent || day < oldest) delete state.unsent[day];
  await save(deps, state);
}
