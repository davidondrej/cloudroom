import { tmpdir } from "node:os";
import { findCliExecutable, killPortableProcess, spawnPortableProcess } from "@cloudroom/process-utils";

/** One ACP request to a short-lived `agy acp` on this computer: true when it answered, false when it refused, null when
 *  Antigravity is missing or silent. Antigravity keeps its Google login in the system keyring, so only the CLI can read
 *  or clear it. */
function askAntigravity(method: "session/list" | "logout"): Promise<boolean | null> {
  const agy = findCliExecutable("agy");
  if (!agy) return Promise.resolve(null);
  return new Promise(resolve => {
    const child = spawnPortableProcess({ command: agy, args: ["acp"], cwd: tmpdir(), stdio: ["pipe", "pipe", "ignore"], timeout: 15_000 });
    const end = (answer: boolean | null) => { resolve(answer); void killPortableProcess(child, "SIGTERM"); };
    const send = (message: object) => child.stdin?.write(`${JSON.stringify({ jsonrpc: "2.0", ...message })}\n`);
    child.stdin?.on("error", () => end(null));
    child.on("error", () => end(null));
    child.on("exit", () => end(null));
    let buffer = "";
    child.stdout?.on("data", (chunk: Buffer) => {
      buffer += chunk.toString();
      for (let at; (at = buffer.indexOf("\n")) >= 0; buffer = buffer.slice(at + 1)) {
        let message: { id?: unknown; result?: unknown };
        try { message = JSON.parse(buffer.slice(0, at)); } catch { continue; }
        if (message.id === 1) send({ id: 2, method, params: {} });
        if (message.id === 2) end(message.result !== undefined);
      }
    });
    send({ id: 1, method: "initialize", params: { protocolVersion: 1, clientCapabilities: {} } });
  });
}

/** A signed-out `agy acp` refuses `session/list` at once; a signed-in one lists sessions. Nothing is created. */
export const macAntigravitySignedIn = async (): Promise<boolean> => await askAntigravity("session/list") === true;

/** Signs the Antigravity CLI out of Google on this computer, as `/logout` does in `agy`. */
export async function macAntigravitySignOut(): Promise<void> {
  if (await askAntigravity("logout") !== true) throw new Error("Antigravity did not sign out.");
}
