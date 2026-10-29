import { cloudroom } from "./services/cloudroom/commands.js";
import { serve } from "@hono/node-server";
import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import type { ServerConfig } from "@cloudroom/config/server";
import { isLoopbackHostname } from "@cloudroom/config/loopback";
import { moveLegacyUserSkills, resolveUserSkillsRootPath } from "@cloudroom/config/skill-storage-paths";
import { toOptionalString } from "@cloudroom/config/strings";
import { createLogger } from "@cloudroom/logger";
import { getAppSettings } from "@cloudroom/db";
import { initDb } from "./db.js";
import { createApp } from "./server.js";
import { PendingInteractionLifecycle } from "./services/interactions/pending-interactions.js";
import { createMachineAuthService } from "./services/machine-auth.js";
import { resolveBuiltinSkillsRootPath } from "./services/skills/builtin-skills-copy.js";
import { SkillTreeRegistry } from "./services/skills/injected-skills.js";
import { PluginHostArtifactRegistry } from "./services/plugins/plugin-host-artifact-registry.js";
import { createProviderNativeRootsCache } from "./services/providers/native-roots.js";
import { createAiServiceRegistry } from "./services/ai/ai-service-registry.js";
import { createAppVersionService } from "./services/system/app-version.js";
import { createBbAppManagedConfigReloader } from "./services/system/bb-app-managed-config.js";
import { startEventLoopStallMonitor } from "./services/system/event-loop-stall-monitor.js";
import {
  runPeriodicSweeps,
  runStartupRecoverySweep,
} from "./services/system/periodic-sweeps.js";
import { installProviderModelCatalogPrewarm } from "./services/providers/provider-model-catalog-prewarm.js";
import {
  PROVIDER_AUTO_UPDATE_FIRST_RUN_MS,
  PROVIDER_AUTO_UPDATE_INTERVAL_MS,
  runProviderAutoUpdates,
} from "./services/system/provider-auto-update.js";
import { createProviderRegistryService } from "./services/providers/provider-registry.js";
import { installFirstResponseTelemetry } from "./services/system/first-response-telemetry.js";
import { startOrgPlugin } from "./services/cloudroom/org-plugin.js";
import { startSetupTelemetry } from "./services/cloudroom/setup-telemetry.js";
import { installTitleRecheck } from "./services/threads/title-recheck.js";
import { installThreadPurpose } from "./services/threads/thread-purpose.js";
import { installAuthFailureTelemetry } from "./services/system/auth-failure-telemetry.js";
import { createTelemetryService } from "./services/system/telemetry.js";
import { TerminalSessionLifecycle } from "./services/terminals/terminal-session-lifecycle.js";
import { createLifecycleDedupers } from "./lifecycle-dedupers.js";
import type { ServerRuntimeConfig } from "./types.js";
import { NotificationHub } from "./ws/hub.js";
import { WatchInterestCoordinator } from "./ws/watch-interests.js";
import { WorkspaceReadCaches } from "./services/environments/workspace-read-cache.js";
import { HostSharedPortCoordinator } from "./ws/host-shared-ports.js";

interface StartHttpListenerArgs {
  fetch: Parameters<typeof serve>[0]["fetch"];
  serverConfig: Pick<ServerConfig, "BB_SERVER_BIND_HOST" | "BB_SERVER_PORT">;
}

export function startHttpListener(args: StartHttpListenerArgs) {
  return serve({
    hostname: args.serverConfig.BB_SERVER_BIND_HOST,
    port: args.serverConfig.BB_SERVER_PORT,
    fetch: args.fetch,
  });
}

