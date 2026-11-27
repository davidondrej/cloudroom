import { randomUUID } from "node:crypto";
import { chmodSync, existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { experimental_defineProviderBridge } from "@get-bb/plugin-sdk/provider-bridge";
import { piProviderBridgeDefinition } from "bb-plugin-provider-pi/src/bridge/bridge.js";

// Cloudroom Agent is Pi with one model, the one Cloudroom hosts (docs/scopes/cloudroom-agent.md). It runs the Pi
// provider's own bridge, in a Pi home of its own: it never reads or changes the user's Pi logins, models, or settings,
// and it offers nothing but our model. The server sends a fresh token with every command (server.ts); it lands in a
// private file that Pi reads for each model call. A token lasts 7 days and ends with its sign-in.

const PI_PROVIDER = "cloudroom";
let home: string | null = null;
let written = "";

function readText(path: string): string | null {
  try {
    return readFileSync(path, "utf8");
  } catch {
    return null;
  }
}

/** Writes a file only its owner can read, whole or not at all. Every environment's bridge shares this folder, so each
 *  write has a temp file of its own. */
function writePrivate(path: string, text: string): void {
  if (readText(path) === text) return;
  const temp = `${path}.${process.pid}.${randomUUID()}.new`;
  try {
    writeFileSync(temp, text, { mode: 0o600 });
    chmodSync(temp, 0o600);
    for (let tries = 1; ; tries++) {
      try {
        renameSync(temp, path);
        return;
      } catch (error) {
        // Windows refuses a rename while another process has the file open: wait for it, up to half a second.
        const code = (error as NodeJS.ErrnoException).code ?? "";
        if (process.platform !== "win32" || !["EPERM", "EACCES", "EBUSY"].includes(code) || tries >= 20) throw error;
        Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 25);
      }
    }
  } finally {
    rmSync(temp, { force: true });
  }
}

const tokenPath = (dir: string) => join(dir, "token");
/** Pi runs this for every model call and sends what it prints as the key. It runs in bash, on Windows too (Git Bash),
 *  which takes forward slashes there. */
function readToken(dir: string): string {
  const path = tokenPath(dir);
  const posix = process.platform === "win32" ? path.replaceAll("\\", "/") : path;
  return `!cat '${posix.replaceAll("'", `'\\''`)}'`;
}

type Model = { id: string } & Record<string, unknown>;
type Grant = { token: string; baseUrl: string; model: Model };

/** What Pi is told before the first token arrives, so the model lists at once. The website's own answer replaces it. */
const FIRST: Omit<Grant, "token"> = {
  baseUrl: "https://www.cloudroom.dev/api/inference",
  model: { id: "cloudroom-agent", name: "Cloudroom Agent", reasoning: true, input: ["text", "image"], contextWindow: 256_000, maxTokens: 16_000, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }, compat: { allowEmptySignature: true } },
};

function grantOf(line: string): Grant | null {
  if (!line.includes('"cloudroomAgent"')) return null;
  try {
    const grant = (JSON.parse(line) as { params?: { options?: { providerOptions?: { cloudroomAgent?: Partial<Grant> } } } }).params?.options?.providerOptions?.cloudroomAgent;
    return typeof grant?.token === "string" && typeof grant.baseUrl === "string" && typeof grant.model?.id === "string" ? (grant as Grant) : null;
  } catch {
    return null;
  }
}

/** Tells Pi where the model is, when that changed. Pi restarts its model list when the file does. */
function describe(dir: string, { baseUrl, model }: Omit<Grant, "token">): void {
  const models = JSON.stringify({ providers: { [PI_PROVIDER]: { name: "Cloudroom", baseUrl, api: "anthropic-messages", apiKey: readToken(dir), models: [model] } } }, null, 2);
  if (models === written) return;
  writePrivate(join(dir, "models.json"), models);
  writePrivate(join(dir, "settings.json"), JSON.stringify({ defaultProvider: PI_PROVIDER, defaultModel: model.id, enabledModels: [`${PI_PROVIDER}/${model.id}`], quietStartup: true }, null, 2));
  written = models;
}

export const experimental_providerBridge = experimental_defineProviderBridge({
  ...piProviderBridgeDefinition,
  start: (context) => {
    const dir = (home = join(context.dataDir, "pi-home"));
    mkdirSync(dir, { recursive: true, mode: 0o700 });
    // Pi and the bridge both read their home from here.
    process.env.PI_CODING_AGENT_DIR = dir;
    process.env.PI_SKIP_VERSION_CHECK = "1";
    written = readText(join(dir, "models.json")) ?? "";
    try {
      // "wx": another bridge may have written a real token meanwhile.
      if (!existsSync(tokenPath(dir))) writeFileSync(tokenPath(dir), "not-signed-in-yet", { mode: 0o600, flag: "wx" });
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
    }
    if (written === "") describe(dir, FIRST);
    piProviderBridgeDefinition.start?.(context);
  },
  handleLine: (line) => {
    const grant = grantOf(line);
    if (grant && home !== null) {
      try {
        writePrivate(tokenPath(home), grant.token);
        describe(home, grant);
      } catch (error) {
        // A throw here would end the bridge, and every thread on it.
        process.stderr.write(`Cloudroom Agent couldn't save its settings: ${error instanceof Error ? error.message : String(error)}\n`);
      }
    }
    piProviderBridgeDefinition.handleLine(line);
  },
});
