import { COMPUTER } from "@cloudroom/domain";
import type { Hono, MiddlewareHandler } from "hono";
import type { AppDeps } from "../../types.js";
import { ApiError } from "../../errors.js";
import { getThread, getThreadSectionById } from "@cloudroom/db";
import { z } from "zod";
import { threadGoalSetRequestSchema, updateThreadRequestSchema } from "@cloudroom/server-contract";
import { cloudGitThreadId } from "@cloudroom/domain";
import { cloudGitResponse } from "./git.js";
import { cloudroom, isCloudThread } from "./commands.js";
import { cloudroomAccount } from "./account.js";
import { checkPreviewsNow, macAccess, macAccessLevels, setMacAccess } from "./previews.js";
import { cloudSkills, copyLogins, setCloudSkills, setCopyLogins, skillInCloud } from "./sync.js";
import { secondsSinceFirstLaunch } from "./setup-telemetry.js";
import { teleports } from "./teleport.js";
import { binding, teleportBlocked, teleportProgress } from "./store.js";
import { browserRequestProblem } from "../../browser-request-guard.js";
import { cancelClaudeToken, claudePlan, ensureClaudeCli, isClaudeApiKey, startClaudeToken, withClaudeTokenRun } from "./claude-token.js";
import { startClaudeVersionSync } from "./harness-versions.js";
import { macSignedInAgents } from "./mac-agents.js";
import { autoDeleteDaysSchema, readAutoDelete, saveAutoDelete, startAutoDeleteSync } from "./auto-delete.js";
import { importBbThreads } from "./bb-import.js";
import { importNativeSessions, listNativeSessions } from "./session-import.js";
import { exportableChats, exportChats } from "./chat-export.js";
import { copyToMac, openOnMac, teleportingToLocal, teleportToLocal } from "./teleport-local.js";
import { cloudEnvironmentRequestSchema, macCodexLogin, macMcpServers, macSkills, macVariables, sandboxThread, startMacCodexLogin, type CloudEnvironmentRequest } from "./sandboxes.js";
import { CloudroomError } from "./client.js";
import { tokenUsageSince } from "./loop-usage.js";
import { macClis } from "./clis.js";
import { finishMcpSignIn, isRemoteMcp, startMcpSignIn } from "./mcp-login.js";
import { archiveThreadAndChildren } from "../threads/thread-archive.js";
import { assertValidParentThread } from "../threads/thread-parent.js";
import { queueChildThreadTurnNotificationBestEffort } from "../threads/child-thread-notifications.js";
import { reportBug } from "./bug-reports.js";
import { continueShare, shareThread, stopSharing, threadShare } from "./shares.js";
import { connectAccount, registerConnect } from "./connect-relay.js";
import { getGateAuthKind } from "../../request-context.js";
import { noteActiveMinute, timeInApp } from "./time-in-app.js";
import { activation } from "./activation.js";
import { disconnectGithub, githubAccount, githubAuth } from "./github-login.js";
import { addGithubRepo, githubBranches, repoSuggestions } from "./repo-suggestions.js";
import { ACTIVATION_STEPS, SETUP_ACTIONS, SETUP_AGENTS, SETUP_DETAILS, SETUP_STEPS, STARTER_PROMPTS, UPGRADE_PROMPTS } from "../system/telemetry.js";

const SAFE_SETTINGS_SEARCH = /^(?=.{2,40}$)\p{L}+(?: \p{L}+){0,3}$/u;

