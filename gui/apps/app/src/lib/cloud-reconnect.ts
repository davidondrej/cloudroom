import { useSyncExternalStore } from "react";
import type { CloudLoginProvider } from "@cloudroom/domain";
import { sdk } from "@/lib/sdk";
import { openUrlInExternalBrowser } from "@/lib/url-open-routing";

/** One Reconnect for an agent Cloud refused, shared by the banner, the thread row, and paused loop cards (no modal).
 *  Plugins ask with `cloudroom:reconnect` (detail: provider) and follow `cloudroom:reconnect-state`. */
export const RECONNECT_EVENT = "cloudroom:reconnect";
export const RECONNECT_STATE_EVENT = "cloudroom:reconnect-state";
/** The agent works in Cloud again; its waiting threads and loops continue by themselves. */
export const CLOUD_LOGIN_FIXED_EVENT = "cloudroom:cloud-login-fixed";

/** `code`: the device code OpenAI's page asks for (a cloud VM's sign-in); it is copied when the page opens. */
export type ReconnectState = { waiting: boolean; url: string | null; code: string | null; error: string | null };
const IDLE: ReconnectState = { waiting: false, url: null, code: null, error: null };
// Codex's own sign-in on this Mac gives up after 10 minutes.
const POLL_MS = 1_500, GIVE_UP_MS = 10 * 60_000;

const states = new Map<CloudLoginProvider, ReconnectState>();
const listeners = new Set<() => void>();
function set(provider: CloudLoginProvider, state: ReconnectState): void {
  states.set(provider, state);
  for (const listener of listeners) listener();
  window.dispatchEvent(new CustomEvent(RECONNECT_STATE_EVENT, { detail: { provider, ...state } }));
}

export function useCloudReconnect(provider: CloudLoginProvider): ReconnectState {
  return useSyncExternalStore(
    (listener) => { listeners.add(listener); return () => listeners.delete(listener); },
    () => states.get(provider) ?? IDLE,
  );
}

// Each agent's sign-in: the server first copies this Mac's working login; otherwise it starts a browser sign-in.
const SIGN_IN = {
  codex: { start: () => sdk.cloudroom.codexLogin(crypto.randomUUID()), check: () => sdk.cloudroom.codexAuth(), name: "ChatGPT" },
  "acp-cursor": { start: () => sdk.cloudroom.cursorLogin(crypto.randomUUID()), check: () => sdk.cloudroom.cursorAuth(), name: "Cursor" },
} as const;

async function reconnect(provider: keyof typeof SIGN_IN): Promise<void> {
  const current = states.get(provider);
  if (current?.waiting) {
    if (current.url) openUrlInExternalBrowser(current.url);
    return;
  }
  const signIn = SIGN_IN[provider];
  set(provider, { ...IDLE, waiting: true });
  try {
    let status = await signIn.start();
    // A device code (a cloud VM): open the page and copy the code. Without one, the CLI on this Mac opened the browser.
    if (status.state === "waiting" && status.verification_url && status.user_code) {
      openUrlInExternalBrowser(status.verification_url);
      void navigator.clipboard?.writeText(status.user_code).catch(() => {});
    }
    for (const until = Date.now() + GIVE_UP_MS; status.state === "waiting" && Date.now() < until;) {
      set(provider, { waiting: true, url: status.verification_url, code: status.user_code, error: null });
      await new Promise((resolve) => setTimeout(resolve, POLL_MS));
      status = await signIn.check();
    }
    if (status.state !== "connected") throw new Error(status.message ?? `${signIn.name} sign-in didn't finish. Try again.`);
    set(provider, IDLE);
    window.dispatchEvent(new CustomEvent(CLOUD_LOGIN_FIXED_EVENT, { detail: provider }));
  } catch (error) {
    set(provider, { ...IDLE, error: error instanceof Error ? error.message : String(error) });
  }
}

/** `openSettings` handles agents without an inline sign-in here (Claude Code connects in Settings → Agents). */
export function reconnectCloud(provider: CloudLoginProvider, openSettings: () => void): void {
  if (provider === "claude-code") openSettings();
  else void reconnect(provider);
}

/** Cursor's other way in when this Mac has no Cursor login: a user API key, sent to Cloud and never kept here. */
export async function connectCursorKey(key: string): Promise<void> {
  set("acp-cursor", { ...IDLE, waiting: true });
  try {
    const status = await sdk.cloudroom.cursorApiKey(crypto.randomUUID(), key.trim());
    if (status.state !== "connected") throw new Error(status.message ?? "Cursor didn't accept this API key.");
    set("acp-cursor", IDLE);
    window.dispatchEvent(new CustomEvent(CLOUD_LOGIN_FIXED_EVENT, { detail: "acp-cursor" }));
  } catch (error) {
    set("acp-cursor", { ...IDLE, error: error instanceof Error ? error.message : String(error) });
  }
}
