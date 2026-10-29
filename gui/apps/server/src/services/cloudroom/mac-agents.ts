import { readFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import { findCliExecutable } from "@cloudroom/process-utils";
import { macCursorLogin, macOpenclawLogin, macOpencodeLogin, macVariables } from "./sandboxes.js";

const read = (path: string) => readFile(path, "utf8").catch(() => "");
const parse = (text: string | null): unknown => { try { return text ? JSON.parse(text) : null; } catch { return null; } };
const dir = (variable: string, fallback: string) => process.env[variable] || join(homedir(), fallback);
const hasSecret = (value: unknown): boolean =>
  Array.isArray(value) ? value.some(hasSecret)
    : value !== null && typeof value === "object" && Object.entries(value).some(([name, entry]) =>
      typeof entry === "string" ? /(key|token|access|refresh|secret)$/i.test(name) && entry.trim() !== "" : hasSecret(entry));
const setsSecret = (text: string) => /^[ \t]*(export[ \t]+)?[\w.-]*(key|token|secret)[ \t]*=[ \t]*["']?[^\s"'#]/im.test(text);

const AGENTS: [id: string, cli: string, signedIn: () => Promise<boolean>][] = [
  ["pi", "pi", async () => hasSecret(parse(await read(join(dir("PI_CODING_AGENT_DIR", ".pi/agent"), "auth.json"))))],
  ["acp-opencode", "opencode", async () => hasSecret(parse(await macOpencodeLogin()))],
  ["acp-cursor", "cursor-agent", async () => Boolean(process.env.CURSOR_API_KEY) || (await macCursorLogin()) !== null],
  ["acp-hermes-agent", "hermes", async () => hasSecret(parse(await read(join(dir("HERMES_HOME", ".hermes"), "auth.json")))) || setsSecret(await read(join(dir("HERMES_HOME", ".hermes"), ".env")))],
  ["acp-openclaw", "openclaw", async () => (await macOpenclawLogin()) !== null],
  ["acp-grok", "grok", async () => Boolean(process.env.XAI_API_KEY) || hasSecret(parse(await read(join(dir("GROK_HOME", ".grok"), "auth.json"))))],
  ["acp-devin", "devin", async () => setsSecret(await read(join(dir("XDG_DATA_HOME", ".local/share"), "devin", "credentials.toml")))],
  // fx keeps its key and sign-ins in ~/.fx; a Gateway key may live only in the login shell.
  ["acp-fx", "fx", async () => {
    const fx = join(homedir(), ".fx");
    if ((await read(join(fx, "api-key"))).trim()) return true;
    const logins = await Promise.all(["credentials.json", "chatgpt-auth.json", "grok-auth.json"].map((file) => read(join(fx, file))));
    return logins.some((text) => hasSecret(parse(text))) || Boolean(process.env.AI_GATEWAY_API_KEY || (await macVariables()).AI_GATEWAY_API_KEY);
  }],
];

export async function macSignedInAgents(): Promise<string[]> {
  const found = await Promise.all(AGENTS.map(async ([id, cli, signedIn]) => findCliExecutable(cli) && await signedIn().catch(() => false) ? id : null));
  return found.filter(id => id !== null);
}