export function installCloudroomRoutes(app: Hono, deps: AppDeps): void {
  cloudroom(deps).teleportRecovery = () => teleports(deps).recover();
  cloudroom(deps).archiveRequest = (threadId) => {
    const thread = getThread(deps.db, threadId);
    if (!thread || thread.archivedAt || thread.deletedAt) return;
    try { archiveThreadAndChildren(deps, { parentThread: thread }); }
    catch (error) { deps.logger.warn({ error, threadId }, "Cloud self-archive failed"); }
  };
  cloudroom(deps).childTurnEnded = (child, turnStatus) => void queueChildThreadTurnNotificationBestEffort(deps, { childThread: child, parentThreadId: child.parentThreadId, turnStatus });
  startClaudeVersionSync(deps, () => cloudroom(deps).teleportClient());
  startAutoDeleteSync(deps);
  const localOnly: MiddlewareHandler = async (context, next) => {
    const problem = browserRequestProblem(context, deps, { requireJsonForMutation: true });
    if (problem) return context.json({ message: "Use the local Cloudroom app or CLI." }, problem.status);
    return next();
  };
  app.use("/api/v1/environments/:id/*", async (context, next) => {
    const threadId = cloudGitThreadId(context.req.param("id"));
    if (!threadId) return next();
    const problem = browserRequestProblem(context, deps);
    if (problem) throw new ApiError(problem.status, "forbidden_origin", problem.error);
    return context.json(await cloudGitResponse(deps, threadId, context, (script, stdin) => cloudroom(deps).runInCheckout(threadId, script, stdin, context.req.raw.signal)));
  });
  app.use("/api/v1/cloudroom", localOnly);
  app.use("/api/v1/cloudroom/*", localOnly);
  app.get("/api/v1/cloudroom/threads/:id/teleport", context => context.json(teleportProgress(deps.db, context.req.param("id"))));
  app.post("/api/v1/cloudroom/threads/:id/teleport", async context => {
    const problem = browserRequestProblem(context, deps, { requireJsonForMutation: true });
    if (problem) return context.json({ message: "Use the local Cloudroom app or CLI." }, problem.status);
    const body = z.object({ action: z.enum(["start", "cancel", "local", "copy", "move", "check"]).default("start"), model: z.string().min(1).optional(), reasoning: z.string().min(1).optional() }).strict().parse(await context.req.json());
    const id = context.req.param("id");
    if (body.action === "cancel") { await teleports(deps).cancel(id); return context.json(teleportProgress(deps.db, id), 202); }
    if (body.action === "local") return context.json(await teleportToLocal(deps, id));
    if (body.action === "copy") return context.json(await copyToMac(deps, id));
    const choice = body.model && body.reasoning ? { model: body.model, reasoning: body.reasoning } : undefined;
    if (body.action === "move") return context.json(await moveToSandbox(deps, id, choice), 202);
    if (body.action === "check") return context.json(await teleports(deps).check(id, choice));
    return context.json(await teleports(deps).begin(id, choice), 202);
  });
  app.get("/api/v1/cloudroom/threads/:id/share", async context => context.json(await threadShare(deps, context.req.param("id"))));
  app.post("/api/v1/cloudroom/threads/:id/share", async context => {
    const { action } = z.object({ action: z.enum(["save", "stop"]) }).strict().parse(await context.req.json());
    const id = context.req.param("id");
    if (action === "save") return context.json(await shareThread(deps, id));
    await stopSharing(deps, id);
    return context.json(null);
  });
  app.get("/api/v1/cloudroom/connect", async context => context.json(await connectAccount(deps)));
  app.post("/api/v1/cloudroom/connect", async context => {
    if (getGateAuthKind(context) !== null) return context.json({ message: `Register from the ${COMPUTER}, not remotely.` }, 403);
    return context.json(await registerConnect(deps));
  });
  app.post("/api/v1/cloudroom/shares/continue", async context => {
    const { link } = z.object({ link: z.string().trim().min(1).max(500) }).strict().parse(await context.req.json());
    return context.json(await continueShare(deps, link));
  });
  app.post("/api/v1/cloudroom/threads/:id/open-file", async context => {
    const input = z.object({ path: z.string().regex(/^\/[^\0]*$/).max(4096) }).strict().parse(await context.req.json());
    return context.json(await openOnMac(deps, context.req.param("id"), input.path));
  });
  app.post("/api/v1/cloudroom/import/bb", async context => {
    const problem = browserRequestProblem(context, deps, { requireJsonForMutation: true });
    if (problem) return context.json({ message: "Use the local Cloudroom app or CLI." }, problem.status);
    const input = z.object({ hostId: z.string().min(1) }).strict().parse(await context.req.json());
    return context.json(await importBbThreads(deps, input.hostId));
  });
  app.get("/api/v1/cloudroom/import/sessions", async context => context.json({ sessions: await listNativeSessions(deps) }));
  app.post("/api/v1/cloudroom/import/sessions", async context => {
    const input = z.object({
      hostId: z.string().min(1),
      sessions: z.array(z.object({ harness: z.enum(["claude-code", "codex", "pi", "acp-hermes-agent", "t3code"]), id: z.string().min(1) }).strict()).min(1).max(2000),
    }).strict().parse(await context.req.json());
    return context.json(await importNativeSessions(deps, input.hostId, input.sessions));
  });
  app.get("/api/v1/cloudroom/export", context => context.json({ threads: exportableChats(deps) }));
  app.post("/api/v1/cloudroom/export", async context => {
    const input = z.object({
      scope: z.enum(["all", "local", "cloud"]),
      days: z.number().int().positive().nullable(),
      format: z.enum(["markdown", "json"]),
    }).strict().parse(await context.req.json());
    return context.json(await exportChats(deps, input));
  });
  app.post("/api/v1/cloudroom/account/project", async (context) => {
    const input = z.object({ projectId: z.string().min(1) }).strict().parse(await context.req.json());
    await cloudroom(deps).selectOnboardingProject(input.projectId);
    void cloudroom(deps).warmSandbox(input.projectId).catch(() => {});
    return context.json({ ok: true });
  });
  app.get("/api/v1/cloudroom/account", async (context) => context.json(await cloudroomAccount(deps).status()));
  app.post("/api/v1/cloudroom/account/activity", async (context) => {
    z.object({}).strict().parse(await context.req.json());
    await cloudroom(deps).noteActivity();
    return context.json({ ok: true });
  });
  app.get("/api/v1/cloudroom/activation", async (context) => context.json(await activation(deps)));
  app.post("/api/v1/cloudroom/activation", async (context) => {
    const body = await context.req.json().catch(() => null);
    const starter = z.object({ starter: z.enum(STARTER_PROMPTS) }).strict().safeParse(body);
    if (starter.success) {
      deps.telemetry.capture({ name: "starter_prompt", properties: starter.data });
      return context.json({ ok: true });
    }
    const parsed = z.object({ step: z.enum(ACTIVATION_STEPS), action: z.enum(["clicked", "hidden"]).default("clicked") }).strict().safeParse(body);
    if (!parsed.success) throw new ApiError(400, "invalid_activation_step", "Invalid checklist step.");
    deps.telemetry.capture({ name: "activation_step", properties: parsed.data });
    return context.json({ ok: true });
  });
  app.get("/api/v1/cloudroom/time-in-app", async (context) => {
    return context.json(await timeInApp(deps));
  });
  app.post("/api/v1/cloudroom/time-in-app", async (context) => {
    z.object({}).strict().parse(await context.req.json());
    await noteActiveMinute(deps);
    return context.json({ ok: true });
  });
  let desktopUpdate: { version: string; installAt: number | null; seenAt: number; install: boolean } | null = null;
  app.post("/api/v1/cloudroom/desktop-update", async (context) => {
    const input = z.object({ version: z.string().min(1).max(40), installAt: z.number().nullable() }).strict().parse(await context.req.json());
    const install = desktopUpdate?.version === input.version && desktopUpdate.install;
    desktopUpdate = { ...input, seenAt: Date.now(), install };
    return context.json({ install });
  });
  app.get("/api/v1/cloudroom/desktop-update", (context) =>
    context.json(desktopUpdate && Date.now() - desktopUpdate.seenAt < 60_000
      ? { version: desktopUpdate.version, installAt: desktopUpdate.installAt, installing: desktopUpdate.install }
      : null));
  app.post("/api/v1/cloudroom/desktop-update/install", async (context) => {
    z.object({}).strict().parse(await context.req.json());
    if (!desktopUpdate) throw new ApiError(409, "no_desktop_update", "No downloaded update to install.");
    desktopUpdate.install = true;
    return context.json({ ok: true }, 202);
  });
  app.post("/api/v1/cloudroom/setup-step", async (context) => {
    const parsed = z.object({ step: z.enum(SETUP_STEPS), action: z.enum(SETUP_ACTIONS), detail: z.enum(SETUP_DETAILS).nullable().default(null), agents: z.array(z.enum(SETUP_AGENTS)).max(SETUP_AGENTS.length).optional() }).strict().safeParse(await context.req.json().catch(() => null));
    if (!parsed.success) throw new ApiError(400, "invalid_setup_step", "Invalid setup step.");
    const { agents, ...step } = parsed.data;
    const choices = step.step === "agent" && step.action === "done" ? { copy_logins: await copyLogins(deps), mac_access: await macAccess(deps) } : {};
    deps.telemetry.capture({ name: "setup_step", properties: { ...step, ...(agents ? { agents: agents.join(",") } : {}), ...choices, seconds_since_first_launch: secondsSinceFirstLaunch() } });
    return context.json({ ok: true });
  });
  app.post("/api/v1/cloudroom/settings-search-miss", async (context) => {
    const parsed = z.object({ query: z.string().max(200) }).strict().safeParse(await context.req.json().catch(() => null));
    if (!parsed.success) throw new ApiError(400, "invalid_settings_search", "Invalid settings search.");
    const query = parsed.data.query.trim().toLowerCase().replace(/\s+/g, " ");
    if (SAFE_SETTINGS_SEARCH.test(query)) deps.telemetry.capture({ name: "settings_search_no_results", properties: { query } });
    return context.json({ ok: true });
  });
  app.post("/api/v1/cloudroom/bug-report-clicked", (context) => {
    deps.telemetry.capture({ name: "bug_report_clicked" });
    return context.json({ ok: true });
  });
  const viewedUpgradePrompts = new Set<string>();
  app.post("/api/v1/cloudroom/upgrade-prompt", async (context) => {
    const parsed = z.object({ where: z.enum(UPGRADE_PROMPTS), action: z.enum(["viewed", "clicked"]) }).strict().safeParse(await context.req.json().catch(() => null));
    if (!parsed.success) throw new ApiError(400, "invalid_upgrade_prompt", "Invalid upgrade prompt.");
    if (parsed.data.action === "clicked" || !viewedUpgradePrompts.has(parsed.data.where)) {
      if (parsed.data.action === "viewed") viewedUpgradePrompts.add(parsed.data.where);
      deps.telemetry.capture({ name: "upgrade_prompt", properties: parsed.data });
    }
    return context.json({ ok: true });
  });
  app.post("/api/v1/cloudroom/bug-reports", async (context) => {
    const input = z.object({ message: z.string().trim().min(1).max(4000), threadId: z.string().min(1).max(200).optional() }).strict().parse(await context.req.json());
    return context.json(await reportBug(deps, input));
  });
  app.get("/api/v1/cloudroom/account/invites", async (context) => context.json(await cloudroom(deps).sandboxes.invites("list")));
  app.post("/api/v1/cloudroom/account/invites", async (context) => {
    z.object({}).strict().parse(await context.req.json());
    return context.json(await cloudroom(deps).sandboxes.invites("create"));
  });
  app.post("/api/v1/cloudroom/account/more-usage", async (context) => {
    z.object({}).strict().parse(await context.req.json());
    return context.json(await cloudroom(deps).sandboxes.requestMoreUsage().catch((error: unknown) => {
      throw new ApiError(503, "cloud_usage_request", error instanceof Error ? error.message : String(error));
    }));
  });
  app.post("/api/v1/cloudroom/account/mac-access", async (context) => {
    const input = z.union([z.object({ level: z.enum(macAccessLevels) }).strict(), z.object({ enabled: z.boolean() }).strict()]).parse(await context.req.json());
    await setMacAccess(deps, "level" in input ? input.level : input.enabled ? "full" : "off");
    return context.json({ ok: true });
  });
  // The website's own message (say, an invalid key) reaches the user instead of "Internal server error".
  const environment = (request: CloudEnvironmentRequest) => cloudroom(deps).sandboxes.environment(request).catch((error: unknown) => {
    throw new ApiError(error instanceof CloudroomError && error.status ? 400 : 503, "cloud_environment", error instanceof Error ? error.message : String(error));
  });
  // Cloud environment settings live on the website, so the app and the dashboard always show the same values.
  app.get("/api/v1/cloudroom/account/environment", async (context) => context.json(await environment({ action: "get" })));
  app.post("/api/v1/cloudroom/account/environment", async (context) => context.json(await environment(cloudEnvironmentRequestSchema.parse(await context.req.json()))));
  const autoDelete = <T>(work: Promise<T>) => work.catch((error: unknown) => {
    throw new ApiError(error instanceof CloudroomError && error.status ? 400 : 503, "cloud_auto_delete", error instanceof Error ? error.message : String(error));
  });
  app.get("/api/v1/cloudroom/account/auto-delete", async (context) => context.json(await autoDelete(readAutoDelete(deps))));
  app.post("/api/v1/cloudroom/account/auto-delete", async (context) => {
    const { days } = z.object({ days: autoDeleteDaysSchema }).strict().parse(await context.req.json());
    return context.json(await autoDelete(saveAutoDelete(deps, days)));
  });
  // Cloud automations (ADR 0212): the website stores and runs them, so they keep running while this Mac is off.
  // A child Cloud thread shares its parent's sandbox, so the website gets the parent and the child's own session.
  app.post("/api/v1/cloudroom/account/automations", async (context) => {
    const input = z.object({ action: z.enum(["list", "create", "update", "run", "runs", "history", "delete", "hook", "unhook", "events", "ack", "settings", "report"]), thread: z.string().min(1).max(64).optional() }).passthrough().parse(await context.req.json());
    let body: Record<string, unknown> = input;
    if (input.action === "create") {
      const thread = input.thread ? getThread(deps.db, input.thread) : null;
      if (!thread || !isCloudThread(thread) || thread.archivedAt || thread.deletedAt) throw new ApiError(400, "cloud_automation", "Cloud automations need an open Cloud thread.");
      let root = thread;
      for (let parent = root.parentThreadId ? getThread(deps.db, root.parentThreadId) : null; parent && isCloudThread(parent); parent = parent.parentThreadId ? getThread(deps.db, parent.parentThreadId) : null) root = parent;
      const session = binding(deps.db, thread.id)?.sessionId;
      body = { ...input, thread: root.id, ...(session ? { session } : {}) };
    }
    return context.json(await cloudroom(deps).sandboxes.automations(body).catch((error: unknown) => {
      const status = error instanceof CloudroomError ? error.status : null;
      throw new ApiError(status === 404 || status === 429 ? status : status ? 400 : 503, "cloud_automation", error instanceof Error ? error.message : String(error));
    }));
  });
  // Loop usage estimates (docs/scopes/loops.md): tokens the Loops plugin's runs used, and all of the provider's.
  app.post("/api/v1/cloudroom/account/token-usage", async (context) => {
    const input = z.object({ providerId: z.string().min(1).max(100), threadIds: z.array(z.string().min(1).max(64)).max(500), threadsSince: z.number().int().nonnegative(), totalSince: z.number().int().nonnegative() }).parse(await context.req.json());
    return context.json(tokenUsageSince(deps.db, input));
  });
  // Organizations (docs/scopes/organizations.md): the Organization plugin's requests, passed to the website as this account.
  app.post("/api/v1/cloudroom/account/org", async (context) => {
    const body = z.object({ action: z.string().min(1).max(40) }).passthrough().parse(await context.req.json());
    return context.json(await cloudroom(deps).sandboxes.org(body).catch((error: unknown) => {
      const status = error instanceof CloudroomError ? error.status : null;
      throw new ApiError(status === 403 || status === 404 || status === 409 ? status : status ? 400 : 503, "cloud_org", error instanceof Error ? error.message : String(error));
    }) as Record<string, unknown>);
  });
  // Import from this Mac: the list shows names only, and values go straight to the website.
  app.get("/api/v1/cloudroom/account/environment/mac", async (context) => context.json({ names: Object.keys(await macVariables()).sort() }));
  app.post("/api/v1/cloudroom/account/environment/mac", async (context) => {
    const { names } = z.object({ names: z.array(z.string()).min(1).max(100) }).strict().parse(await context.req.json());
    const found = await macVariables();
    const variables = Object.fromEntries(names.flatMap(name => found[name] ? [[name, found[name]]] : []));
    if (!Object.keys(variables).length) throw new ApiError(404, "mac_variables_missing", `Those variables are no longer set in your shell on this ${COMPUTER}.`);
    return context.json(await environment({ action: "set", variables }));
  });
  // Skills from this Mac that every new cloud thread gets. A change saves at once; the upload runs in the background.
  const skillList = async () => {
    const choice = await cloudSkills(deps);
    const inCloud = skillInCloud(choice);
    const skills = (await macSkills()).map(({ name, description }) => ({ name, description, cloud: inCloud(name) }));
    return { auto: choice.auto, skills, issue: cloudroom(deps).sandboxes.configIssue };
  };
  let skillChange = Promise.resolve();
  app.get("/api/v1/cloudroom/account/skills", async (context) => context.json(await skillList()));
  app.post("/api/v1/cloudroom/account/skills", async (context) => {
    const input = z.union([
      z.object({ names: z.array(z.string().min(1)).min(1).max(1000), cloud: z.boolean() }).strict(),
      z.object({ auto: z.boolean() }).strict(),
    ]).parse(await context.req.json());
    // One change at a time, so quick clicks never overwrite each other.
    const change = skillChange.then(async () => {
      const choice = await cloudSkills(deps);
      if ("auto" in input) {
        // Skills already on this Mac keep their place; only skills added later follow the new setting.
        const inCloud = skillInCloud(choice);
        for (const { name } of await macSkills()) choice.chosen[name] = inCloud(name);
        choice.auto = input.auto;
      } else for (const name of input.names) choice.chosen[name] = input.cloud;
      await setCloudSkills(deps, choice);
      void cloudroom(deps).sandboxes.copyMacConfig(skillInCloud(choice), true).catch((error: unknown) => deps.logger.warn({ error }, "Skills could not be copied to cloud sandboxes"));
    });
    skillChange = change.catch(() => {});
    await change;
    return context.json(await skillList());
  });
  // CLIs on this Mac that Cloudroom knows how to install in a sandbox. The app adds them to the setup script.
  app.get("/api/v1/cloudroom/account/clis", (context) => context.json({ clis: macClis() }));
  // MCP servers from this Mac. The Cloud environment answer says which are in the cloud; their keys go straight to the website.
  // `signIn` marks cloud servers that use OAuth: "needed" until the user signs in once for the cloud, then "done".
  app.get("/api/v1/cloudroom/account/mcp", async (context) => {
    const servers = await macMcpServers();
    const signIns = await cloudroom(deps).sandboxes.mcpSignIns(servers).catch((): Record<string, "needed" | "done"> => ({}));
    return context.json({ servers: servers.map(({ name, server }) => ({ name, macOnly: !server, ...(signIns[name] ? { signIn: signIns[name] } : {}) })) });
  });
  // The browser sign-in returns to this Mac; the tokens go straight to the website and never reach the app.
  app.post("/api/v1/cloudroom/account/mcp/sign-in", async (context) => {
    const { name } = z.object({ name: z.string().min(1) }).strict().parse(await context.req.json());
    const account = await cloudroom(deps).sandboxes.account();
    if (!account) throw new ApiError(409, "cloud_mcp", "Sign in to Cloudroom first.");
    const server = (await macMcpServers()).find(entry => entry.name === name)?.server ?? null;
    if (!isRemoteMcp(server)) throw new ApiError(400, "cloud_mcp", `${name} doesn't use a sign-in Cloudroom can do.`);
    const redirect = `${new URL(context.req.url).origin}/api/v1/cloudroom/account/mcp/callback`;
    return context.json({ url: await startMcpSignIn(name, server, redirect, account).catch((error: unknown) => {
      throw new ApiError(error instanceof CloudroomError && error.status ? 400 : 503, "cloud_mcp", error instanceof Error ? error.message : String(error));
    }) });
  });
  app.get("/api/v1/cloudroom/account/mcp/callback", async (context) => {
    const escape = (text: string) => text.replace(/[&<>"']/g, char => `&#${char.charCodeAt(0)};`);
    const page = (title: string, detail: string) => context.html(`<!doctype html><meta charset="utf-8"><title>${escape(title)}</title><body style="font:15px system-ui;margin:15vh auto;max-width:28rem;padding:0 1rem;text-align:center"><h1 style="font-size:20px">${escape(title)}</h1><p>${escape(detail)}</p></body>`);
    try {
      const sandboxes = cloudroom(deps).sandboxes;
      const { name, server, signIn, account } = await finishMcpSignIn(new URL(context.req.url).searchParams, await sandboxes.account());
      await sandboxes.saveMcpSignIn(name, server, signIn, account);
      return page(`Signed in to ${name}`, "Every cloud thread can use it now. You can close this tab.");
    } catch (error) {
      deps.logger.warn({ error: error instanceof Error ? error.message : String(error) }, "Cloud MCP sign-in failed");
      return page("Sign-in didn't finish", `${error instanceof Error ? error.message : String(error)} Try again in Cloudroom.`);
    }
  });
  app.post("/api/v1/cloudroom/account/mcp", async (context) => {
    const { names, cloud } = z.object({ names: z.array(z.string().min(1)).min(1).max(50), cloud: z.boolean() }).strict().parse(await context.req.json());
    return context.json(await cloudroom(deps).sandboxes.setMacMcp(names, cloud).catch((error: unknown) => {
      throw new ApiError(error instanceof CloudroomError && error.status ? 400 : 503, "cloud_mcp", error instanceof Error ? error.message : String(error));
    }));
  });
  app.post("/api/v1/cloudroom/account/copy-logins", async (context) => {
    const input = z.object({ enabled: z.boolean() }).strict().parse(await context.req.json());
    await setCopyLogins(deps, input.enabled);
    return context.json({ ok: true });
  });
  app.post("/api/v1/cloudroom/vm/run", async (context) => {
    const problem = browserRequestProblem(context, deps, { requireJsonForMutation: true });
    if (problem) return context.json({ message: "Use the local Cloudroom app or CLI." }, problem.status);
    const { threadId, ...input } = z.object({ command: z.string().min(1).max(65536), stdin: z.string().max(32 * 1024 * 1024).regex(/^(?:[0-9a-f]{2})*$/).optional(), cwd: z.string().min(1).max(4096).optional(), threadId: z.string().min(1).max(200).optional() }).strict().parse(await context.req.json());
    return context.json(await cloudroom(deps).runOnVm(input, threadId, context.req.raw.signal));
  });
  const claudeStatus = async () => withClaudeTokenRun(await cloudroom(deps).claudeAuth());
  app.get("/api/v1/cloudroom/account/claude", async context => context.json(await claudeStatus()));
  app.post("/api/v1/cloudroom/account/claude/setup-token", async context => {
    const problem = browserRequestProblem(context, deps, { requireJsonForMutation: true });
    if (problem) return context.json({ message: "Use the local Cloudroom app." }, problem.status);
    const { requestId } = z.object({ requestId: z.string().regex(/^[a-zA-Z0-9_-]{1,64}$/) }).strict().parse(await context.req.json());
    await ensureClaudeCli((error) => deps.logger.warn({ error }, "Claude Code could not be installed in the background"));
    await startClaudeToken(requestId, async token => cloudroom(deps).claudeAuth("token", requestId, token, await claudePlan()), deps);
    return context.json(await claudeStatus());
  });
  // The Accounts plugin saves the account in use as the Cloud login (ADR 0197).
  app.post("/api/v1/cloudroom/account/claude/token", async context => {
    const problem = browserRequestProblem(context, deps, { requireJsonForMutation: true });
    if (problem) return context.json({ message: "Use the local Cloudroom app." }, problem.status);
    const input = z.object({ requestId: z.string().regex(/^[a-zA-Z0-9_-]{1,64}$/), token: z.string().regex(/^sk-ant-oat[A-Za-z0-9_-]{20,}$/), plan: z.string().regex(/^[a-z_]{1,32}$/).optional() }).strict().parse(await context.req.json());
    const status = await cloudroom(deps).claudeAuth("token", input.requestId, input.token, input.plan);
    cloudroom(deps).restartAwake("claude-code");
    return context.json(status);
  });
  app.post("/api/v1/cloudroom/account/claude/key", async context => {
    const parsed = z.object({ requestId: z.string().regex(/^[a-zA-Z0-9_-]{1,64}$/), apiKey: z.string().refine(isClaudeApiKey) }).strict().safeParse(await context.req.json().catch(() => null));
    if (!parsed.success) throw new ApiError(400, "invalid_claude_key", "Paste an Anthropic API key from the Claude Console. It starts with sk-ant-.");
    return context.json(await cloudroom(deps).claudeAuth("key", parsed.data.requestId, parsed.data.apiKey));
  });
  for (const action of ["login", "cancel", "complete"] as const) {
    app.post(`/api/v1/cloudroom/account/claude/${action}`, async context => {
      const input = z.object({ requestId: z.string().regex(/^[a-zA-Z0-9_-]{1,64}$/), ...(action === "complete" ? { code: z.string().min(1).max(2048), state: z.string().min(1).max(512) } : {}) }).strict().parse(await context.req.json());
      if (action === "cancel" && cancelClaudeToken()) return context.json(await claudeStatus());
      return context.json(await cloudroom(deps).claudeAuth(action, input.requestId, "code" in input ? String(input.code) : undefined, "state" in input ? String(input.state) : undefined));
    });
  }
  app.get("/api/v1/cloudroom/account/cursor", async context => context.json(await cloudroom(deps).cursorAuth()));
  for (const action of ["login", "cancel", "key"] as const) {
    app.post(`/api/v1/cloudroom/account/cursor/${action}`, async context => {
      const schema = z.object({ requestId: z.string().regex(/^[a-zA-Z0-9_-]{1,64}$/), ...(action === "key" ? { apiKey: z.string().min(1).max(4096).regex(/^[!-~]+$/) } : {}) }).strict();
      const parsed = schema.safeParse(await context.req.json().catch(() => null));
      if (!parsed.success) throw new ApiError(400, "invalid_cursor_auth", "Invalid Cursor account request.");
      const input = parsed.data;
      return context.json(await cloudroom(deps).cursorAuth(action, input.requestId, "apiKey" in input ? String(input.apiKey) : undefined));
    });
  }
  app.post("/api/v1/cloudroom/account/pi/key", async context => {
    const parsed = z.object({ provider: z.string().regex(/^[A-Za-z0-9._-]{1,64}$/), apiKey: z.string().min(1).max(8192).regex(/^[!-~]+$/) }).strict().safeParse(await context.req.json().catch(() => null));
    if (!parsed.success) throw new ApiError(400, "invalid_pi_auth", "Invalid Pi key request.");
    return context.json(await cloudroom(deps).piApiKey(parsed.data.provider, parsed.data.apiKey));
  });
  app.get("/api/v1/cloudroom/account/codex", async context => context.json(await cloudroom(deps).codexAuth()));
  // The Accounts plugin's Codex accounts (ADR 0195). Responses never hold tokens.
  app.post("/api/v1/cloudroom/account/codex-accounts", async context => {
    const problem = browserRequestProblem(context, deps, { requireJsonForMutation: true });
    if (problem) return context.json({ message: "Use the local Cloudroom app." }, problem.status);
    const id = z.string().min(1).max(100);
    const parsed = z.discriminatedUnion("action", [
      z.object({ action: z.enum(["list", "start"]) }).strict(),
      z.object({ action: z.literal("poll"), sessionId: id }).strict(),
      z.object({ action: z.literal("use"), id: id.nullable() }).strict(),
      z.object({ action: z.literal("remove"), id }).strict(),
      z.object({ action: z.literal("rename"), id, name: z.string().max(60) }).strict(),
      z.object({ action: z.literal("move"), id, direction: z.enum(["up", "down"]) }).strict(),
    ]).safeParse(await context.req.json().catch(() => null));
    if (!parsed.success) throw new ApiError(400, "invalid_codex_accounts", "Invalid Codex accounts request.");
    return context.json(await cloudroom(deps).codexAccounts.request(parsed.data));
  });
  for (const action of ["login", "cancel"] as const) {
    app.post(`/api/v1/cloudroom/account/codex/${action}`, async context => {
      const input = z.object({ requestId: z.string().regex(/^[a-zA-Z0-9_-]{1,64}$/) }).strict().parse(await context.req.json());
      return context.json(await cloudroom(deps).codexAuth(action, input.requestId));
    });
  }
  const macCodexStatus = (run: ReturnType<typeof macCodexLogin>) =>
    !run ? { state: "idle" as const } : !run.done ? { state: "waiting" as const } : run.error ? { state: "error" as const, message: run.error } : { state: "done" as const };
  app.post("/api/v1/cloudroom/mac/codex-login", context => context.json(macCodexStatus(startMacCodexLogin())));
  app.get("/api/v1/cloudroom/mac/codex-login", context => context.json(macCodexStatus(macCodexLogin())));
  app.get("/api/v1/cloudroom/mac/agents", async context => context.json({ agents: await macSignedInAgents() }));
  app.get("/api/v1/cloudroom/account/github", async context => context.json(await githubAuth(deps)));
  app.get("/api/v1/cloudroom/account/github/account", async context => context.json(await githubAccount(deps)));
  app.post("/api/v1/cloudroom/account/github/disconnect", async context => { await disconnectGithub(deps); return context.json({ ok: true }); });
  app.post("/api/v1/cloudroom/account/previews/check", async context => { await checkPreviewsNow(deps); return context.json({ ok: true }); });
  app.get("/api/v1/cloudroom/account/repo-suggestions", async context => context.json(await repoSuggestions(deps)));
  app.get("/api/v1/cloudroom/account/github-branches", async context => {
    const projectId = z.string().min(1).parse(context.req.query("project"));
    return context.json(await githubBranches(projectId, deps));
  });
  app.post("/api/v1/cloudroom/account/repo-suggestions/github", async context => {
    const input = z.object({ repo: z.string().regex(/^[\w.-]+\/[\w.-]+$/) }).strict().parse(await context.req.json());
    return context.json(await addGithubRepo(deps, input.repo));
  });
  for (const action of ["login", "cancel"] as const) {
    app.post(`/api/v1/cloudroom/account/github/${action}`, async context => {
      const input = z.object({ requestId: z.string().regex(/^[a-zA-Z0-9_-]{1,64}$/) }).strict().parse(await context.req.json());
      return context.json(await githubAuth(deps, action, input.requestId));
    });
  }
  app.post("/api/v1/cloudroom/account/sign-in", async (context) => context.json(await cloudroomAccount(deps).signIn(await context.req.json())));
  app.post("/api/v1/cloudroom/account/cancel", (context) => { cloudroomAccount(deps).cancel(); return context.json({ ok: true }); });
  app.post("/api/v1/cloudroom/account/logout", async (context) => { await cloudroomAccount(deps).logout(); return context.json({ ok: true }); });
  app.get("/api/v1/cloudroom", async (context) => context.json(await cloudroom(deps).status()));
  app.post("/api/v1/cloudroom", async (context) => {
    const problem = browserRequestProblem(context, deps, { requireJsonForMutation: true });
    if (problem) return context.json({ message: "Use the local Cloudroom app or CLI." }, problem.status);
    await cloudroom(deps).configure(await context.req.json());
    return context.json(await cloudroom(deps).status());
  });
  app.get("/api/v1/cloudroom/threads/:id", async (context) => {
    const id = context.req.param("id");
    const status = cloudroom(deps).threadStatus(id);
    const thread = getThread(deps.db, id);
    if (!status || !thread) return context.json(null);
    return context.json(status);
  });
  app.get("/api/v1/cloudroom/threads/:id/workspace", async (context) => context.json(await cloudroom(deps).threadWorkspace(context.req.param("id"), context.req.raw.signal)));
  app.post("/api/v1/cloudroom/threads/:id/retry-start", async (context) => {
    const problem = browserRequestProblem(context, deps, { requireJsonForMutation: true });
    if (problem) return context.json({ message: "Use the local Cloudroom app or CLI." }, problem.status);
    await cloudroom(deps).retryStart(context.req.param("id"));
    return context.json({ ok: true });
  });
  app.post("/api/v1/cloudroom/threads/:id/retry-copy", async (context) => {
    await cloudroom(deps).retryCopy(context.req.param("id"));
    return context.json({ ok: true });
  });
  app.post("/api/v1/cloudroom/threads/:id/wake", async (context) => {
    const { reason } = await context.req.json<{ reason?: unknown }>().catch(() => ({ reason: undefined }));
    void cloudroom(deps).wakeAhead(context.req.param("id"), reason === "view" ? "thread_view" : "thread_typing").catch(() => {});
    return context.json({ ok: true }, 202);
  });
  app.post("/api/v1/cloudroom/preload", async (context) => {
    const { threads } = await context.req.json<{ threads?: unknown }>().catch(() => ({ threads: undefined }));
    const ids = Array.isArray(threads) ? threads.filter((id): id is string => typeof id === "string").slice(0, 50) : [];
    if (ids.length) void cloudroom(deps).preload(ids).catch(() => {});
    return context.json({ ok: true }, 202);
  });
  const guard: MiddlewareHandler = async (context, next) => {
    if (["GET", "HEAD", "OPTIONS"].includes(context.req.method)) return next();
    // This runs before publicApi's browser guard, and the Cloud handlers below answer on their own, so check here too.
    const problem = browserRequestProblem(context, deps);
    if (problem) return context.json({ message: "Use the local Cloudroom app or CLI." }, problem.status);
    const id = context.req.param("id");
    if (!id) return next();
    const thread = getThread(deps.db, id);
    const toLocal = teleportingToLocal(id);
    if (toLocal || teleportBlocked(deps.db, id)) {
      // UI-only writes (tabs, read state, rename) never touch the conversation, so they pass during any Teleport.
      const suffix = context.req.path.slice(`/api/v1/threads/${id}`.length);
      const rename = context.req.method === "PATCH" && suffix === "" && await context.req.json<unknown>().then((body) => Boolean(body && typeof body === "object" && !Array.isArray(body) && Object.keys(body).join() === "title"), () => false);
      const uiOnly = rename || ["/read", "/unread", "/tabs"].includes(suffix);
      if (toLocal && !uiOnly) return context.json({ message: "Teleport to Local is in progress.", code: "teleport_in_progress" }, 409);
      if (!toLocal && !uiOnly && suffix !== "/archive-all" && !(suffix === "/stop" && teleportProgress(deps.db, id)?.cloudStarted)) return context.json({ message: "Teleport is in progress. Wait for completion, or use Cancel before cloud execution starts.", code: "teleport_in_progress" }, 409);
    }
    if (!thread || !isCloudThread(thread)) return next();
    const path = context.req.path.slice(`/api/v1/threads/${thread.id}`.length);
    if (context.req.method === "PATCH" && path === "") {
      const body = await context.req.json<unknown>();
      // A model or harness change switches the thread in place (ADR 0211); a new parent is saved to the website first.
      if (body && typeof body === "object" && !Array.isArray(body) && Object.keys(body).every((key) => ["title", "reasoningLevel", "model", "providerId", "parentThreadId", "sectionId"].includes(key))) {
        const parentId = (body as { parentThreadId?: unknown }).parentThreadId;
        if (parentId === undefined || parentId === thread.parentThreadId || thread.deletedAt || (parentId !== null && typeof parentId !== "string") || !updateThreadRequestSchema.safeParse(body).success) return next();
        if (["model", "providerId", "reasoningLevel"].some((key) => key in body)) return context.json({ message: "Change a Cloud thread's parent on its own, then change its model.", code: "cloudroom_parent_alone" }, 400);
        const sectionId = (body as { sectionId?: unknown }).sectionId;
        if (typeof sectionId === "string" && !getThreadSectionById(deps.db, sectionId)) throw new ApiError(404, "section_not_found", "Section not found");
        const saved = binding(deps.db, thread.id), newParent = typeof parentId === "string" ? binding(deps.db, parentId) : null;
        const sandbox = saved && sandboxThread(saved.coreUrl);
        const onVm = Boolean(saved && !sandbox);
        const ownSandbox = sandbox === thread.id;
        const sameCore = ownSandbox && parentId !== thread.id && newParent?.coreUrl === saved?.coreUrl;
        if (parentId === null ? !onVm : ownSandbox && !sameCore) {
          if (typeof parentId === "string") assertValidParentThread(deps, { childThreadId: thread.id, parentThreadId: parentId, cloudChild: true });
          for (const own of [saved, newParent]) if (own) await cloudroom(deps).requireOwnThread(own);
          await cloudroom(deps).changeParent(thread.id, parentId as string | null, () => next());
          return;
        }
        return context.json({ message: sameCore ? "A Cloud thread can't move under a thread that shares its sandbox." : onVm ? "A thread on your cloud VM can't change its parent." : `Only a Cloud thread in its own sandbox can ${thread.parentThreadId ? "move under another parent. Clear its parent (--clear-parent-thread) to make it top-level." : "get a parent."}`, code: "cloudroom_unsupported" }, 409);
      }
    }
    if (["/tabs", "/read", "/unread", "/pin", "/unpin", "/pin-order"].includes(path)) return next();
    if (context.req.method === "POST" && ["/archive-all", "/unarchive"].includes(path)) return next();
    if (context.req.method === "DELETE" && path === "") return next();
    if (context.req.method === "POST" && ["/send", "/queued-messages", "/stop", "/compact", "/edit-message", "/move", "/host-files/exist"].includes(path)) return next();
    if (context.req.method === "PATCH" && /^\/queued-messages\/[^/]+(\/order)?$/.test(path)) return next();
    if (context.req.method === "DELETE" && /^\/queued-messages\/[^/]+$/.test(path)) return next();
    if (context.req.method === "POST" && /^\/interactions\/[^/]+\/(respond|cancel)$/.test(path)) return next();
    if (context.req.method === "POST" && (path === "/goal" || path === "/goal/clear")) {
      const goal = path === "/goal" ? threadGoalSetRequestSchema.parse(await context.req.json()) : { clear: true };
      await cloudroom(deps).goal(thread, goal);
      return context.json({ ok: true });
    }
    if (context.req.method === "POST" && /^\/queued-messages\/[^/]+\/send$/.test(path)) {
      return context.json(await cloudroom(deps).sendQueued(thread, path.split("/")[2]!));
    }
    return context.json({ message: "This action is not enabled for Cloud threads. Native execution is blocked.", code: "cloudroom_unsupported" }, 409);
  };
  app.use("/api/v1/threads/:id/*", guard);
}

/** Moves a VM thread into its own sandbox (moving off the VM): Teleport to Local, then Teleport to Cloud, which picks a
 *  sandbox. The VM keeps its copy, so moving back only needs the account switch (docs/scopes/sandboxes.md). */
async function moveToSandbox(deps: AppDeps, threadId: string, choice?: { model: string; reasoning: string }) {
  const saved = binding(deps.db, threadId);
  if (!saved || sandboxThread(saved.coreUrl)) throw new ApiError(409, "cloudroom_move_unavailable", "Only a thread on your cloud VM can move to its own sandbox.");
  if (!await cloudroom(deps).newThreadsInSandboxes()) throw new ApiError(409, "cloudroom_move_unavailable", "Cloud sandboxes are off for this account.");
  await teleportToLocal(deps, threadId);
  return teleports(deps).begin(threadId, choice);
}
