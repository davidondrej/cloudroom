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
import { withTestHarness } from "../helpers/test-app.js";
import { DEFAULTS } from "@cloudroom/config/defaults";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  createTelemetryService,
  runWithTelemetryAppSurface,
} from "../../src/services/system/telemetry.js";

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
});
