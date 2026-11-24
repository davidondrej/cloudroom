import { mkdir, mkdtemp, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, it, vi } from "vitest";
import { createConnection, getPluginKvValue, migrate, setPluginKvValue } from "@cloudroom/db";
import type { Logger } from "@cloudroom/logger";
import { createAiServiceRegistry } from "../../../src/services/ai/ai-service-registry.js";
import { resolveBuiltinPluginRootPath } from "../../../src/services/plugins/builtin-registry.js";
import { createPluginService } from "../../../src/services/plugins/plugin-service.js";
import { createNoopTelemetryService } from "../../../src/services/system/telemetry.js";
import { testLogger } from "../../helpers/test-app.js";

const home = process.env.HOME;
afterEach(() => void (process.env.HOME = home));

const account = (id: string) => ({ id, provider: "claude-code", email: `${id}@example.com`, plan: "max", accountKey: null, profile: `p-${id}`, org: `org-${id}`, createdAt: 1 });
const cursor = (id: string) => ({ id, provider: "acp-cursor", email: `${id}@example.com`, plan: null, accountKey: null, createdAt: 1 });
const newer = { ...account("c"), provider: "a-newer-agent" };
const damaged = { ...account("c"), createdAt: "soon" };
const login = (id: string) => [`profiles/p-${id}`, `secrets/${id}.json`];
const clear = (provider: string) => [["accounts.clear", { provider }]];

// Each row: what accounts:v1 holds, the RPC calls made, the login files that stay or go, and what is stored after.
it.each([
  { name: "one record of an unknown agent", stored: [account("a"), account("b"), newer], calls: [["accounts.rename", { provider: "claude-code", id: "a", name: "Work" }]], kept: [...login("a"), ...login("b")], gone: [], after: [{ ...account("a"), name: "Work" }, account("b"), newer] },
  { name: "a value that is not a list", stored: { broken: true }, calls: [], kept: [...login("a"), ...login("b")], gone: [], after: { broken: true } },
  { name: "a value that is one Claude record, not a list", stored: account("b"), calls: [], kept: [...login("a"), ...login("b")], gone: [], after: account("b") },
  { name: "a value that is one Codex record, not a list", stored: { ...account("b"), provider: "codex" }, calls: [], kept: login("b"), gone: [], after: { ...account("b"), provider: "codex" } },
  { name: "the Codex move with a kept unreadable Cursor record sharing its id", stored: [{ ...account("k"), provider: "codex" }, { ...cursor("k"), createdAt: "soon" }], calls: [], kept: ["secrets/k.json"], gone: [], after: [{ ...account("k"), provider: "codex" }, { ...cursor("k"), createdAt: "soon" }] },
  { name: "the Codex move with an unreadable record of another id", stored: [{ ...account("a"), provider: "codex" }, { ...cursor("b"), createdAt: "soon" }], calls: [], kept: ["secrets/a.json", "secrets/b.json"], gone: [], after: [{ ...account("a"), provider: "codex" }, { ...cursor("b"), createdAt: "soon" }] },
  { name: "Disconnect with an unreadable Claude record", stored: [account("a"), damaged], calls: clear("claude-code"), kept: [], gone: [...login("a"), ...login("c")], after: [] },
  { name: "Disconnect with an unreadable Claude record naming a Cursor account's id", stored: [cursor("k"), { ...damaged, id: "k" }], calls: clear("claude-code"), kept: ["secrets/k.json"], gone: ["profiles/p-c"], after: [cursor("k")] },
  { name: "Disconnect with a kept unreadable Cursor record sharing a Claude account's id", stored: [account("k"), { ...cursor("k"), createdAt: "soon" }], calls: clear("claude-code"), kept: ["secrets/k.json"], gone: ["profiles/p-k"], after: [{ ...cursor("k"), createdAt: "soon" }] },
  { name: "Disconnect Cursor with an unreadable record naming a Claude account's folder", stored: [account("a"), { ...cursor("x"), createdAt: "soon", profile: "p-a" }], calls: clear("acp-cursor"), kept: login("a"), gone: ["secrets/x.json"], after: [account("a")] },
])("keeps saved Claude logins when a stored record can't be read: $name (#1130)", async ({ stored, calls, kept, gone, after }) => {
  const work = await mkdtemp(join(tmpdir(), "accounts-plugin-"));
  process.env.HOME = join(work, "home");
  await mkdir(join(work, "home", ".claude"), { recursive: true });
  await writeFile(join(work, "home", ".claude.json"), "{}");
  const db = createConnection(join(work, "db.sqlite"));
  migrate(db);
  const plugin = join(work, "data", "plugins", "accounts");
  const start = async () => {
    const service = createPluginService({
      aiServices: createAiServiceRegistry(), telemetry: createNoopTelemetryService(), db, logger: testLogger as unknown as Logger,
      hub: { getDaemonSessionIdForHost: () => null, notifyPluginSignal: () => 0, notifySystem: () => {} },
      dataDir: join(work, "data"), appVersion: "0.9.0", loadTimeoutMs: 30_000,
      bundledPlugins: [{ name: "accounts", pluginId: "accounts", autoInstall: true, defaultEnabled: true, rootDir: resolveBuiltinPluginRootPath("accounts") }],
    });
    await service.start();
    return service;
  };
  const exists = async (path: string) => (await stat(join(plugin, path)).catch(() => null)) !== null;
  try {
    await (await start()).stop();
    setPluginKvValue(db, "accounts", "accounts:v1", JSON.stringify(stored));
    for (const path of [...kept, ...gone]) {
      if (path.startsWith("profiles/")) await mkdir(join(plugin, path), { recursive: true });
      else await writeFile(join(plugin, path), "{}");
    }

    const service = await start();
    for (const [method, input] of calls) {
      const handler = service.getRpcHandler("accounts", method as string);
      if (handler.outcome !== "found") throw new Error(`${method}: ${handler.outcome}`);
      const result = await service.invokeRpcHandler("accounts", method as string, handler.value, input, { kind: "client" });
      if (!result.ok) throw new Error(result.error.message);
    }
    await vi.waitFor(async () => {
      for (const path of gone) expect(await exists(path)).toBe(false);
    }, { timeout: 20_000 });
    await new Promise((resolve) => setTimeout(resolve, 500));
    await service.stop();

    for (const path of kept) expect(await exists(path)).toBe(true);
    expect(JSON.parse(getPluginKvValue(db, "accounts", "accounts:v1")!)).toEqual(after);
  } finally {
    await rm(work, { recursive: true, force: true });
  }
}, 60_000);
