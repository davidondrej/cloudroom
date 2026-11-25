import { randomUUID } from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import type { BbPluginApi } from "@get-bb/plugin-sdk";
import { z } from "zod";
import { COMPUTER_TITLE } from "@cloudroom/domain/computer-name";
import {
  ClaudeLogin,
  claudePlanName,
  claudeSecret,
  claudeUsage,
  type ClaudeUsage,
  localClaudeAccount,
  profileAccount,
  profilePlan,
  profileUsage,
  signOut,
  tokenOrganization,
  type MacClaude,
} from "./src/claude.js";
import {
  codexListSchema,
  codexPollSchema,
  codexStartSchema,
  localCodexEmail,
} from "./src/codex.js";
import {
  cursorAccount,
  cursorEnv,
  cursorSecretSchema,
  cursorUsage,
  isCursorKey,
  localCursorEmail,
} from "./src/cursor.js";
import {
  ACCOUNTS_CHANGED,
  LOCAL,
  MAX_ACCOUNTS,
  accountsRpcContract,
  providerSchema,
  usageWindowSchema,
  type AccountView,
  type Provider,
  type UsageWindow,
} from "./src/contract.js";
import {
  AGY_FILE_LOGIN,
  AGY_TOKEN,
  AntigravityLogin,
  agyUsage,
  isAgyCode,
  placeAgyLogin,
  readAgyLogin,
} from "./src/antigravity.js";
import { afterUsage, limitMark, limitMarkSchema } from "./src/limit-mark.js";
import { limitedThreads } from "./src/limited-threads.js";
import { accountTelemetry, errorCode, type AddKind } from "./src/telemetry.js";
import { prepareProfile, releaseProfile, startMcpSync } from "./src/profile.js";
import { SignInAgainError, type Secret, type SignedIn } from "./src/tokens.js";

const USAGE_EVERY_MS = 5 * 60_000;
// Accounts not in use are read every 12th check: hourly.
const IDLE_USAGE_TICKS = 12;
const MAC_NEEDS_CLOUD =
  "Approve this Mac's Claude account for Cloud first: click Use on it in Settings → Agents → Accounts.";
const LOGIN_FAILED =
  "This account's Claude login stopped working. Sign in again.";

const storedSchema = z.object({
  id: z.string(),
  provider: providerSchema,
  name: z.string().nullish(),
  email: z.string().nullable(),
  plan: z.string().nullable(),
  // Claude's plan tier, such as `max_20x`: it names Max and Ultra apart. Missing: saved before tiers were read.
  tier: z.string().nullish(),
  accountKey: z.string().nullable(),
  // The account's own Claude folder with its full login (claude.ai connectors); older accounts have only the one-year token.
  profile: z.string().nullish(),
  org: z.string().nullish(),
  createdAt: z.number(),
});
type Stored = z.infer<typeof storedSchema>;
// Providers whose accounts this Mac stores, in the order the user set. Codex accounts live on the website (ADR 0195).
type Ordered = "claude-code" | "acp-cursor" | "acp-antigravity";
const secretSchema = z.object({
  accessToken: z.string(),
  refreshToken: z.string(),
  expiresAt: z.number().nullable(),
  idToken: z.string().optional(),
  issuedAt: z.number().optional(),
});
type Adding = {
  login: string;
  // Missing for the Mac's own login, which only needs Cloud's one-year token.
  profile?: string;
  replace: string | null;
  mac: boolean;
  account?: Awaited<ReturnType<typeof profileAccount>>;
  url?: string;
  busy?: boolean;
  // For telemetry: which add this is, and when it started.
  kind: AddKind;
  startedAt: number;
};
type Usage = {
  windows: UsageWindow[];
  credits: { detail: string | null } | null;
  error: string | null;
  signInAgain: boolean;
  at: number;
};

