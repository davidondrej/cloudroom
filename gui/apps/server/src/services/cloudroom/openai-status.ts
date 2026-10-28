const SUMMARY_URL = "https://status.openai.com/api/v2/summary.json";
// Status-page component IDs for what cloud VMs call: the Codex CLI and the Codex API.
const CODEX_COMPONENTS = new Set(["01KMKFAMWKNQ84Z1766MV08ZDE", "01KMP3KP5MGE23B80K1EK4S8PV"]);
const CACHE_MS = 60_000;

let cached: { at: number; outage: Promise<boolean> } | undefined;

/** True only when OpenAI's own status page marks Codex as not operational. */
export function codexOutage(): Promise<boolean> {
  if (!cached || Date.now() - cached.at > CACHE_MS) cached = { at: Date.now(), outage: fetchOutage() };
  return cached.outage;
}

async function fetchOutage(): Promise<boolean> {
  try {
    const response = await fetch(SUMMARY_URL, { signal: AbortSignal.timeout(3_000) });
    if (!response.ok) return false;
    const { components } = await response.json() as { components?: { id?: string; status?: string }[] };
    return (components ?? []).some((c) => CODEX_COMPONENTS.has(c.id ?? "") && c.status !== "operational");
  } catch {
    return false;
  }
}