export async function runServer(serverConfig: ServerConfig): Promise<void> {
  const logger = createLogger({
    component: "server",
    dataDir: serverConfig.BB_DATA_DIR,
  });
  const db = initDb(serverConfig.databasePath, {
    dataDir: serverConfig.BB_DATA_DIR,
    logger,
  });
  const hub = new NotificationHub();
  const watchInterests = new WatchInterestCoordinator({ db, hub });
  const sharedPorts = new HostSharedPortCoordinator({ db, hub });
  const workspaceReadCaches = new WorkspaceReadCaches({ hub });
  const lifecycleDedupers = createLifecycleDedupers();
  const appUrl = toOptionalString(serverConfig.BB_APP_URL);

  const selfDir = dirname(fileURLToPath(import.meta.url));
  const appDir = resolve(selfDir, "../../app");
  const appDistDir = join(appDir, "dist");
  const isProduction = process.env.NODE_ENV === "production";
  const staticDir =
    isProduction && existsSync(appDistDir) ? appDistDir : undefined;
  const runtimeConfig: ServerRuntimeConfig = {
    appVersion: serverConfig.BB_APP_VERSION,
    builtinSkillsRootPath: resolveBuiltinSkillsRootPath(),
    marketplaceUrl: serverConfig.BB_MARKETPLACE_URL,
    customModels: [],
    dataDir: serverConfig.BB_DATA_DIR,
    featureFlags: serverConfig.featureFlags,
    hostDaemonPort: serverConfig.BB_HOST_DAEMON_PORT,
    inheritedSkillsRootPaths: serverConfig.BB_INHERITED_SKILLS_ROOTS,
    inferenceFallbackModel: serverConfig.BB_INFERENCE_FALLBACK,
    inferenceModel: serverConfig.BB_INFERENCE,
    isDevelopment: !isProduction,
    openAiApiKey: serverConfig.OPENAI_API_KEY,
    serverPort: serverConfig.BB_SERVER_PORT,
    sharedSkillRoots: { user: [], project: [] },
    transcriptionModel: serverConfig.BB_TRANSCRIPTION,
    userSkillsRootPath: resolveUserSkillsRootPath(homedir()),
  };
  await moveLegacyUserSkills({
    dataDir: runtimeConfig.dataDir,
    userSkillsRootPath: runtimeConfig.userSkillsRootPath,
  }).then(
    ({ moved, skipped }) => {
      if (moved.length > 0 || skipped.length > 0) {
        logger.info({ moved, skipped }, "Moved user skills to ~/.cloudroom/skills");
      }
    },
    (error: unknown) => logger.warn({ error }, "Could not move user skills to ~/.cloudroom/skills"),
  );

  const providerRegistry = createProviderRegistryService({
    deferRegistrationsSettled: true,
    readUserProviderPreferences: () => {
      const settings = getAppSettings(db);
      return {
        providerOrder: settings.providerOrder,
        defaultProviderId: settings.defaultProviderId,
      };
    },
  });

  if (appUrl !== undefined) {
    runtimeConfig.appUrl = appUrl;
  }
  if (serverConfig.BB_DEV_APP_PORT !== undefined) {
    runtimeConfig.devAppPort = serverConfig.BB_DEV_APP_PORT;
  }
  if (serverConfig.BB_SERVER_LAUNCH_ID !== undefined) {
    runtimeConfig.launchId = serverConfig.BB_SERVER_LAUNCH_ID;
  }
  const terminalSessions = new TerminalSessionLifecycle({
    cloudTerminal: (threadId) =>
      cloudroom({
        config: runtimeConfig,
        db,
        hub,
        providerRegistry,
      }).terminalConnection(threadId),
    config: runtimeConfig,
    db,
    hub,
    logger,
  });
  const bbAppManagedConfig = await createBbAppManagedConfigReloader({
    config: runtimeConfig,
    hub,
    logger,
  });

  const telemetry = await createTelemetryService({
    apiKey: serverConfig.BB_POSTHOG_API_KEY,
    appSurface: serverConfig.BB_APP_SURFACE,
    appVersion: serverConfig.BB_APP_VERSION,
    dataDir: serverConfig.BB_DATA_DIR,
    desktopVersion: process.env.BB_DESKTOP_VERSION,
    enabled: serverConfig.BB_TELEMETRY && isProduction,
    telemetryEnabled: getAppSettings(db).telemetryEnabled,
    logger,
  });

  const machineAuth = await createMachineAuthService({
    dataDir: serverConfig.BB_DATA_DIR,
    db,
    logger,
  });
  await machineAuth.ensureReady();
  const skillTreeRegistry = new SkillTreeRegistry();
  const pluginHostArtifacts = new PluginHostArtifactRegistry();
  const providerNativeRoots = createProviderNativeRootsCache();
  const aiServices = createAiServiceRegistry();
  const pendingInteractions = new PendingInteractionLifecycle({
    config: runtimeConfig,
    db,
    hub,
    lifecycleDedupers,
    logger,
    machineAuth,
    providerRegistry,
    pluginHostArtifacts,
    aiServices,
    skillTreeRegistry,
    telemetry,
    terminalSessions,
  });
  pendingInteractions.start();

  const appVersion = createAppVersionService({
    config: runtimeConfig,
    desktopVersion: process.env.BB_DESKTOP_VERSION,
  });
  const {
    app,
    closeWebSockets,
    injectWebSocket,
    pluginCatalogService,
    pluginService,
  } = createApp(
    {
      appVersion,
      bbAppManagedConfig,
      config: runtimeConfig,
      db,
      hub,
      lifecycleDedupers,
      logger,
      machineAuth,
      pendingInteractions,
      providerRegistry,
      pluginHostArtifacts,
      providerNativeRoots,
      aiServices,
      skillTreeRegistry,
      telemetry,
      terminalSessions,
      watchInterests,
      sharedPorts,
      workspaceReadCaches,
    },
    { staticDir },
  );
  const eventLoopStallMonitor = startEventLoopStallMonitor({ logger });
  const cloud = cloudroom({
    db, hub, config: runtimeConfig, providerRegistry, logger, lifecycleDedupers,
    machineAuth, pluginHostArtifacts, aiServices, skillTreeRegistry, telemetry, pendingInteractions,
  });
  cloud.start();
  telemetry.setPlanSource(() => cloud.sandboxes.currentPlan());
  const stopFirstResponseTelemetry = installFirstResponseTelemetry({ db, hub, telemetry }, (threadId, at) => cloud.sandboxes.wokeSince(threadId, at), (threadId, at) => cloud.sandboxes.startupSince(threadId, at));
  const stopAuthFailureTelemetry = installAuthFailureTelemetry({ db, logger, telemetry });

  const sweepDeps = {
    config: runtimeConfig,
    db,
    hub,
    lifecycleDedupers,
    logger,
    machineAuth,
    pendingInteractions,
    providerRegistry,
    pluginHostArtifacts,
    aiServices,
    skillTreeRegistry,
    pluginSchedules: pluginService,
    plugins: pluginService,
    telemetry,
    terminalSessions,
  };
  const providerModelCatalogPrewarm =
    installProviderModelCatalogPrewarm(sweepDeps);
  const stopTitleRecheck = installTitleRecheck(sweepDeps, cloud.sandboxes);
  const stopThreadPurpose = installThreadPurpose(sweepDeps);
  await runStartupRecoverySweep(sweepDeps).catch((error) => {
    logger.error({ err: error }, "Startup recovery sweep failed");
  });

  if (!isLoopbackHostname(serverConfig.BB_SERVER_BIND_HOST)) {
    logger.warn(
      { bindHost: serverConfig.BB_SERVER_BIND_HOST },
      "SECURITY WARNING: The public API is unauthenticated and permits command execution and file reads. Wildcard server binding must only be used behind a trusted network boundary.",
    );
  }

  const server = startHttpListener({
    fetch: app.fetch,
    serverConfig,
  });
  injectWebSocket(server);

  logger.info(
    {
      bindHost: serverConfig.BB_SERVER_BIND_HOST,
      port: serverConfig.BB_SERVER_PORT,
      dataDir: serverConfig.BB_DATA_DIR,
    },
    "Server listening",
  );
  telemetry.capture({
    name: "app_started",
    properties: {
      // Set by the desktop app when this Mac user can't write Cloudroom.app.
      update_needs_password: process.env.BB_DESKTOP_UPDATE_NEEDS_PASSWORD === "1",
    },
  });

  startSetupTelemetry({ telemetry, config: runtimeConfig, logger, db, sandboxes: cloud.sandboxes, telemetryAllowed: serverConfig.BB_TELEMETRY });

  pluginService.bindSdk({
    baseUrl: `http://127.0.0.1:${serverConfig.BB_SERVER_PORT}`,
  });
  void pluginService
    .start()
    .catch((error: unknown) => {
      logger.error({ err: error }, "Plugin startup failed");
    })
    .finally(() => {
      providerRegistry.markRegistrationsSettled();
      pluginService.startPeriodicUpdateChecks();
      startOrgPlugin({ sandboxes: cloud.sandboxes, plugins: pluginService, logger });
    });
  pluginCatalogService.startPeriodicRefresh();

  const sweepInterval = setInterval(() => {
    void runPeriodicSweeps(sweepDeps);
  }, 10_000);
  sweepInterval.unref();
  const providerAutoUpdateFirstRun = setTimeout(() => {
    void runProviderAutoUpdates(sweepDeps);
  }, PROVIDER_AUTO_UPDATE_FIRST_RUN_MS);
  providerAutoUpdateFirstRun.unref();
  const providerAutoUpdateInterval = setInterval(() => {
    void runProviderAutoUpdates(sweepDeps);
  }, PROVIDER_AUTO_UPDATE_INTERVAL_MS);
  providerAutoUpdateInterval.unref();

  let shutdownPromise: Promise<void> | null = null;
  const runShutdown = (): Promise<void> => {
    if (shutdownPromise) {
      return shutdownPromise;
    }
    shutdownPromise = (async () => {
      providerModelCatalogPrewarm.stop();
      eventLoopStallMonitor.stop();
      cloud.stop();
      stopFirstResponseTelemetry();
      stopAuthFailureTelemetry();
      stopTitleRecheck();
      stopThreadPurpose();
      clearInterval(sweepInterval);
      clearTimeout(providerAutoUpdateFirstRun);
      clearInterval(providerAutoUpdateInterval);
      pluginCatalogService.stopPeriodicRefresh();
      await pluginService.stopPeriodicUpdateChecks();
      await pluginService.stop().catch((error: unknown) => {
        logger.warn({ err: error }, "Plugin shutdown failed");
      });
      const closeServer = new Promise<void>((resolve, reject) => {
        server.close((error) => {
          if (error) {
            reject(error);
            return;
          }
          resolve();
        });
      });
      await closeWebSockets();
      await closeServer;
    })();
    return shutdownPromise;
  };

  process.on("uncaughtException", (error: unknown) => {
    if (pluginService.handleUncaughtException(error)) return;
    const message =
      error instanceof Error ? (error.stack ?? error.message) : String(error);
    process.stderr.write(`${message}\n`);
    process.exit(1);
  });

  process.once("SIGINT", () => {
    void runShutdown().finally(() => process.exit(0));
  });
  process.once("SIGTERM", () => {
    void runShutdown().finally(() => process.exit(0));
  });
}