export default async function plugin(room: BbPluginApi) {
  const kv = room.storage.kv;
  const telemetry = accountTelemetry(room);
  const secretsDir = path.join(
    room.server.experimental_dataDir,
    "plugins",
    room.pluginId,
    "secrets",
  );
  await fs.mkdir(secretsDir, { recursive: true, mode: 0o700 });
  const secretPath = (id: string) => path.join(secretsDir, `${id}.json`);
  const profilesDir = path.join(path.dirname(secretsDir), "profiles");
  const profilePath = (profile: string) => path.join(profilesDir, profile);
  // Each added Antigravity account's own HOME, holding its login (src/antigravity.ts). Named by the account's id.
  const agyDir = path.join(path.dirname(secretsDir), "antigravity");
  const agyHome = (id: string) => path.join(agyDir, id);
  const readAgy = (id: string) => fs.readFile(path.join(agyHome(id), AGY_TOKEN), "utf8");
  const agyLogin = new AntigravityLogin();
  // Sign-ins in progress: the new account's id, and when the add began (telemetry).
  const agyAdds = new Map<string, { id: string; startedAt: number }>();
  room.onDispose(() => agyLogin.stopAll());
  // A read said this computer's agy is signed out (or gone). Not set before the first read or by a failed one.
  let agyMacSignedOut = false;
  const dropProfile = async (profile: string) => {
    if (stillNamed("profile", profile)) return;
    try {
      await releaseProfile(profilePath(profile));
    } catch (error) {
      room.log.warn(
        `Claude account folder kept: ${error instanceof Error ? error.message : String(error)}`,
      );
      return;
    }
    await signOut(profilePath(profile));
    await fs.rm(profilePath(profile), { recursive: true, force: true });
  };
  // A record this build can't read (a newer build's, or damaged) stays stored, and every login stays, instead of all
  // accounts going at once.
  // A stored value that isn't a list is kept, unread, as one unreadable record.
  const raw: unknown = await kv.get("accounts:v1");
  const records = Array.isArray(raw) ? raw : [];
  let unreadable =
    raw === undefined || Array.isArray(raw)
      ? records.filter((entry) => !storedSchema.safeParse(entry).success)
      : [raw];
  let accounts = records.flatMap((entry) => storedSchema.safeParse(entry).data ?? []);
  // Every secret or profile folder deletion keeps one that a kept record (readable or not, any agent) still names.
  // Callers take the entry out of `accounts` or `unreadable` first.
  const stillNamed = (key: "id" | "profile", value: string) =>
    [...accounts, ...unreadable].some((entry) => Reflect.get(Object(entry), key) === value);
  const dropSecret = async (id: string) => {
    if (!stillNamed("id", id)) await fs.rm(secretPath(id), { force: true });
  };
  // Codex accounts moved to the website, which renews them for Local and Cloud threads (ADR 0195). The ones this Mac
  // kept sign in again (docs/scopes/multiple-subscriptions.md, decision 14). Not while a record is unreadable.
  const moved = accounts.filter((account) => account.provider === "codex");
  if (moved.length > 0 && unreadable.length === 0) {
    accounts = accounts.filter((account) => account.provider !== "codex");
    await Promise.all(moved.map((account) => dropSecret(account.id)));
    await kv.set("accounts:v1", [...accounts, ...unreadable]);
  }
  const order = z
    .object({
      "claude-code": z.array(z.string()),
      "acp-cursor": z.array(z.string()).default([LOCAL]),
      "acp-antigravity": z.array(z.string()).default([LOCAL]),
    })
    .catch({ "claude-code": [LOCAL], "acp-cursor": [LOCAL], "acp-antigravity": [LOCAL] })
    .parse(await kv.get("order:v1"));
  const limits = z
    .record(z.string(), limitMarkSchema)
    .catch({})
    .parse(await kv.get("limits:v1"));
  // Added Claude accounts whose full login failed here, and when: a Local turn Claude couldn't authenticate, or a login
  // Claude Code can't renew. Kept apart from usage, which the one-year token can still read. Only Sign in again or a
  // later Local turn that ends fine clears it (#1979).
  const loginFailed = z
    .record(z.string(), z.number())
    .catch({})
    .parse(await kv.get("login-failed:v1"));
  // `at` undefined clears it.
  const noteLoginFailed = async (id: string, at: number | undefined) => {
    if (loginFailed[id] === at) return;
    if (at === undefined) delete loginFailed[id];
    else loginFailed[id] = at;
    await kv.set("login-failed:v1", loginFailed);
    room.realtime.publish(ACCOUNTS_CHANGED, {});
  };
  // Names given to "This Mac", one per login it has had, keyed "<agent> <login>". A login is its email, plus its
  // organization for Claude: another login never wears the old one's name. Added accounts keep theirs on their record.
  const localNames = z
    .record(z.string(), z.string())
    .catch({})
    .parse(await kv.get("local-names:v1"));
  const localName = (provider: Provider, login: string | null) =>
    login === null ? null : (localNames[`${provider} ${login}`] ?? null);
  const saveLocalNames = () => kv.set("local-names:v1", localNames);
  let inCloud = z.string().nullable().catch(null).parse(await kv.get("cloud:v1"));
  // The Mac's own Claude login, and the organization of the one-year token Cloud uses for it.
  let mac: MacClaude | null = (await localClaudeAccount()) ?? null;
  const macLogin = () => (mac ? `${mac.email} ${mac.org ?? ""}` : null);
  const limitKey = (provider: Provider, id: string) =>
    provider === "claude-code" && id === LOCAL && mac
      ? `claude-code:local:${macLogin()}`
      : `${provider}:${id}`;
  const oldLocal = limits["claude-code:local"];
  if (mac && oldLocal !== undefined) {
    limits[limitKey("claude-code", LOCAL)] ??= oldLocal;
    delete limits["claude-code:local"];
    await kv.set("limits:v1", limits);
  }
  // Signing the Mac in or out can change the account in use; Cloud then follows it.
  const refreshMac = async () => {
    const read = await localClaudeAccount();
    if (read === undefined) return mac;
    const before = current("claude-code");
    if (read?.email !== mac?.email || read?.org !== mac?.org) usage.delete(LOCAL);
    mac = read;
    if (current("claude-code") !== before) void changed();
    return mac;
  };
  // The Mac login approved for Cloud: its identity (`~/.claude.json`) and plan. Its one-year token is secrets/local.json.
  const macCloudSchema = z.object({
    email: z.string(),
    org: z.string().nullable(),
    plan: z.string().nullable(),
  });
  let macCloud = macCloudSchema.nullable().catch(null).parse(await kv.get("mac-cloud:v1"));
  // `inCloud` is the account Cloud last confirmed. `cloudStale`: it has a newer token to upload.
  let cloudStale = z.boolean().catch(false).parse(await kv.get("cloud-stale:v1"));
  let cloudPending: string | null = null;
  // Counts stale marks, so an upload that started before a mark doesn't clear it.
  let staleMarks = 0;
  let cloudQueue: Promise<unknown> = Promise.resolve();
  // Before Cursor accounts, Cloud used a copy of the Mac's own Cursor login.
  let cursorInCloud = z.string().catch(LOCAL).parse(await kv.get("cursor-cloud:v1"));
  // Every account's last bars are kept across restarts: an account not in use is rarely read again, and its reset
  // times stay true until they pass.
  const usage = new Map<string, Usage>(
    Object.entries(
      z
        .record(z.string(), z.array(usageWindowSchema).catch([]))
        .catch({})
        .parse(await kv.get("usage:v1")),
    ).map(([id, windows]) => [
      id,
      {
        windows: windows.map((window) => ({ ...window, checkedAt: window.checkedAt ?? 0 })),
        credits: null,
        error: null,
        signInAgain: false,
        at: 0,
      },
    ]),
  );
  // Background work never throws: outside a request, an unhandled error stops the whole server. Once this run is
  // disposed (a reload) its storage throws, so work still waiting on a read ends there.
  let disposed = false;
  room.onDispose(() => {
    disposed = true;
  });
  const background = (work: Promise<unknown>) =>
    void work.catch((error: unknown) => {
      if (!disposed)
        room.log.warn(
          `Accounts background work failed: ${error instanceof Error ? error.message : String(error)}`,
        );
    });
  const saveUsage = () =>
    kv.set(
      "usage:v1",
      Object.fromEntries(
        [...usage].flatMap(([id, { windows }]) =>
          stillNamed("id", id) ? [[id, windows]] : [],
        ),
      ),
    );
  const threadAccount = new Map<string, { id: string; key: string }>();
  // A helper call, such as thread naming, uses the account in use but has no thread to note.
  const noteThreadAccount = (threadId: string | undefined, provider: Provider, id: string) => {
    if (threadId !== undefined) threadAccount.set(threadId, { id, key: limitKey(provider, id) });
  };
  // A message that joins a running turn asks for the env again, but that turn keeps the Claude, Codex or Cursor it
  // began on until it ends. Only a new turn notes its thread, so a late limit stays the old account's (#1300).
  const newTurn = async (threadId: string | undefined) => {
    try {
      if (
        threadId &&
        (await room.sdk.threads.get({ threadId })).status === "active"
      )
        return undefined;
    } catch {}
    return threadId;
  };
  // Claude account folders exist only on this computer. A thread on another machine (SSH, manual, another Mac) that
  // gets no account runs on that machine's own login (claude-code scope), so its limits are no account's here (#531).
  const ownLogin = new Set<string>();
  const noteOwnLogin = (threadId: string | undefined, own: boolean) => {
    if (threadId === undefined) return;
    if (own) ownLogin.add(threadId);
    else ownLogin.delete(threadId);
  };
  // Teleport keeps the thread: in Cloud it runs on the selected account again. A harness switch leaves Claude.
  const onOwnLogin = (
    thread: { id: string; providerId: string; executionTarget?: string } | null,
  ) =>
    thread !== null &&
    thread.providerId === "claude-code" &&
    thread.executionTarget !== "cloud" &&
    ownLogin.has(thread.id);
  // Cloud keeps its own Antigravity login, so no account here runs or limits a Cloud Antigravity thread.
  const cloudAgy = (thread: { providerId: string; executionTarget?: string } | null) =>
    thread?.providerId === "acp-antigravity" && thread.executionTarget === "cloud";
  let thisComputer: Promise<string | null> | undefined;
  const onAnotherMachine = async (hostId: string | undefined) => {
    thisComputer ??= room.sdk.system.config().then(
      (config) => config.primaryHostId ?? null,
      () => null,
    );
    const id = await thisComputer;
    return !!hostId && id !== null && hostId !== id;
  };
  // When each limit was noted and each running turn began, since this start. They tell a limit that has lifted.
  const limitedAt = new Map<string, number>();
  const turnBegan = new Map<string, number>();
  const claudeLogin = new ClaudeLogin(path.dirname(secretsDir), () =>
    room.server.experimental_claudeSetupToken?.(),
  );
  const adding = new Map<string, Adding>();
  // An unreadable record may own any folder, so none is dropped then.
  if (unreadable.length === 0) {
    void fs.readdir(profilesDir).then(
      (found) => Promise.all(found.map(dropProfile)),
      () => {},
    );
    void fs.readdir(agyDir).then(
      (found) =>
        Promise.all(
          found
            .filter((id) => !stillNamed("id", id))
            .map((id) => fs.rm(agyHome(id), { recursive: true, force: true })),
        ),
      () => {},
    );
  }
  let codexInUse = LOCAL;
  let codexAccounts = 0;
  // Codex accounts are known once the website's list was read (the usage box reads it).
  let codexListed = false;

  // `connect` marks the user adding, picking, or moving an account, which connects Claude again (ADR 0327).
  const changed = async (connect = false) => {
    await Promise.all([
      kv.set("accounts:v1", [...accounts, ...unreadable]),
      kv.set("order:v1", order),
      kv.set("limits:v1", limits),
    ]);
    room.realtime.publish(ACCOUNTS_CHANGED, {});
    return {
      cloud: followInCloud(connect),
      cursor: followCursorInCloud(),
      resumed: Promise.all([
        noteInUse("claude-code", current("claude-code")),
        noteInUse("acp-cursor", current("acp-cursor")),
        noteInUse("acp-antigravity", current("acp-antigravity")),
      ]),
    };
  };
  // The Mac's Claude login shows unless it is signed out or already added as an account.
  const macShown = () => {
    const login = mac;
    return (
      login !== null &&
      !accounts.some(
        (entry) =>
          entry.provider === "claude-code" &&
          login.org !== null &&
          entry.org === login.org &&
          entry.email === login.email,
      )
    );
  };
  const ids = (provider: Ordered = "claude-code"): string[] => {
    const saved = accounts
      .filter((account) => account.provider === provider)
      .map((account) => account.id);
    const kept = order[provider].filter(
      (id) => id === LOCAL || saved.includes(id),
    );
    // A missing Mac login goes last, so its return never switches accounts.
    order[provider] = [
      ...kept,
      ...saved.filter((id) => !kept.includes(id)),
      ...(kept.includes(LOCAL) ? [] : [LOCAL]),
    ];
    // A hidden Mac login leaves the order, so it comes back last.
    const hidden =
      provider === "claude-code" ? !macShown() : provider === "acp-antigravity" && agyMacSignedOut;
    if (saved.length > 0 && hidden)
      order[provider] = order[provider].filter((id) => id !== LOCAL);
    return order[provider];
  };
  // The top account is the one every thread uses (ADR 0197).
  const current = (provider: Provider): string =>
    provider === "codex" ? codexInUse : (ids(provider)[0] ?? LOCAL);
  const limitedUntil = (provider: Provider, id: string): number | null => {
    const mark = limits[limitKey(provider, id)];
    const until = typeof mark === "object" ? mark.until : mark;
    return until !== undefined && until > Date.now() ? until : null;
  };
  // Cloud keeps one Claude login (ADR 0197). The Mac's own login has no one-year token, so once Cloud is on
  // another account, picking the Mac's login needs one approval for Cloud first.
  const macCloudReady = () =>
    mac !== null && macCloud?.email === mac.email && macCloud.org === mac.org;
  // Cloud is on, or switching to, a login other than the approved Mac one. Null: Cloud keeps its own login.
  const macNeedsCloud = () => !macCloudReady() && (cloudPending ?? inCloud) !== null;
  // Until now the Mac's Claude login was hidden, never in use, once accounts existed. It now shows last, once.
  if (!(await kv.get("mac-login:v1"))) {
    ids();
    if (accounts.some((account) => account.provider === "claude-code"))
      order["claude-code"] = [
        ...order["claude-code"].filter((id) => id !== LOCAL),
        LOCAL,
      ];
    await kv.set("order:v1", order);
    await kv.set("mac-login:v1", true);
  }
  const views = (provider: Provider) =>
    provider === "codex"
      ? codexView()
      : provider === "acp-cursor"
        ? cursorView()
        : provider === "acp-antigravity"
          ? antigravityView()
          : claudeView();
  const accountName = async (provider: Provider, id: string) => {
    const view = (await views(provider).catch(() => [])).find((entry) => entry.id === id);
    return (
      view?.name ??
      view?.email ??
      (id === LOCAL ? `This ${COMPUTER_TITLE}` : "another account")
    );
  };
  const limited = await limitedThreads(room, accountName);
  // Cloud gets the names too: Core's "keep working" after the switch then shows as the same one line.
  const cloudSwitch = async (
    provider: Provider,
    from: string | null,
    to: string,
  ) =>
    from && from !== to
      ? {
          from: await accountName(provider, from),
          to: await accountName(provider, to),
        }
      : null;
  // The account each agent's threads use. A new one, picked from any thread or Settings, continues every thread a plan
  // limit stopped on another account (ADR 20261107-082836). Codex learns its account from the website's list.
  const inUse: Partial<Record<Provider, string>> = {
    "claude-code": current("claude-code"),
    "acp-cursor": current("acp-cursor"),
    "acp-antigravity": current("acp-antigravity"),
  };
  const noteInUse = async (provider: Provider, id: string) => {
    const before = inUse[provider];
    inUse[provider] = id;
    if (before !== undefined && before !== id)
      await limited.switched(provider, id);
  };
  let codexResumed: Promise<void> = Promise.resolve();

  const writeSecret = async (
    id: string,
    secret: Secret | z.infer<typeof cursorSecretSchema>,
  ) => {
    const temp = `${secretPath(id)}.${randomUUID()}.tmp`;
    await fs.writeFile(temp, JSON.stringify(secret), { mode: 0o600 });
    await fs.rename(temp, secretPath(id));
  };
  const readSecret = async (id: string): Promise<Secret> =>
    secretSchema.parse(JSON.parse(await fs.readFile(secretPath(id), "utf8")));
  const readCursorKey = async (account: Stored): Promise<string> =>
    cursorSecretSchema.parse(
      JSON.parse(await fs.readFile(secretPath(account.id), "utf8")),
    ).apiKey;
  // Cloud keeps one Claude login per user, so it follows the account in use (ADR 0197).
  // Resolves to why Cloud is not on the account, or null.
  // Switches run one at a time.
  const followInCloud = (connect: boolean): Promise<string | null> => {
    const run = cloudQueue.then(() => followOnce(connect));
    cloudQueue = run.catch(() => null);
    return run;
  };
  const followOnce = async (connect: boolean): Promise<string | null> => {
    const marks = staleMarks;
    const id = current("claude-code");
    const account = accounts.find((entry) => entry.id === id);
    if (id === inCloud && !cloudStale) return null;
    if (!account && !(id === LOCAL && macCloudReady())) return null;
    const plan = account ? account.plan : macCloud?.plan;
    cloudPending = id;
    try {
      const secret = await readSecret(id);
      const switched = await cloudSwitch("claude-code", inCloud, id);
      const status = await room.sdk.cloudroom.claudeAuth({
        action: "token",
        requestId: randomUUID(),
        token: secret.accessToken,
        ...(plan ? { plan } : {}),
        follow: !connect,
        ...(switched ? { switched } : {}),
      });
      // A disconnected Claude skips background saves, so Cloud is still not on this account.
      if (status.state !== "connected")
        return "Claude isn't connected in Cloud.";
      inCloud = id;
      // A mark made during the upload (say a new plan) still needs its own upload.
      if (staleMarks === marks) cloudStale = false;
      await kv.set("cloud:v1", id);
      await kv.set("cloud-stale:v1", cloudStale);
      return null;
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      room.log.warn(`Cloud could not switch Claude accounts: ${message}`);
      return message;
    } finally {
      cloudPending = null;
    }
  };
  const markStale = async () => {
    staleMarks++;
    cloudStale = true;
    await kv.set("cloud-stale:v1", true);
  };

  // Cloud keeps one Cursor login per user too: the account in use, or a copy of the Mac's own login.
  const followCursorInCloud = async (): Promise<string | null> => {
    const id = current("acp-cursor");
    if (id === cursorInCloud) return null;
    const account = accounts.find((entry) => entry.id === id);
    try {
      const switched = await cloudSwitch("acp-cursor", cursorInCloud, id);
      const status = await room.sdk.cloudroom.cursorAccount({
        requestId: randomUUID(),
        apiKey: account ? await readCursorKey(account) : null,
        ...(switched ? { switched } : {}),
      });
      if (status.state !== "connected") return "Cursor isn't connected in Cloud.";
      cursorInCloud = id;
      await kv.set("cursor-cloud:v1", id);
      return null;
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      room.log.warn(`Cloud could not switch Cursor accounts: ${message}`);
      return message;
    }
  };

  // agy reads the account in use's login from one file; this computer's own login needs none (src/antigravity.ts).
  // Every folder on disk counts as ours, so a removed account's login still gets replaced. One at a time.
  let agyQueue: Promise<unknown> = Promise.resolve();
  const placeAgy = (): Promise<void> => {
    const run = agyQueue.then(async () => {
      const id = current("acp-antigravity");
      const grants = await Promise.all(
        (await fs.readdir(agyDir).catch(() => [])).map((entry) =>
          readAgy(entry).then(
            (text) => readAgyLogin(text).grant,
            () => null,
          ),
        ),
      );
      await placeAgyLogin(
        id === LOCAL ? null : await readAgy(id),
        new Set(grants.filter((grant) => grant !== null)),
      );
    });
    agyQueue = run.catch(() => {});
    return run;
  };

  type ReadMode = "free" | "reply" | "failure";
  const readAccountUsage = async (
    account: Stored | typeof LOCAL,
    mode: ReadMode | undefined,
    previous: Usage | undefined,
  ): Promise<ClaudeUsage | null> => {
    if (account === LOCAL) {
      const read = await profileUsage();
      await refreshMac();
      return read;
    }
    if (account.provider === "acp-cursor")
      return { windows: await cursorUsage(await readCursorKey(account)), credits: null };
    if (account.provider === "acp-antigravity") {
      const read = await agyUsage(agyHome(account.id));
      account.plan = read.plan ?? account.plan;
      return { windows: read.windows, credits: null };
    }
    const profile = account.profile ? profilePath(account.profile) : undefined;
    if (mode === "free" || mode === "failure") return profile ? profileUsage(profile) : null;
    return claudeUsage(
      await readSecret(account.id),
      profile,
      previous?.at && previous.windows.length ? previous : undefined,
    );
  };
  const pendingReads = new Map<
    string,
    { mark: (typeof limits)[string] | undefined; mode?: ReadMode; done: Promise<void> }
  >();
  const refreshUsage = (
    account: Stored | typeof LOCAL,
    force = false,
    mode?: ReadMode,
  ): Promise<void> => {
    const local = account === LOCAL;
    const id = local ? LOCAL : account.id;
    const key = limitKey(local ? "claude-code" : account.provider, id);
    const mark = limits[key];
    const pending = pendingReads.get(key);
    if (pending && pending.mark === mark) {
      // Reload after a failure must get its own observation after the baseline.
      if (pending.mode === "failure" && mode !== "failure")
        return pending.done.then(() => refreshUsage(account, force, mode));
      if (pending.mode === mode || !force) return pending.done;
    }
    const previous = usage.get(id);
    if (!force && previous && Date.now() - previous.at < USAGE_EVERY_MS) return Promise.resolve();
    const stale = () =>
      disposed ||
      limits[key] !== mark ||
      (local ? !mac || limitKey("claude-code", LOCAL) !== key : !accounts.includes(account)) ||
      pendingReads.get(key)?.done !== done;
    const load = async () => {
      let read: ClaudeUsage | null;
      try {
        read = await readAccountUsage(account, mode, previous);
        if (!read || stale()) return;
        if (read.loginEnded) {
          if (!local) await noteLoginFailed(id, loginFailed[id] ?? Date.now());
          if (!read.windows.length || stale()) return;
        }
      } catch (error) {
        if (mode || stale()) return;
        usage.set(id, {
          windows: previous?.windows ?? [],
          credits: previous?.credits ?? null,
          error: error instanceof Error ? error.message : String(error),
          signInAgain: error instanceof SignInAgainError,
          at: Date.now(),
        });
        if (usage.get(id)?.error !== previous?.error) await changed();
        return;
      }

      const kept = (previous?.windows ?? []).filter(
        (window) =>
          window.model &&
          (window.resetsAt ?? 0) > Date.now() &&
          (!read.reportedModels || read.reportedModels.includes(window.model)) &&
          !read.windows.some((next) => next.label === window.label),
      );
      // A bar this read returned is checked now, unless it's the last read's, kept through a short error.
      const now = Date.now();
      const windows = [
        ...read.windows.map((window) => ({ ...window, checkedAt: window.checkedAt ?? now })),
        ...kept,
      ];
      usage.set(id, {
        windows,
        credits: read.credits,
        error: null,
        signInAgain: false,
        at: now,
      });
      const next = mark === undefined ? undefined : afterUsage(mark, read, mode === "failure");
      if (next !== mark) {
        if (next === null) {
          delete limits[key];
          limitedAt.delete(key);
        } else if (next !== undefined) limits[key] = next;
        await kv.set("limits:v1", limits);
      }
      // Exact, check time included: every read is saved, and open pages never grey a bar the server just read.
      const moved = JSON.stringify(windows) !== JSON.stringify(previous?.windows);
      if (!local && moved) await saveUsage();
      if (next !== mark || previous?.error || !read.credits !== !previous?.credits || moved)
        room.realtime.publish(ACCOUNTS_CHANGED, {});
    };
    const done: Promise<void> = load().finally(() => {
      if (pendingReads.get(key)?.done === done) pendingReads.delete(key);
    });
    pendingReads.set(key, { mark, mode, done });
    return done;
  };
  // A Claude check is a real 1-token reply that can open a 5-hour window,
  // so only the account in use is checked in the background. Cursor's usage is a plain read.
  const readMacUsage = () =>
    mac &&
    (limitedUntil("claude-code", LOCAL) ||
      (current("claude-code") === LOCAL && accounts.some((a) => a.provider === "claude-code")));
  const refreshAll = (force = false) =>
    Promise.all([
      readMacUsage() ? refreshUsage(LOCAL, force) : undefined,
      ...accounts
        .filter(
          (account) =>
            account.provider === "acp-cursor" ||
            account.id === current("claude-code") ||
            account.id === current("acp-antigravity"),
        )
        .map((account) => refreshUsage(account, force)),
    ]);
  // Claude accounts not in use get a free read at start and every hour, one at a time. An account with no bars saved
  // yet (added before they were kept, or its first check failed) gets one reply at start, so its row isn't empty.
  const refreshIdle = async (fill = false) => {
    for (const account of accounts) {
      if (disposed) return;
      // Antigravity's read runs agy for a few seconds, so its other accounts are read hourly too.
      if (
        (account.provider !== "claude-code" && account.provider !== "acp-antigravity") ||
        account.id === current(account.provider) ||
        !accounts.includes(account)
      )
        continue;
      await refreshUsage(
        account,
        true,
        fill && !usage.get(account.id)?.windows.length ? "reply" : "free",
      );
    }
  };
  // Added accounts per agent ("This Mac" not counted), for the daily `accounts_snapshot`. Codex is null until the
  // website's list was read.
  const snapshot = () => {
    const added = (provider: Ordered) =>
      accounts.filter((account) => account.provider === provider).length;
    const kind = (id: string) => (id === LOCAL ? "this_mac" : "added");
    return {
      claude: added("claude-code"),
      codex: codexListed ? codexAccounts : null,
      cursor: added("acp-cursor"),
      claude_in_use: kind(current("claude-code")),
      codex_in_use: codexListed ? kind(codexInUse) : null,
      cursor_in_use: kind(current("acp-cursor")),
    };
  };
  // A token Cloud hasn't confirmed yet is retried every few minutes, and at start.
  let ticks = 0;
  const timer = setInterval(() => {
    background(refreshAll());
    background(telemetry.daily(snapshot));
    if (++ticks % IDLE_USAGE_TICKS === 0) {
      background(refreshIdle());
      background(refreshPlans());
    }
    if (cloudStale) void followInCloud(false);
  }, USAGE_EVERY_MS);
  if (cloudStale) void followInCloud(false);
  timer.unref();
  room.onDispose(() => clearInterval(timer));
  background(refreshAll());
  background(refreshIdle(true));
  if (current("acp-antigravity") !== LOCAL) background(placeAgy());
  // Plans change on Claude's side, and `claude auth status` keeps the one a login signed in with (#2534). So each full
  // login's plan is read live at start and hourly, with no reply. Accounts saved before plan tiers were read fall back
  // to `claude auth status` once, so Ultra shows as Ultra. A changed plan Cloud runs on is sent to Cloud again.
  const refreshPlans = async () => {
    let moved = false;
    for (const entry of accounts) {
      if (disposed) return;
      if (entry.provider !== "claude-code" || !entry.profile) continue;
      const dir = profilePath(entry.profile);
      const found =
        (await profilePlan(dir).catch(() => null)) ??
        (entry.tier === undefined
          ? await profileAccount(dir).catch(() => null)
          : null);
      const plan = found?.plan ?? entry.plan;
      if (
        !found ||
        !accounts.includes(entry) ||
        (entry.org && "org" in found && found.org && found.org !== entry.org) ||
        (plan === entry.plan && found.tier === entry.tier)
      )
        continue;
      const planMoved = plan !== entry.plan;
      entry.plan = plan;
      entry.tier = found.tier;
      moved = true;
      if (planMoved && (entry.id === inCloud || entry.id === cloudPending)) await markStale();
    }
    // The Mac's own login approved for Cloud, while Cloud runs on it and its usage is read anyway.
    await refreshMac();
    const approved = macCloud;
    const onMac = () => inCloud === LOCAL || cloudPending === LOCAL;
    if (approved && onMac() && macCloudReady() && readMacUsage()) {
      const found = await profilePlan().catch(() => null);
      // The terminal login may have changed during the read: only the approved login's plan counts.
      if (
        found &&
        found.plan !== approved.plan &&
        (!approved.org || found.org === approved.org) &&
        macCloud === approved &&
        macCloudReady() &&
        onMac() &&
        !disposed
      ) {
        macCloud = { ...approved, plan: found.plan };
        await kv.set("mac-cloud:v1", macCloud);
        await markStale();
        moved = true;
      }
    }
    if (moved) await changed();
  };
  background(refreshPlans());

  // Adding never switches accounts: the one in use stays in use.
  const add = async (
    signedIn: SignedIn,
    login: Pick<Stored, "profile" | "org" | "tier">,
  ) => {
    if (
      accounts.filter((account) => account.provider === "claude-code").length >=
      MAX_ACCOUNTS
    )
      throw new Error(
        `You can connect up to ${MAX_ACCOUNTS} accounts per provider.`,
      );
    const account: Stored = {
      id: randomUUID(),
      provider: "claude-code",
      email: signedIn.email,
      plan: signedIn.plan,
      accountKey: signedIn.accountKey,
      ...login,
      createdAt: Date.now(),
    };
    await writeSecret(account.id, { ...signedIn.secret, issuedAt: Date.now() });
    const macInUse = current("claude-code") === LOCAL;
    accounts = [...accounts, account];
    // Adding the Mac's own account hides its tile: the copy keeps the selection.
    if (macInUse && !macShown()) move(account.id, 0);
    ids();
    await changed(true);
    background(refreshUsage(account, true));
  };

  // Listed in the order they were added, the machine's own login first, so picking an account never moves a row.
  // The saved order only says which account is in use: its first entry.
  const shown = (provider: Ordered): string[] => {
    const added = (id: string) =>
      accounts.find((entry) => entry.id === id)?.createdAt ?? 0;
    return [...ids(provider)].sort((a, b) => added(a) - added(b));
  };
  const rows = (
    provider: Ordered,
    localEmail: string | null,
    localLogin = localEmail,
  ): AccountView[] => {
    const using = current(provider);
    return shown(provider).map((id) => {
      const account = accounts.find((entry) => entry.id === id);
      const measured = id === LOCAL && (provider !== "claude-code" || !readMacUsage()) ? undefined : usage.get(id);
      return {
        id,
        name: id === LOCAL ? localName(provider, localLogin) : (account?.name ?? null),
        email: id === LOCAL ? localEmail : (account?.email ?? null),
        plan:
          provider === "claude-code"
            ? (claudePlanName(account?.plan ?? null, account?.tier) ?? null)
            : (account?.plan ?? null),
        inUse: id === using,
        limitedUntil: limitedUntil(provider, id),
        error: id in loginFailed ? LOGIN_FAILED : (measured?.error ?? null),
        credits: id === using ? (measured?.credits ?? null) : null,
        // Accounts not in use aren't checked, so a window past its reset shows empty.
        windows: (measured?.windows ?? []).map((window) =>
          window.resetsAt !== null && window.resetsAt <= Date.now()
            ? { ...window, usedPercent: 0, resetsAt: null }
            : window,
        ),
        needsSignIn: false,
        limitedLogin:
          provider === "claude-code" && account !== undefined && !account.profile,
        signedOut: id in loginFailed || measured?.signInAgain === true,
      };
    });
  };
  const claudeView = async (refresh = false): Promise<AccountView[]> => {
    await refreshMac();
    if (refresh) {
      const active = current("claude-code");
      await Promise.all([
        ...accounts
          .filter(
            (a) =>
              a.provider === "claude-code" &&
              (a.id === active || (a.profile && limitedUntil("claude-code", a.id))),
          )
          .map((a) => refreshUsage(a, true, a.id === active ? undefined : "free")),
        readMacUsage() ? refreshUsage(LOCAL, true) : undefined,
      ]);
    }
    const needsCloud = macNeedsCloud();
    return rows("claude-code", mac?.email ?? null, macLogin()).map((row) =>
      row.id === LOCAL && needsCloud ? { ...row, needsSignIn: true } : row,
    );
  };
  // "This Mac" is the Mac's own Cursor login and stays selectable: Cloud then uses a copy of it, as before accounts.
  let cursorLocal: { email: string | null; at: number } | null = null;
  const cursorView = async (): Promise<AccountView[]> => {
    if (!cursorLocal || Date.now() - cursorLocal.at > USAGE_EVERY_MS)
      cursorLocal = { email: await localCursorEmail(), at: Date.now() };
    return rows("acp-cursor", cursorLocal.email);
  };
  // This Mac's Antigravity subscription, shown in Settings → Agents → Accounts only while connected (David, 2026-11-21).
  let antigravityLocal: {
    at: number;
    connected: boolean;
    email: string | null;
    plan: string | null;
    windows: UsageWindow[];
  } = { at: 0, connected: false, email: null, plan: null, windows: [] };
  let antigravityLocalReading: Promise<void> | null = null;
  const refreshAntigravityLocal = (force = false): Promise<void> => {
    if (antigravityLocalReading) return antigravityLocalReading;
    if (!force && antigravityLocal.at > 0 && Date.now() - antigravityLocal.at < USAGE_EVERY_MS)
      return Promise.resolve();
    const run = (async () => {
      const response = await room.sdk.system
        .usageLimits({ providerId: "acp-antigravity" })
        .catch(() => null);
      const now = Date.now();
      if (response === null) {
        antigravityLocal = { ...antigravityLocal, at: now };
        return;
      }
      const usage = response["acp-antigravity"];
      const next =
        usage?.status === "ok"
          ? {
              at: now,
              connected: true,
              email: usage.accountEmail ?? null,
              plan: usage.planLabel ?? null,
              windows: usage.windows
                .filter(
                  (window) =>
                    !/\b3p\b/iu.test(window.label) || window.usedPercent > 0,
                )
                .map((window) => ({
                  label: window.label,
                  usedPercent: window.usedPercent,
                  resetsAt: Date.parse(window.resetsAt ?? "") || null,
                  checkedAt: now,
                })),
            }
          : usage?.status === "error"
            ? { ...antigravityLocal, at: now }
            : { at: now, connected: false, email: null, plan: null, windows: [] };
      const moved =
        next.connected !== antigravityLocal.connected ||
        next.email !== antigravityLocal.email ||
        next.plan !== antigravityLocal.plan ||
        JSON.stringify(next.windows) !== JSON.stringify(antigravityLocal.windows);
      antigravityLocal = next;
      const signedOut = usage?.status !== "ok" && usage?.status !== "error";
      if (signedOut !== agyMacSignedOut) {
        agyMacSignedOut = signedOut;
        await changed();
      } else if (moved) room.realtime.publish(ACCOUNTS_CHANGED, {});
    })().finally(() => {
      if (antigravityLocalReading === run) antigravityLocalReading = null;
    });
    antigravityLocalReading = run;
    return run;
  };
  // "This Mac" shows only while this computer's agy is signed in; added accounts always show.
  const antigravityView = async (refresh = false): Promise<AccountView[]> => {
    if (refresh || antigravityLocal.at === 0) await refreshAntigravityLocal(refresh);
    else background(refreshAntigravityLocal());
    const now = Date.now();
    return rows("acp-antigravity", antigravityLocal.email).flatMap((row) =>
      row.id !== LOCAL
        ? [row]
        : antigravityLocal.connected
          ? [
              {
                ...row,
                plan: antigravityLocal.plan,
                windows: antigravityLocal.windows.map((window) =>
                  window.resetsAt !== null && window.resetsAt <= now
                    ? { ...window, usedPercent: 0, resetsAt: null }
                    : window,
                ),
              },
            ]
          : [],
    );
  };
  // This computer's own login, read now, so a rename never names the login before it.
  const thisLogin = async (provider: Provider): Promise<string | null> => {
    if (provider === "codex") return localCodexEmail();
    if (provider === "claude-code") {
      await refreshMac();
      return macLogin();
    }
    if (provider === "acp-antigravity") {
      await refreshAntigravityLocal(true);
      return antigravityLocal.connected ? antigravityLocal.email : null;
    }
    cursorLocal = { email: await localCursorEmail(), at: Date.now() };
    return cursorLocal.email;
  };
  // "This Mac" Codex usage comes from the reader the usage card uses, on this Mac only. The list never waits for it:
  // it shows the last bars, and one background read at a time refreshes them at most every 5 minutes.
  let codexLocal: { at: number; windows: UsageWindow[] } = {
    at: 0,
    windows: [],
  };
  let codexLocalReading = false;
  const refreshCodexLocal = async () => {
    if (codexLocalReading || Date.now() - codexLocal.at < USAGE_EVERY_MS)
      return;
    codexLocalReading = true;
    try {
      const usage = (
        await room.sdk.system
          .usageLimits({ providerId: "codex" })
          .catch(() => null)
      )?.codex;
      const windows =
        usage?.status === "ok"
          ? usage.windows.map((window) => ({
              label:
                window.kind === "five-hour" ? "Five-hour limit" : window.label,
              usedPercent: window.usedPercent,
              resetsAt: Date.parse(window.resetsAt ?? "") || null,
            }))
          : // A failed read keeps the last bars; a signed-out Mac has none.
            !usage || usage.status === "error"
            ? codexLocal.windows
            : [];
      const changed =
        JSON.stringify(windows) !== JSON.stringify(codexLocal.windows);
      codexLocal = { at: Date.now(), windows };
      // Open lists read again; the fresh bars then come from the cache.
      if (changed) room.realtime.publish(ACCOUNTS_CHANGED, {});
    } finally {
      codexLocalReading = false;
    }
  };
  // Codex accounts live on the website (ADR 0195). "This Mac" is the Mac's own `~/.codex` login and stays selectable:
  // Cloud then uses the copy of it the app uploads, as before.
  const codexView = async (
    result?: unknown,
  ): Promise<AccountView[]> => {
    const list = codexListSchema.parse(
      result ?? (await room.sdk.cloudroom.codexAccounts({ action: "list" })),
    );
    const selected = list.accounts.find((account) => account.inUse);
    codexInUse = selected?.id ?? LOCAL;
    codexAccounts = list.accounts.length;
    codexListed = true;
    codexResumed = noteInUse("codex", codexInUse);
    background(refreshCodexLocal());
    const email = await localCodexEmail();
    return [
      {
        id: LOCAL,
        name: localName("codex", email),
        email,
        plan: null,
        inUse: !selected,
        limitedUntil: limitedUntil("codex", LOCAL),
        error: null,
        credits: null,
        windows: codexLocal.windows,
        needsSignIn: false,
        limitedLogin: false,
        signedOut: false,
      },
      ...list.accounts.map((account) => ({
        ...account,
        limitedUntil: limitedUntil("codex", account.id),
        needsSignIn: false,
        limitedLogin: false,
        signedOut: false,
      })),
    ];
  };
  const codex = async (
    input: Parameters<typeof room.sdk.cloudroom.codexAccounts>[0],
  ) => {
    const views = await codexView(await room.sdk.cloudroom.codexAccounts(input));
    room.realtime.publish(ACCOUNTS_CHANGED, {});
    return views;
  };
  const move = (id: string, to: number, provider: Ordered = "claude-code") => {
    const list = ids(provider).filter((entry) => entry !== id);
    list.splice(Math.max(0, Math.min(list.length, to)), 0, id);
    order[provider] = list;
  };
  const stored = (id: string) => {
    if (id === LOCAL)
      throw new Error("This machine's own login can't be changed here.");
    return id;
  };
  // Both sign-ins must be the same account: the full login runs Local threads, the one-year token runs Cloud.
  const save = async (state: Adding, token: string) => {
    const account = state.account!;
    if (!account.orgId || account.orgId !== (await tokenOrganization(token)))
      throw new Error(
        "Both sign-ins must use the same Claude account. Start again.",
      );
    const secret = { ...claudeSecret(token), issuedAt: Date.now() };
    const existing =
      accounts.find((entry) => entry.id === state.replace) ??
      accounts.find(
        (entry) =>
          entry.provider === "claude-code" &&
          entry.org === account.orgId &&
          entry.email === account.email,
      );
    if (!existing)
      return add(
        { email: account.email, plan: account.plan, accountKey: null, secret },
        { profile: state.profile, org: account.orgId, tier: account.tier },
      );
    // A revoked token can't name its account; anything else unconfirmed keeps the saved login.
    const before =
      existing.org ??
      (await readSecret(existing.id)
        .then((saved) => tokenOrganization(saved.accessToken))
        .catch((error: unknown) =>
          error instanceof SignInAgainError ? account.orgId : null,
        ));
    if (!before)
      throw new Error("Couldn't confirm this account. Try again.");
    if (
      before !== account.orgId ||
      (existing.org && existing.email !== account.email)
    )
      throw new Error(
        "That is a different Claude account. Sign in with this account's email.",
      );
    const old = existing.profile;
    await writeSecret(existing.id, secret);
    existing.email = account.email;
    existing.plan = account.plan ?? existing.plan;
    existing.tier = account.tier ?? existing.tier;
    existing.profile = state.profile;
    existing.org = account.orgId;
    if (old) void dropProfile(old);
    // The new login replaces the rejected one: its error clears now, not at the next usage read.
    const seen = usage.get(existing.id);
    if (seen?.signInAgain) usage.set(existing.id, { ...seen, error: null, signInAgain: false });
    await noteLoginFailed(existing.id, undefined);
    // Cloud gets the new token on its next follow, even after a restart.
    if (existing.id === inCloud) await markStale();
    await changed(true);
    background(refreshUsage(existing, true));
  };

  // One approval gives Cloud a one-year token for the Mac's own login, which then goes in use once Cloud has it.
  const saveMac = async (token: string) => {
    const login = await refreshMac();
    const status = await profileAccount().catch(() => null);
    if (!login || !status?.orgId || status.orgId !== (await tokenOrganization(token)))
      throw new Error(
        `Approve with ${login?.email ?? "the Claude account this Mac uses"}. Start again.`,
      );
    await writeSecret(LOCAL, { ...claudeSecret(token), issuedAt: Date.now() });
    macCloud = { email: login.email, org: login.org, plan: status.plan };
    await kv.set("mac-cloud:v1", macCloud);
    if (inCloud === LOCAL) await markStale();
    const before = [...order["claude-code"]];
    move(LOCAL, 0);
    const failed = await (await changed(true)).cloud;
    if (failed) {
      order["claude-code"] = before;
      await changed();
      throw new Error(`Cloud didn't switch accounts: ${failed}. Click Use to try again.`);
    }
  };

  // An account Cursor already knows (same user) keeps its place and gets the new key.
  const addCursor = async (apiKey: string) => {
    const key = apiKey.trim();
    if (!isCursorKey(key))
      throw new Error("Paste a Cursor API key from cursor.com/dashboard.");
    const found = await cursorAccount(key);
    const existing = accounts.find(
      (entry) =>
        entry.provider === "acp-cursor" &&
        found.accountKey !== null &&
        entry.accountKey === found.accountKey,
    );
    if (!existing && ids("acp-cursor").length > MAX_ACCOUNTS)
      throw new Error(
        `You can connect up to ${MAX_ACCOUNTS} accounts per provider.`,
      );
    const account: Stored = existing ?? {
      id: randomUUID(),
      provider: "acp-cursor",
      email: found.email,
      plan: found.plan,
      accountKey: found.accountKey,
      createdAt: Date.now(),
    };
    await writeSecret(account.id, { apiKey: key });
    account.email = found.email;
    account.plan = found.plan;
    if (!existing) accounts = [...accounts, account];
    // Cloud gets the new key on its next follow.
    if (account.id === cursorInCloud) cursorInCloud = "";
    await changed();
    background(refreshUsage(account, true));
  };

  // Each Antigravity account signs in with Google in its own HOME, so its login never touches this computer's.
  const agyCount = () => accounts.filter((account) => account.provider === "acp-antigravity").length;
  const startAntigravity = async () => {
    if (agyCount() >= MAX_ACCOUNTS)
      throw new Error(`You can connect up to ${MAX_ACCOUNTS} accounts per provider.`);
    const id = randomUUID();
    await fs.mkdir(agyHome(id), { recursive: true, mode: 0o700 });
    try {
      const started = await agyLogin.start(agyHome(id));
      agyAdds.set(started.sessionId, { id, startedAt: Date.now() });
      return started;
    } catch (error) {
      await fs.rm(agyHome(id), { recursive: true, force: true });
      throw error;
    }
  };
  // Adding never switches accounts. The same Google account twice is refused: Remove it first to sign in again.
  const completeAntigravity = async (sessionId: string, code: string) => {
    const id = agyAdds.get(sessionId)?.id;
    if (!id) throw new Error("This sign-in expired. Start again.");
    // A mistyped code keeps the sign-in open, so the user can paste again.
    if (!isAgyCode(code)) throw new Error("Paste the code Google showed.");
    try {
      const { login } = await agyLogin.complete(sessionId, code);
      if (!agyAdds.has(sessionId)) throw new Error("This sign-in was cancelled.");
      const { email } = readAgyLogin(login);
      if (
        email !== null &&
        accounts.some((entry) => entry.provider === "acp-antigravity" && entry.email === email)
      )
        throw new Error(`${email} is already added.`);
      if (agyCount() >= MAX_ACCOUNTS)
        throw new Error(`You can connect up to ${MAX_ACCOUNTS} accounts per provider.`);
      const account: Stored = {
        id,
        provider: "acp-antigravity",
        email,
        plan: null,
        accountKey: null,
        createdAt: Date.now(),
      };
      accounts = [...accounts, account];
      agyAdds.delete(sessionId);
      ids("acp-antigravity");
      await changed();
      background(refreshUsage(account, true));
    } catch (error) {
      agyAdds.delete(sessionId);
      agyLogin.cancel(sessionId);
      if (!accounts.some((entry) => entry.id === id))
        await fs.rm(agyHome(id), { recursive: true, force: true });
      throw error;
    }
  };

  const remove = async (provider: Provider, id: string) => {
    stored(id);
    delete limits[limitKey(provider, id)];
    if (provider === "codex") {
      await codex({ action: "remove", id });
      await kv.set("limits:v1", limits);
      return;
    }
    const removed = accounts.find((account) => account.id === id);
    accounts = accounts.filter((account) => account.id !== id);
    if (removed?.profile) void dropProfile(removed.profile);
    order[provider] = order[provider].filter((entry) => entry !== id);
    if (removed?.provider === "acp-antigravity") {
      // The next account goes in use before this one's folder, and with it its login, is gone.
      await placeAgy().catch((error: unknown) =>
        room.log.warn(`Antigravity login not switched: ${error instanceof Error ? error.message : String(error)}`),
      );
      await fs.rm(agyHome(id), { recursive: true, force: true });
    }
    usage.delete(id);
    await noteLoginFailed(id, undefined);
    await dropSecret(id);
    await saveUsage();
    // Cloud can't follow the Mac's login without its approval, so the next added account goes in use.
    if (provider === "claude-code" && current(provider) === LOCAL && macNeedsCloud()) {
      const next = ids(provider).find((entry) => entry !== LOCAL);
      if (next) move(next, 0);
    }
    await changed();
  };

  // The Mac's own login already runs Local threads: Cloud only needs its one-year token.
  const startClaude = async (
    input: { mac?: boolean | undefined; id?: string | undefined } | null,
    add: Pick<Adding, "kind" | "startedAt">,
  ) => {
    if (input?.mac) {
      if (!(await refreshMac()))
        throw new Error("Sign in to Claude Code on this Mac first: run `claude`.");
      const started = await claudeLogin.start();
      adding.set(started.sessionId, {
        login: started.sessionId,
        replace: null,
        mac: true,
        ...add,
      });
      return started;
    }
    const replace = input?.id ? stored(input.id) : null;
    const profile = randomUUID();
    try {
      await prepareProfile(profilePath(profile));
      const started = await claudeLogin.start(profilePath(profile));
      adding.set(started.sessionId, {
        login: started.sessionId,
        profile,
        replace,
        mac: false,
        ...add,
      });
      return started;
    } catch (error) {
      void dropProfile(profile);
      throw error;
    }
  };
  // Codex sign-ins in progress, for telemetry. The website keeps the sign-in itself.
  const codexAdds = new Map<string, Pick<Adding, "kind" | "startedAt">>();

  // Picks the account every thread uses. `following` is Cloud's follow, still running unless `cloud` waited for it; none
  // for Codex, whose website switches Cloud in the same call.
  const useAccount = async (
    provider: Provider,
    id: string,
    cloud: boolean | undefined,
    threadId: string | undefined,
  ): Promise<{ following: Promise<string | null> | null }> => {
    if (provider !== "claude-code") delete limits[limitKey(provider, id)];
    // The thread it was picked from continues too: the user asked, even after a Stop or a limit this plugin
    // never noted.
    if (threadId)
      await limited.record(
        threadId,
        provider,
        limited.account(threadId) ?? current(provider),
      );
    if (provider === "codex") {
      inUse.codex ??= codexInUse;
      await codex({ action: "use", id: id === LOCAL ? null : id });
      await kv.set("limits:v1", limits);
      await codexResumed;
      return { following: null };
    }
    if (provider === "acp-antigravity" && id === LOCAL) {
      await refreshAntigravityLocal(true);
      if (!antigravityLocal.connected)
        throw new Error("Sign in to Antigravity on this Mac first: run `agy`.");
    }
    if (provider === "claude-code" && id === LOCAL) {
      if (!(await refreshMac()))
        throw new Error(
          "Sign in to Claude Code on this Mac first: run `claude`.",
        );
      if (macNeedsCloud()) throw new Error(MAC_NEEDS_CLOUD);
    }
    // This Mac without a Cursor login would leave Cloud on the previous account.
    if (provider === "acp-cursor" && id === LOCAL) {
      cursorLocal = { email: await localCursorEmail(), at: Date.now() };
      if (!cursorLocal.email)
        throw new Error(
          "Sign in to Cursor on this Mac first: run `cursor-agent login`.",
        );
    }
    const before = [...order[provider]];
    move(id, 0, provider);
    // Cloud keeps its own Antigravity login for now (docs/scopes/multiple-subscriptions.md, 35).
    if (provider === "acp-antigravity")
      await placeAgy().catch((error: unknown) => {
        order[provider] = before;
        throw error;
      });
    const follow = await changed(true);
    const following =
      provider === "acp-cursor"
        ? follow.cursor
        : provider === "acp-antigravity"
          ? null
          : follow.cloud;
    const account = accounts.find((entry) => entry.id === id);
    if (account) background(refreshUsage(account, true));
    else if (provider === "claude-code" && id === LOCAL && mac) background(refreshUsage(LOCAL, true));
    await follow.resumed;
    const failed = cloud ? await following : null;
    if (failed) throw new Error(`Cloud didn't switch accounts: ${failed}`);
    return { following };
  };

  room.rpc.register(
    accountsRpcContract,
    {
      "accounts.list": ({ provider, refresh }) =>
        provider === "claude-code" && refresh
          ? claudeView(true)
          : provider === "acp-antigravity"
            ? antigravityView(Boolean(refresh))
            : views(provider),
      "accounts.use": async ({ provider, id, cloud, threadId, where }) => {
        const startedAt = Date.now();
        // Read before the switch changes them.
        const before = {
          provider,
          where: where ?? null,
          to: id === LOCAL ? ("this_mac" as const) : ("added" as const),
          accounts: provider === "codex" ? codexAccounts + 1 : ids(provider).length,
          target_at_limit: limitedUntil(provider, id) !== null,
          waiting_threads:
            limited.waiting(provider) +
            (threadId && limited.account(threadId) === undefined ? 1 : 0),
        };
        const cloudMoves =
          provider === "claude-code"
            ? (id !== (cloudPending ?? inCloud) || cloudStale) &&
              (id !== LOCAL || macCloudReady())
            : provider === "acp-cursor" && id !== cursorInCloud;
        let picked: Awaited<ReturnType<typeof useAccount>>;
        try {
          picked = await useAccount(provider, id, cloud, threadId);
        } catch (error) {
          telemetry.switched({
            ...before,
            outcome: "failed",
            code: errorCode(error),
            ms: Date.now() - startedAt,
          });
          throw error;
        }
        telemetry.switched({
          ...before,
          outcome: "ok",
          code: null,
          ms: Date.now() - startedAt,
        });
        if (picked.following && cloudMoves)
          void picked.following.then(
            (failed) => telemetry.cloudSwitched(provider, startedAt, failed),
            (error: unknown) =>
              telemetry.cloudSwitched(provider, startedAt, error ?? "failed"),
          );
        return null;
      },
      "accounts.move": async ({ provider, id, direction }) => {
        if (provider === "codex") {
          await codex({ action: "move", id: stored(id), direction });
          return null;
        }
        const before = [...order[provider]];
        move(
          id,
          ids(provider).indexOf(id) + (direction === "up" ? -1 : 1),
          provider,
        );
        if (
          provider === "claude-code" &&
          current(provider) === LOCAL &&
          macNeedsCloud()
        ) {
          order[provider] = before;
          throw new Error(MAC_NEEDS_CLOUD);
        }
        if (provider === "acp-antigravity")
          await placeAgy().catch((error: unknown) => {
            order[provider] = before;
            throw error;
          });
        await changed(true);
        return null;
      },
      "accounts.remove": async ({ provider, id }) => {
        const others = ids("claude-code").filter((entry) => entry !== id && entry !== LOCAL);
        if (
          provider === "claude-code" &&
          id === current(provider) &&
          others.length === 0 &&
          !macCloudReady() &&
          (cloudPending ?? inCloud) === id
        )
          throw new Error(
            "Cloud still runs on this account. Use your Mac's Claude login first (one approval), or Disconnect Claude Code.",
          );
        await remove(provider, id);
        return null;
      },
      "accounts.clear": async ({ provider }) => {
        // The account in use goes last, so Cloud never switches to another one on the way.
        const added = (await views(provider))
          .filter((view) => view.id !== LOCAL)
          .sort((a, b) => Number(a.inUse) - Number(b.inUse));
        for (const view of added) await remove(provider, view.id);
        // Disconnect also removes local records kept because startup couldn't read every record.
        const gone = [...accounts, ...unreadable].filter((entry) => Reflect.get(Object(entry), "provider") === provider);
        const named = (entry: unknown, key: string) => {
          const value: unknown = Reflect.get(Object(entry), key);
          return typeof value === "string" && /^[\w-]+$/.test(value) ? value : null;
        };
        accounts = accounts.filter((entry) => entry.provider !== provider);
        unreadable = unreadable.filter((entry) => !gone.includes(entry));
        for (const entry of gone) {
          const profile = named(entry, "profile");
          const id = named(entry, "id");
          if (profile) await dropProfile(profile);
          if (id && id !== LOCAL) await dropSecret(id);
        }
        if (gone.length > 0) await changed();
        for (const key of Object.keys(localNames))
          if (key.startsWith(`${provider} `)) delete localNames[key];
        await saveLocalNames();
        // Disconnect signs Claude out in Cloud too, so the Mac's Cloud token goes as well.
        if (provider === "claude-code") {
          macCloud = null;
          inCloud = null;
          cloudStale = false;
          await dropSecret(LOCAL);
          await kv.set("mac-cloud:v1", null);
          await kv.set("cloud:v1", null);
          await kv.set("cloud-stale:v1", false);
        }
        return null;
      },
      "accounts.rename": async ({ provider, id, name }) => {
        if (id === LOCAL) {
          const login = await thisLogin(provider);
          if (login === null) throw new Error("This login has no email to name.");
          const key = `${provider} ${login}`;
          if (name.trim()) localNames[key] = name.trim();
          else delete localNames[key];
          await saveLocalNames();
          room.realtime.publish(ACCOUNTS_CHANGED, {});
          return null;
        }
        if (provider === "codex") {
          await codex({ action: "rename", id: stored(id), name });
          return null;
        }
        const account = accounts.find(
          (entry) => entry.provider === provider && entry.id === id,
        );
        if (!account) throw new Error("This account is no longer connected.");
        account.name = name.trim() || null;
        await changed();
        return null;
      },
      "claude.start": async (input) => {
        const add = {
          kind: (input?.mac ? "approve_mac" : input?.id ? "sign_in_again" : "new") as AddKind,
          startedAt: Date.now(),
        };
        // The Mac's own login needs only the one-year token; any other account starts with its full login.
        const step = input?.mac ? "token" : "login";
        telemetry.add("claude-code", add, "started", step);
        try {
          return await startClaude(input, add);
        } catch (error) {
          telemetry.add("claude-code", add, "failed", step, error);
          throw error;
        }
      },
      "claude.poll": async ({ sessionId }) => {
        const state = adding.get(sessionId);
        if (!state)
          return {
            status: "error" as const,
            message: "This sign-in expired. Start again.",
            authorizeUrl: null,
          };
        const pending = {
          status: "pending" as const,
          message: null,
          authorizeUrl: state.url ?? null,
        };
        if (state.busy) return pending;
        state.busy = true;
        try {
          const result = claudeLogin.poll(state.login);
          if (!result) return pending;
          if (state.mac) {
            adding.delete(sessionId);
            await saveMac(result);
            telemetry.add("claude-code", state, "done", "token");
            return { status: "complete" as const, message: null, authorizeUrl: null };
          }
          if (!state.account) {
            const signedIn = await profileAccount(profilePath(state.profile!));
            // A plain add of an account already here would only refresh it, and no row appears (#2547).
            if (
              !state.replace &&
              accounts.some(
                (entry) =>
                  entry.provider === "claude-code" &&
                  signedIn.orgId !== null &&
                  entry.org === signedIn.orgId &&
                  entry.email === signedIn.email,
              )
            )
              throw new Error(
                `${signedIn.email ?? "This Claude account"} is already added. Sign out of claude.ai or use a private window, then try again.`,
              );
            state.account = signedIn;
            const next = await claudeLogin.start();
            state.login = next.sessionId;
            state.url = next.authorizeUrl;
            telemetry.add("claude-code", state, "step_done", "login");
            return { ...pending, authorizeUrl: next.authorizeUrl };
          }
          adding.delete(sessionId);
          await save(state, result);
          telemetry.add("claude-code", state, "done", "token");
          return { status: "complete" as const, message: null, authorizeUrl: null };
        } catch (error) {
          telemetry.add(
            "claude-code",
            state,
            "failed",
            state.mac || state.account ? "token" : "login",
            error,
          );
          adding.delete(sessionId);
          if (state.profile) void dropProfile(state.profile);
          return {
            status: "error" as const,
            message: error instanceof Error ? error.message : String(error),
            authorizeUrl: null,
          };
        } finally {
          state.busy = false;
        }
      },
      "antigravity.start": async () => {
        const add = { kind: "new" as const, startedAt: Date.now() };
        telemetry.add("acp-antigravity", add, "started", "login");
        try {
          return await startAntigravity();
        } catch (error) {
          telemetry.add("acp-antigravity", add, "failed", "login", error);
          throw error;
        }
      },
      "antigravity.complete": async ({ sessionId, code }) => {
        const add = {
          kind: "new" as const,
          startedAt: agyAdds.get(sessionId)?.startedAt ?? Date.now(),
        };
        try {
          await completeAntigravity(sessionId, code);
        } catch (error) {
          telemetry.add("acp-antigravity", add, "failed", "login", error);
          throw error;
        }
        telemetry.add("acp-antigravity", add, "done", "login");
        return null;
      },
      "antigravity.cancel": async ({ sessionId }) => {
        const id = agyAdds.get(sessionId)?.id;
        agyAdds.delete(sessionId);
        agyLogin.cancel(sessionId);
        if (id) await fs.rm(agyHome(id), { recursive: true, force: true });
        return null;
      },
      // Cursor's one step is the key, so it sends no `started`.
      "cursor.add": async ({ apiKey }) => {
        const add = { kind: "new" as const, startedAt: Date.now() };
        try {
          await addCursor(apiKey);
        } catch (error) {
          telemetry.add("acp-cursor", add, "failed", "key", error);
          throw error;
        }
        telemetry.add("acp-cursor", add, "done", "key");
        return null;
      },
      "codex.start": async () => {
        const add = { kind: "new" as const, startedAt: Date.now() };
        telemetry.add("codex", add, "started", "device");
        try {
          const started = codexStartSchema.parse(
            await room.sdk.cloudroom.codexAccounts({ action: "start" }),
          );
          codexAdds.set(started.sessionId, add);
          return started;
        } catch (error) {
          telemetry.add("codex", add, "failed", "device", error);
          throw error;
        }
      },
      "codex.poll": async ({ sessionId }) => {
        const polled = codexPollSchema.parse(
          await room.sdk.cloudroom.codexAccounts({ action: "poll", sessionId }),
        );
        const add = codexAdds.get(sessionId);
        if (add && polled.status !== "pending") {
          codexAdds.delete(sessionId);
          telemetry.add(
            "codex",
            add,
            polled.status === "complete" ? "done" : "failed",
            "device",
            polled.message,
          );
        }
        if (polled.status === "complete")
          room.realtime.publish(ACCOUNTS_CHANGED, {});
        return polled;
      },
    },
    {
      experimental_discoverable: true,
      experimental_description:
        "Several subscriptions per provider (Claude Code, Codex, Cursor). accounts.list returns one provider's accounts in order, with usage and which one is in use.",
    },
  );

  room.providers.experimental_contributeEnv(
    "claude-code",
    async (context: { threadId?: string; hostId?: string }) => {
      // Another machine runs on its own login unless it gets an account's one-year token below (#531).
      const [remote, threadId] = await Promise.all([
        onAnotherMachine(context.hostId),
        newTurn(context.threadId),
      ]);
      noteOwnLogin(threadId, remote);
      await refreshMac();
      const id = current("claude-code");
      noteThreadAccount(threadId, "claude-code", id);
      const account = accounts.find((entry) => entry.id === id);
      if (!account) return [];
      const reason = `Cloudroom account ${account.email ?? account.id}`;
      if (account.profile) {
        // The account's folder exists only on this computer.
        if (remote) return [];
        const profile = profilePath(account.profile);
        await prepareProfile(profile).catch((error: unknown) =>
          room.log.warn(
            `Claude account folder not refreshed: ${error instanceof Error ? error.message : String(error)}`,
          ),
        );
        await startMcpSync(profile, (error: unknown) =>
          room.log.warn(
            `MCP sign-ins not copied to Claude account: ${error instanceof Error ? error.message : String(error)}`,
          ),
        );
        return [
          { name: "CLAUDE_CONFIG_DIR", value: profile, reason },
          { name: "CLAUDE_CODE_OAUTH_TOKEN", value: "", reason },
          { name: "CLAUDE_CODE_SUBSCRIPTION_TYPE", value: "", reason },
          { name: "CLAUDE_SECURESTORAGE_CONFIG_DIR", value: "", reason },
          { name: "ANTHROPIC_API_KEY", value: "", reason },
        ];
      }
      const secret = await readSecret(account.id).catch(() => null);
      if (!secret) return [];
      noteOwnLogin(threadId, false);
      return [
        { name: "CLAUDE_CODE_OAUTH_TOKEN", value: secret.accessToken, reason },
        { name: "ANTHROPIC_API_KEY", value: "", reason },
      ];
    },
  );

  room.providers.experimental_contributeEnv(
    "acp-cursor",
    async (context: { threadId?: string }) => {
      const id = current("acp-cursor");
      noteThreadAccount(await newTurn(context.threadId), "acp-cursor", id);
      const account = accounts.find((entry) => entry.id === id);
      const key = account ? await readCursorKey(account).catch(() => null) : null;
      if (!account || !key) return [];
      const reason = `Cloudroom account ${account.email ?? account.id}`;
      return Object.entries(cursorEnv(key)).map(([name, value]) => ({
        name,
        value,
        reason,
      }));
    },
  );

  // An added Antigravity account runs agy in file-login mode, reading the login placeAgy put in place.
  room.providers.experimental_contributeEnv(
    "acp-antigravity",
    async (context: { threadId?: string; hostId?: string }) => {
      const id = current("acp-antigravity");
      // Another machine runs on its own agy login: the account's file is only on this computer.
      if (await onAnotherMachine(context.hostId)) return [];
      noteThreadAccount(await newTurn(context.threadId), "acp-antigravity", id);
      if (id === LOCAL) return [];
      // A login that can't be put in place (another one sits in its file) leaves the turn on this computer's own.
      const placed = await placeAgy().then(
        () => true,
        (error: unknown) => {
          room.log.warn(`Antigravity account not used: ${error instanceof Error ? error.message : String(error)}`);
          return false;
        },
      );
      if (!placed) return [];
      const account = accounts.find((entry) => entry.id === id);
      const reason = `Cloudroom account ${account?.email ?? id}`;
      // The account's id changes the env on every switch, so a running agy restarts on the new login.
      return Object.entries({ ...AGY_FILE_LOGIN, CLOUDROOM_ANTIGRAVITY_ACCOUNT: id }).map(([name, value]) => ({
        name,
        value,
        reason,
      }));
    },
  );

  room.events.on("turn.failed", async (event) => {
    const category = event.errorInfo?.category;
    if (category !== "rate-limit" && category !== "unauthorized") return;
    const thread = await room.sdk.threads
      .get({ threadId: event.threadId })
      .catch(() => null);
    // Claude couldn't authenticate a Local turn on an account's full login, even after renewing it ("OAuth session
    // expired and could not be refreshed"): that login needs Sign in again (#1979). Cloud threads use the one-year
    // token, and an organization block is no login problem.
    if (category === "unauthorized") {
      const account = accounts.find(
        (entry) => entry.id === threadAccount.get(event.threadId)?.id,
      );
      if (
        account?.profile &&
        event.errorInfo?.providerCode !== "oauth_org_not_allowed" &&
        thread?.providerId === "claude-code" &&
        thread.executionTarget !== "cloud" &&
        !onOwnLogin(thread)
      )
        await noteLoginFailed(account.id, Date.now());
      return;
    }
    const provider = providerSchema.safeParse(thread?.providerId);
    if (!provider.success || cloudAgy(thread)) return;
    // The machine's own login hit its limit: no account here is limited, and no switch here moves the thread.
    if (onOwnLogin(thread)) return;
    // Local turns started before plugin startup have no known account. Cloud uses the selected login.
    const observed = threadAccount.get(event.threadId);
    const ran = observed?.key.startsWith(`${provider.data}:`) ? observed : undefined;
    const used = ran?.id ?? current(provider.data);
    const several =
      provider.data === "codex"
        ? codexAccounts > 0
        : ids(provider.data).length > 1;
    if (
      (ran !== undefined || thread?.executionTarget === "cloud") &&
      (used !== LOCAL || several)
    ) {
      const key = ran?.key ?? limitKey(provider.data, used);
      limits[key] = limitMark(event.rateLimits, usage.get(used)?.windows);
      limitedAt.set(key, Date.now());
      // Start the baseline read before publishing the rejection to open panels.
      const account = accounts.find((entry) => entry.id === used);
      if (provider.data === "claude-code" && used === LOCAL && mac && key === limitKey("claude-code", LOCAL))
        background(refreshUsage(LOCAL, true, "failure"));
      else if (account?.profile) background(refreshUsage(account, true, "failure"));
      await changed();
    }
    // Core continues Cloud threads on a new login (ADR 0117).
    if (thread?.executionTarget === "cloud") return;
    // Noted even with one account: adding and picking a second one continues it too.
    await limited.record(
      event.threadId,
      provider.data,
      used,
      event.requestId,
    );
    const now = current(provider.data);
    // It ran on an account the user already switched away from: it continues on the new one at once.
    if (used !== now && limitedUntil(provider.data, now) === null)
      await limited.resume(event.threadId, now);
  });

  // A thread that runs again, or is gone, no longer waits for a switch.
  for (const name of [
    "thread.active",
    "thread.archived",
    "thread.deleted",
  ] as const)
    room.events.on(name, ({ thread }) => limited.forget(thread.id));

  // A turn that began after the limit and ended fine: the account works again, as after a limit reset from Claude.
  // A turn already running when the limit hit proves nothing, so it never clears it.
  room.events.on("thread.active", ({ thread }) => {
    turnBegan.set(thread.id, Date.now());
    if (thread.executionTarget === "cloud" && thread.providerId === "claude-code")
      noteThreadAccount(thread.id, "claude-code", current("claude-code"));
  });
  room.events.on("thread.failed", ({ thread }) => {
    turnBegan.delete(thread.id);
  });
  room.events.on("thread.idle", async ({ thread }) => {
    const began = turnBegan.get(thread.id);
    turnBegan.delete(thread.id);
    const provider = providerSchema.safeParse(thread.providerId);
    if (began === undefined || !provider.success || cloudAgy(thread) || onOwnLogin(thread)) return;
    // A Local turn on an account's full login that began after the login failed, and ended fine: it works again.
    const observed = threadAccount.get(thread.id);
    const ran = observed?.key.startsWith(`${provider.data}:`) ? observed : undefined;
    if (
      ran !== undefined &&
      thread.executionTarget !== "cloud" &&
      began > (loginFailed[ran.id] ?? Infinity)
    )
      await noteLoginFailed(ran.id, undefined);
    const used = ran?.id ?? current(provider.data);
    const key = ran?.key ?? limitKey(provider.data, used);
    if (!(key in limits) || began <= (limitedAt.get(key) ?? 0)) return;
    const mark = limits[key];
    if (typeof mark === "object" && (mark.windowKey === "overage" || mark.windowKey.startsWith("seven_day_"))) {
      // Success on another model or on the base plan cannot clear a model or spending limit.
      const account = accounts.find((entry) => entry.id === used);
      if (used === LOCAL && mac) background(refreshUsage(LOCAL, true));
      else if (account) background(refreshUsage(account, true));
      return;
    }
    delete limits[key];
    limitedAt.delete(key);
    await kv.set("limits:v1", limits);
    room.realtime.publish(ACCOUNTS_CHANGED, {});
    // Read the bars recorded at failure again for the login that actually recovered.
    const account = accounts.find((entry) => entry.id === used);
    if (account?.profile) background(refreshUsage(account, true));
    else if (used === LOCAL && key === limitKey("claude-code", LOCAL) && provider.data === "claude-code" && mac)
      background(refreshUsage(LOCAL, true));
  });

  // Codex signs in from the app (codex-accounts.ts); this only notes which account each thread starts on.
  room.providers.experimental_contributeEnv(
    "codex",
    async (context: { threadId?: string }) => {
      // Read the account before the await, so a switch during it can't note the new one for this turn.
      const id = codexInUse;
      noteThreadAccount(await newTurn(context.threadId), "codex", id);
      return [];
    },
  );
}
