import { mkdtemp, readdir, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  createConnection,
  migrate,
  getAppSettings,
  setAppSettings,
} from "@cloudroom/db";
import { defaultAppSettings } from "@cloudroom/domain";
import { seedEvent, seedThreadFixture } from "../helpers/seed.js";
import { withTestHarness } from "../helpers/test-app.js";
import { DEFAULTS } from "@cloudroom/config/defaults";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  installAuthFailureTelemetry,
  noteTurnFailed,
} from "../../src/services/system/auth-failure-telemetry.js";
import {
  createTelemetryPrivacyFilter,
  createTelemetryService,
  runWithTelemetryAppSurface,
} from "../../src/services/system/telemetry.js";
import { createProviderRegistryService } from "../../src/services/providers/provider-registry.js";

function createTestLogger() {
  return {
    debug: vi.fn(),
    error: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
  };
}

type Telemetry = Awaited<ReturnType<typeof createTelemetryService>>;
type Batch = { install_id: string; events: { id: string; name: string; properties: Record<string, unknown> }[] };

describe("telemetry service", () => {
  let dataDir: string;
  let fetchMock: ReturnType<typeof vi.fn>;
  /** Sends what is queued, and returns every batch sent so far. */
  const batches = async (telemetry: Telemetry): Promise<Batch[]> => {
    telemetry.setTargetSource(async () => ({ website: "https://example.test" }));
    await telemetry.flush();
    return fetchMock.mock.calls.map(([url, init]) => {
      expect(url).toBe("https://example.test/api/desktop/events");
      return JSON.parse((init as { body: string }).body) as Batch;
    });
  };

  beforeEach(async () => {
    dataDir = await mkdtemp(join(tmpdir(), "bb-telemetry-test-"));
    fetchMock = vi.fn().mockResolvedValue(new Response(null, { status: 200 }));
    vi.stubGlobal("fetch", fetchMock);
  });

  afterEach(async () => {
    vi.unstubAllGlobals();
    await rm(dataDir, { recursive: true, force: true });
  });

  it("sends events with a stable anonymous install id", async () => {
    const telemetry = await createTelemetryService({
      appSurface: "web",
      appVersion: "1.2.3",
      dataDir,
      desktopVersion: "v66",
      telemetryEnabled: true,
      enabled: true,
      logger: createTestLogger(),
    });

    telemetry.capture({ name: "app_started" });
    runWithTelemetryAppSurface("desktop", () => {
      telemetry.capture({
        name: "thread_created",
        properties: {
          execution: "local",
          is_child_thread: true,
          provider: "claude-code",
        },
      });
    });
    telemetry.capture({
      name: "user_message_sent",
      properties: {
        execution: "cloud_sandbox",
        is_child_thread: false,
        message_source: "thread_send",
        provider: "codex",
      },
    });

    const sent = await batches(telemetry);
    expect(sent).toHaveLength(1);
    const persistedId = (
      await readFile(join(dataDir, "telemetry-id"), "utf8")
    ).trim();
    expect(persistedId).toMatch(/^[0-9a-f]{32}$/);
    expect(sent[0]?.install_id).toBe(persistedId);
    const events = sent[0]!.events;
    expect(events[0]).toMatchObject({
      name: "app_started",
      properties: {
        app_version: "1.2.3",
        app_surface: "web",
        arch: process.arch,
        cloudroom_version: "v66",
        platform: process.platform,
      },
    });
    expect(events[1]).toMatchObject({
      name: "thread_created",
      properties: {
        app_version: "1.2.3",
        app_surface: "desktop",
        is_child_thread: true,
        provider: "claude-code",
      },
    });
    expect(events[2]).toMatchObject({
      name: "user_message_sent",
      properties: {
        app_version: "1.2.3",
        app_surface: "web",
        execution: "cloud_sandbox",
        is_child_thread: false,
        message_source: "thread_send",
        provider: "codex",
      },
    });
  });

  it("reuses the persisted install id across restarts", async () => {
    const args = {
      appSurface: "web" as const,
      appVersion: "1.2.3",
      dataDir,
      telemetryEnabled: true,
      enabled: true,
      logger: createTestLogger(),
    };
    const first = await createTelemetryService(args);
    first.capture({ name: "app_started" });
    await batches(first);
    const second = await createTelemetryService(args);
    second.capture({ name: "app_started" });

    const ids = (await batches(second)).map((batch) => batch.install_id);
    expect(ids).toHaveLength(2);
    expect(ids[0]).toBe(ids[1]);
  });

  it("removes HTTP URL credentials from failed-turn telemetry", async () => {
    await withTestHarness({ seedFirstPartyProviders: false }, async (harness) => {
      const { thread } = seedThreadFixture(harness, { thread: { status: "error" } });
      seedEvent(harness.deps, {
        threadId: thread.id,
        sequence: 1,
        type: "system/error",
        scope: { kind: "thread" },
        data: { message: "Could not reach https://fixture-user:fixture-pass@proxy:8443/api" },
      });
      const telemetry = await createTelemetryService({
        appSurface: "desktop",
        appVersion: "1.2.3",
        dataDir,
        enabled: true,
        telemetryEnabled: true,
        logger: harness.deps.logger,
      });
      const stop = installAuthFailureTelemetry({ db: harness.db, logger: harness.deps.logger, telemetry });
      try {
        noteTurnFailed(thread.id);
        await new Promise<void>((resolve) => setImmediate(resolve));
        const [batch] = await batches(telemetry);
        expect(batch?.events).toMatchObject([{
          name: "turn_failed",
          properties: { error_message: "Could not reach https://proxy:8443/api" },
        }]);
      } finally {
        stop();
      }
    });
  });

  it.each([
    {
      appVersion: "1.2.3",
      enabled: false,
      label: "the user opted out",
    },
    {
      appVersion: DEFAULTS.appVersion,
      enabled: true,
      label: "the release version is unresolved",
    },
  ])("is fully inert when $label", async ({ appVersion, enabled }) => {
    const telemetry = await createTelemetryService({
      appSurface: "web",
      appVersion,
      dataDir,
      telemetryEnabled: true,
      enabled,
      logger: createTestLogger(),
    });
    telemetry.setEnabled(true);
    telemetry.capture({ name: "app_started" });

    expect(await batches(telemetry)).toEqual([]);
    await expect(readdir(dataDir)).resolves.toEqual([]);
  });

  it("honors persisted opt-out at startup and changes without restarting", async () => {
    const db = createConnection(":memory:");
    migrate(db);
    try {
      setAppSettings(db, { ...getAppSettings(db), telemetryEnabled: false });
      const args = {
          appSurface: "web" as const,
        appVersion: "1.2.3",
        dataDir,
        enabled: true,
        telemetryEnabled: getAppSettings(db).telemetryEnabled,
        logger: createTestLogger(),
      };
      const telemetry = await createTelemetryService(args);
      telemetry.capture({ name: "app_started" });
      expect(await batches(telemetry)).toEqual([]);
      setAppSettings(db, { ...getAppSettings(db), telemetryEnabled: true });
      telemetry.setEnabled(true);
      telemetry.capture({ name: "app_started" });
      expect(await batches(telemetry)).toHaveLength(1);
      setAppSettings(db, { ...getAppSettings(db), telemetryEnabled: false });
      telemetry.setEnabled(false);
      telemetry.capture({ name: "app_started" });
      const restarted = await createTelemetryService({
        ...args,
        telemetryEnabled: getAppSettings(db).telemetryEnabled,
      });
      restarted.capture({ name: "app_started" });
      await batches(telemetry);
      expect(await batches(restarted)).toHaveLength(1);
    } finally {
      db.$client.close();
    }
  });

  it("updates the cached preference only after valid settings writes", async () => {
    await withTestHarness(async (harness) => {
      const telemetry = await createTelemetryService({
          appSurface: "web",
        appVersion: "1.2.3",
        dataDir,
        enabled: true,
        telemetryEnabled: getAppSettings(harness.db).telemetryEnabled,
        logger: createTestLogger(),
      });
      harness.deps.telemetry = telemetry;
      const put = (settings: object) =>
        harness.app.request("/api/v1/settings/general", {
          method: "PUT",
          headers: { "content-type": "application/json" },
          body: JSON.stringify(settings),
        });
      telemetry.capture({ name: "app_started" });
      expect(await batches(telemetry)).toHaveLength(1);
      expect(
        (await put({ ...defaultAppSettings, telemetryEnabled: false })).status,
      ).toBe(200);
      telemetry.capture({ name: "app_started" });
      expect(await batches(telemetry)).toHaveLength(1);
      expect((await put({ telemetryEnabled: true })).status).toBe(400);
      telemetry.capture({ name: "app_started" });
      expect(await batches(telemetry)).toHaveLength(1);
      const { telemetryEnabled, ...legacy } = defaultAppSettings;
      expect(telemetryEnabled).toBe(true);
      expect((await put(legacy)).status).toBe(200);
      telemetry.capture({ name: "app_started" });
      expect(await batches(telemetry)).toHaveLength(1);
      expect((await put(defaultAppSettings)).status).toBe(200);
      telemetry.capture({ name: "app_started" });
      expect(await batches(telemetry)).toHaveLength(2);
    });
  });

  it("batches events to the website, and sends nothing once turned off", async () => {
    const telemetry = await createTelemetryService({
      appSurface: "desktop",
      appVersion: "1.2.3",
      dataDir,
      telemetryEnabled: true,
      enabled: true,
      logger: createTestLogger(),
    });
    const calls = () => fetchMock.mock.calls.filter(([url]) => String(url).endsWith("/api/desktop/events"));
    let release = () => {};
    telemetry.setTargetSource(() => new Promise((resolve) => { release = () => resolve({ website: "https://example.test" }); }));
    telemetry.capture({ name: "bug_report_clicked" });
    const pending = telemetry.flush(); // Now waiting for the account lookup.
    telemetry.setEnabled(false);
    release();
    await pending;
    expect(calls()).toHaveLength(0);

    telemetry.setEnabled(true);
    telemetry.setTargetSource(async () => ({ website: "https://example.test", authorization: "Basic abc" }));
    telemetry.capture({ name: "bug_report_clicked" });
    await telemetry.flush();
    expect(calls()).toHaveLength(1);
    const [, init] = calls()[0] as [string, { body: string; headers: Record<string, string> }];
    const sent = JSON.parse(init.body) as { install_id: string; events: { id: string; name: string }[] };
    expect(sent.install_id).toMatch(/^[0-9a-f]{32}$/);
    expect(sent.events.map((event) => event.name)).toEqual(["bug_report_clicked"]);
    expect(init.headers.authorization).toBe("Basic abc");
  });

  it("logs and swallows send failures", async () => {
    const logger = createTestLogger();
    fetchMock.mockRejectedValue(new Error("offline"));
    const telemetry = await createTelemetryService({
      appSurface: "desktop",
      appVersion: "1.2.3",
      dataDir,
      telemetryEnabled: true,
      enabled: true,
      logger,
    });

    telemetry.capture({ name: "app_started" });
    telemetry.setTargetSource(async () => ({ website: "https://example.test" }));
    await telemetry.flush();
    expect(logger.debug).toHaveBeenCalledWith({ err: expect.any(Error) }, "Telemetry batch send failed");
  });

  it("masks custom models and custom ACP providers before queuing events", async () => {
    const db = createConnection(":memory:");
    migrate(db);
    try {
      const registry = createProviderRegistryService();
      const registerProvider = (id: string, customAgent: boolean) => {
        registry.register({
          info: {
            id,
            pluginId: "provider-acp",
            displayName: id,
            family: "acp",
            logoUrl: null,
            completedTurnDisplay: "collapse",
            available: true,
            capabilities: {
              supportsServiceTier: false,
              supportsNativeUserQuestion: false,
              supportsThreadArchive: false,
              supportsThreadRename: false,
              supportsFork: false,
              supportsSessionRewind: false,
              permissionModes: ["full"],
              modelCatalogScope: "host",
            },
            composerActions: [],
            maintenance: { health: false, usage: false, installation: false },
          },
          serverCapabilities: { reasoningLevels: ["medium"], fork: "none", supportsManualCompaction: false },
          bridgeOptions: customAgent ? { customAgent: true } : {},
          extensionKinds: {},
          visibility: "always",
          pluginId: "provider-acp",
          fallbackModels: [],
          envPassthrough: [],
          nativeSkillRoots: { user: [], project: [] },
          nativeCommandRoots: { user: [], project: [] },
          resolvesNativeRoots: false,
          deriveProviderOptions: () => ({}),
          iconNames: new Set(),
        });
      };
      registerProvider("acp-opencode", false);
      registerProvider("acp-acme-internal", true);

      const telemetry = await createTelemetryService({
        appSurface: "desktop",
        appVersion: "1.2.3",
        dataDir,
        telemetryEnabled: true,
        enabled: true,
        logger: createTestLogger(),
      });
      telemetry.setPrivacyFilter(createTelemetryPrivacyFilter({
        db,
        getCustomModels: () => [{ providerId: "claude-code", model: "internal-codename-7b", displayName: "Internal 7B" }],
        providerRegistry: registry,
      }));

      telemetry.capture({
        name: "first_response",
        properties: { execution: "local", is_child_thread: false, message_source: "thread_send", ms: 100, provider: "claude-code", sandbox_woke: null, model: "internal-codename-7b" },
      });
      telemetry.capture({
        name: "token_usage",
        properties: { day: "2026-11-24", provider: "claude-code", model: "Internal Codename 7b", is_child_thread: false, input: 10, cached: 0, cache_write: 0, output: 5, turns: 1 },
      });
      telemetry.capture({
        name: "first_response",
        properties: { execution: "local", is_child_thread: false, message_source: "thread_send", ms: 100, provider: "acp-acme-internal", sandbox_woke: null, model: "discovered-private-model" },
      });
      telemetry.capture({
        name: "harness_switched",
        properties: { execution: "local", from: "acp-acme-internal", to: "acp-opencode", resend: false },
      });
      telemetry.capture({
        name: "first_response",
        properties: { execution: "local", is_child_thread: false, message_source: "thread_send", ms: 100, provider: "acp-opencode", sandbox_woke: null, model: "gpt-5.4" },
      });
      telemetry.capture({
        name: "first_response",
        properties: { execution: "local", is_child_thread: false, message_source: "thread_send", ms: 100, provider: "acp-opencode", sandbox_woke: null, model: "my-proxy/claude-opus-5-5" },
      });
      telemetry.capture({
        name: "first_response",
        properties: { execution: "local", is_child_thread: false, message_source: "thread_send", ms: 100, provider: "claude-code", sandbox_woke: null, model: "arn:aws:bedrock:us-east-1:123456:inference-profile/secret" },
      });
      telemetry.capture({
        name: "first_response",
        properties: { execution: "local", is_child_thread: false, message_source: "thread_send", ms: 100, provider: "pi", sandbox_woke: null, model: "ollama/qwen3-coder" },
      });
      telemetry.capture({
        name: "token_usage",
        properties: { day: "2026-11-24", provider: "claude-code", model: "Opus 5.5", is_child_thread: false, input: 10, cached: 0, cache_write: 0, output: 5, turns: 1 },
      });
      telemetry.capture({
        name: "first_response",
        properties: { execution: "local", is_child_thread: false, message_source: "thread_send", ms: 100, provider: "pi", sandbox_woke: null, model: "openrouter/anthropic/claude-opus-5-5[1m]" },
      });

      const [batch] = await batches(telemetry);
      expect(batch!.events.map((event) => ({
        name: event.name,
        provider: event.properties.provider,
        model: event.properties.model,
        from: event.properties.from,
        to: event.properties.to,
      }))).toEqual([
        { name: "first_response", provider: "claude-code", model: "custom", from: undefined, to: undefined },
        { name: "token_usage", provider: "claude-code", model: "custom", from: undefined, to: undefined },
        { name: "first_response", provider: "custom", model: "custom", from: undefined, to: undefined },
        { name: "harness_switched", provider: undefined, model: undefined, from: "custom", to: "acp-opencode" },
        { name: "first_response", provider: "acp-opencode", model: "gpt-5.4", from: undefined, to: undefined },
        { name: "first_response", provider: "acp-opencode", model: "custom", from: undefined, to: undefined },
        { name: "first_response", provider: "claude-code", model: "custom", from: undefined, to: undefined },
        { name: "first_response", provider: "pi", model: "custom", from: undefined, to: undefined },
        { name: "token_usage", provider: "claude-code", model: "Opus 5.5", from: undefined, to: undefined },
        { name: "first_response", provider: "pi", model: "openrouter/anthropic/claude-opus-5-5[1m]", from: undefined, to: undefined },
      ]);
    } finally {
      db.$client.close();
    }
  });
});
