/** Agents whose Cloud login can be refused ("disconnected in Cloud"). Shared by the banner, threads, and paused loops. */
export type CloudLoginProvider = "codex" | "claude-code" | "acp-cursor";

const NAMES: Record<CloudLoginProvider, string> = { codex: "Codex", "claude-code": "Claude Code", "acp-cursor": "Cursor" };
const BY_NAME = new Map(Object.entries(NAMES).map(([id, name]) => [name, id as CloudLoginProvider]));

export const cloudLoginName = (provider: CloudLoginProvider): string => NAMES[provider];

/** The one line users see when Cloud refuses an agent's login. */
export const cloudLoginTitle = (provider: CloudLoginProvider): string => `${NAMES[provider]} disconnected in Cloud`;

// Core's refusal ("Connect your ChatGPT subscription to use Codex in Cloud."), the website's loop reason, old and new
// ("Connect Codex first.", "Codex disconnected in Cloud.").
const REFUSAL = /to use (Codex|Claude Code|Cursor) in Cloud\b|^Connect (Codex|Claude Code|Cursor) first\b|^(Codex|Claude Code|Cursor) disconnected in Cloud\b/u;

/** Which agent's Cloud login a refusal or paused loop's reason names, or null for any other error. */
export function cloudLoginProvider(text: string | null | undefined): CloudLoginProvider | null {
  const match = text ? REFUSAL.exec(text.trim()) : null;
  const name = match?.[1] ?? match?.[2] ?? match?.[3];
  return name ? BY_NAME.get(name) ?? null : null;
}
