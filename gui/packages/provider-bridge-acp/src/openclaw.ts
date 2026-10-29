import type { ReasoningLevel } from "@cloudroom/domain";
import { execFile } from "node:child_process";
import { randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import { connect } from "node:net";
import { homedir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import type { AcpDialect, AcpSessionOpening } from "./dialect.js";

const run = promisify(execFile);
const DEFAULT_PORT = 18789;

function record(value: unknown): Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

async function gatewayTarget(
  env: Record<string, string | undefined>,
): Promise<{ port: number; remote: boolean }> {
  const home =
    env.OPENCLAW_STATE_DIR ?? join(env.HOME ?? homedir(), ".openclaw");
  const text = await readFile(
    env.OPENCLAW_CONFIG_PATH ?? join(home, "openclaw.json"),
    "utf8",
  ).catch(() => "{}");
  let gateway: Record<string, unknown> = {};
  try {
    gateway = record(record(JSON.parse(text)).gateway);
  } catch {
    gateway = {};
  }
  const port = Number(
    env.OPENCLAW_GATEWAY_PORT ?? gateway.port ?? DEFAULT_PORT,
  );
  return {
    port: Number.isInteger(port) ? port : DEFAULT_PORT,
    remote: gateway.mode === "remote",
  };
}

function reachable(port: number): Promise<boolean> {
  return new Promise((resolve) => {
    const socket = connect({ host: "127.0.0.1", port });
    socket.setTimeout(1000);
    socket.once("connect", () => {
      socket.destroy();
      resolve(true);
    });
    socket.once("error", () => resolve(false));
    socket.once("timeout", () => {
      socket.destroy();
      resolve(false);
    });
  });
}

async function ensureGateway(
  command: string,
  env: Record<string, string | undefined>,
): Promise<void> {
  const { port, remote } = await gatewayTarget(env);
  if (remote || (await reachable(port))) return;
  await run(command, ["gateway", "start"], { env, timeout: 60_000 }).catch(
    () => undefined,
  );
  const deadline = Date.now() + 60_000;
  while (Date.now() < deadline) {
    if (await reachable(port)) return;
    await new Promise((resolve) => setTimeout(resolve, 500));
  }
  throw new Error(
    "OpenClaw's Gateway isn't running and could not be started. Run `openclaw gateway start`, or set it up with `openclaw onboard --install-daemon`.",
  );
}

async function call(
  opening: AcpSessionOpening,
  method: string,
  params: Record<string, unknown>,
): Promise<Record<string, unknown>> {
  const output = await run(
    opening.command,
    ["gateway", "call", method, "--json", "--params", JSON.stringify(params)],
    { env: opening.env, timeout: 60_000, maxBuffer: 4 * 1024 * 1024 },
  ).catch((error: { stdout?: string; stderr?: string; message: string }) => ({
    stdout: error.stdout ?? "",
    stderr: error.stderr || error.message,
  }));
  try {
    return record(JSON.parse(output.stdout));
  } catch {
    throw new Error(`OpenClaw's ${method} failed: ${output.stderr.trim()}`);
  }
}

function failure(result: Record<string, unknown>): string | undefined {
  if (result.ok === true) return undefined;
  const message = record(result.error).message;
  return typeof message === "string" ? message : "unknown error";
}

function thinkingLevel(level: ReasoningLevel): string {
  return level === "none" ? "off" : level;
}

async function patch(
  opening: AcpSessionOpening,
  key: string,
  fields: Record<string, unknown>,
): Promise<void> {
  const error = failure(
    await call(opening, "sessions.patch", { key, ...fields }),
  );
  if (error) throw new Error(`OpenClaw could not update the session: ${error}`);
}

async function openSession(opening: AcpSessionOpening): Promise<string> {
  const permissionMode = opening.fullAccess ? "full" : "guarded";
  if (opening.resumeId !== undefined) {
    await patch(opening, opening.resumeId, {
      permissionMode,
      ...(opening.model === undefined ? {} : { model: opening.model }),
    });
    return opening.resumeId;
  }
  const key = `agent:main:cloudroom-${randomUUID()}`;
  const params: Record<string, unknown> = {
    key,
    cwd: opening.cwd,
    permissionMode,
    displayName: "Cloudroom",
    ...(opening.model === undefined ? {} : { model: opening.model }),
    ...(opening.reasoningLevel === undefined
      ? {}
      : { thinkingLevel: thinkingLevel(opening.reasoningLevel) }),
  };
  let result = await call(opening, "sessions.create", params);
  if (failure(result)?.includes("thinkingLevel")) {
    delete params.thinkingLevel;
    result = await call(opening, "sessions.create", params);
  }
  const error = failure(result);
  if (error) throw new Error(`OpenClaw could not start the session: ${error}`);
  const resolved = record(result.resolved);
  if (resolved.modelProvider === "claude-cli") {
    await call(opening, "sessions.delete", { key });
    throw new Error(
      `OpenClaw's model claude-cli/${String(resolved.model)} uses a Claude plan, which Cloudroom can't use with OpenClaw. Pick another model.`,
    );
  }
  if (opening.model === undefined && typeof resolved.model === "string") {
    await patch(opening, key, {
      model: `${String(resolved.modelProvider)}/${resolved.model}`,
    });
  }
  return key;
}

export const OPENCLAW_ACP_DIALECT: AcpDialect = {
  id: "openclaw",
  prepareLaunch: ensureGateway,
  openSession,
  sessionMcpServers: false,
  hidesModel: (id) => id.startsWith("claude-cli/"),
  emptyTurnError:
    "OpenClaw ended the turn without replying. Its model may have no login: check `openclaw models status`. Claude plans can't be used through Cloudroom.",
};
