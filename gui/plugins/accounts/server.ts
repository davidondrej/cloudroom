import { randomUUID } from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import type { BbPluginApi, PluginTurnFailedEvent } from "@get-bb/plugin-sdk";
import { z } from "zod";
import { COMPUTER_TITLE } from "@cloudroom/domain/computer-name";
import {
  ClaudeLogin,
  claudeSecret,
  claudeUsage,
  localClaudeAccount,
  profileAccount,
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
  type AccountView,
  type Provider,
  type UsageWindow,
} from "./src/contract.js";
import { limitedThreads } from "./src/limited-threads.js";
import { prepareProfile, releaseProfile } from "./src/profile.js";
import { SignInAgainError, type Secret, type SignedIn } from "./src/tokens.js";

const USAGE_EVERY_MS = 5 * 60_000;
const MAC_NEEDS_CLOUD =
  "Approve this Mac's Claude account for Cloud first: click Use on it in Settings → Agents → Accounts.";
const DEFAULT_REST_MS = 60 * 60_000;

const storedSchema = z.object({
  id: z.string(),
  provider: providerSchema,
  name: z.string().nullish(),
  email: z.string().nullable(),
  plan: z.string().nullable(),
  accountKey: z.string().nullable(),
  // The account's own Claude folder with its full login (claude.ai connectors); older accounts have only the one-year token.
  profile: z.string().nullish(),
  org: z.string().nullish(),
  createdAt: z.number(),
});
type Stored = z.infer<typeof storedSchema>;
// Providers whose accounts this Mac stores, in the order the user set. Codex accounts live on the website (ADR 0195).
type Ordered = "claude-code" | "acp-cursor";
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
};
type Usage = {
  windows: UsageWindow[];
  credits: { detail: string | null } | null;
  error: string | null;
  signInAgain: boolean;
  at: number;
};

function blockedUntil(
  rateLimits: PluginTurnFailedEvent["rateLimits"],
): number | null {
  const windows = rateLimits?.windows ?? [];
  const blocked = windows.filter((window) => window.status === "blocked");
  const resets = (blocked.length > 0 ? blocked : windows).flatMap((window) =>
    window.resetsAtMs === null ? [] : [window.resetsAtMs],
  );
  return resets.length === 0 ? null : Math.max(...resets);
}

export default async function plugin(bb: BbPluginApi) {
  const kv = bb.storage.kv;
  const secretsDir = path.join(
    bb.server.experimental_dataDir,
    "plugins",
    bb.pluginId,
    "secrets",
  );
  await fs.mkdir(secretsDir, { recursive: true, mode: 0o700 });
  const secretPath = (id: string) => path.join(secretsDir, `${id}.json`);
  const profilesDir = path.join(path.dirname(secretsDir), "profiles");
  const profilePath = (profile: string) => path.join(profilesDir, profile);
  const dropProfile = async (profile: string) => {
    if (stillNamed("profile", profile)) return;
    try {
      await releaseProfile(profilePath(profile));
    } catch (error) {
      bb.log.warn(
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
    })
    .catch({ "claude-code": [LOCAL], "acp-cursor": [LOCAL] })
    .parse(await kv.get("order:v1"));
  const limits = z
    .record(z.string(), z.number())
    .catch({})
    .parse(await kv.get("limits:v1"));
  let inCloud = z.string().nullable().catch(null).parse(await kv.get("cloud:v1"));
  // The Mac's own Claude login, and the organization of the one-year token Cloud uses for it.
  let mac: MacClaude | null = (await localClaudeAccount()) ?? null;
  // Signing the Mac in or out can change the account in use; Cloud then follows it.
  const refreshMac = async () => {
    const read = await localClaudeAccount();
    if (read === undefined) return mac;
    const before = current("claude-code");
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
  let cloudQueue: Promise<unknown> = Promise.resolve();
  // Before Cursor accounts, Cloud used a copy of the Mac's own Cursor login.
  let cursorInCloud = z.string().catch(LOCAL).parse(await kv.get("cursor-cloud:v1"));
  const usage = new Map<string, Usage>();
  const threadAccount = new Map<string, string>();
  const claudeLogin = new ClaudeLogin(() =>
    bb.server.experimental_claudeSetupToken?.(),
  );
  const adding = new Map<string, Adding>();
  // An unreadable record may own any folder, so none is dropped then.
  if (unreadable.length === 0)
    void fs.readdir(profilesDir).then(
      (found) => Promise.all(found.map(dropProfile)),
      () => {},
    );
  let codexInUse = LOCAL;
  let codexAccounts = 0;

  // `connect` marks the user adding, picking, or moving an account, which connects Claude again (ADR 0327).
  const changed = async (connect = false) => {
    await Promise.all([
      kv.set("accounts:v1", [...accounts, ...unreadable]),
      kv.set("order:v1", order),
      kv.set("limits:v1", limits),
    ]);
    bb.realtime.publish(ACCOUNTS_CHANGED, {});
    return {
      cloud: followInCloud(connect),
      cursor: followCursorInCloud(),
      resumed: Promise.all([
        noteInUse("claude-code", current("claude-code")),
        noteInUse("acp-cursor", current("acp-cursor")),
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
    if (provider === "claude-code" && saved.length > 0 && !macShown())
      order[provider] = order[provider].filter((id) => id !== LOCAL);
    return order[provider];
  };
  // The top account is the one every thread uses (ADR 0197).
  const current = (provider: Provider): string =>
    provider === "codex" ? codexInUse : (ids(provider)[0] ?? LOCAL);
  const limitedUntil = (provider: Provider, id: string): number | null => {
    const until = limits[`${provider}:${id}`];
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
  const accountName = async (provider: Provider, id: string) => {
    const views = await (
      provider === "codex"
        ? codexView()
        : provider === "acp-cursor"
          ? cursorView()
          : claudeView()
    ).catch(() => []);
    const view = views.find((entry) => entry.id === id);
    return (
      view?.name ??
      view?.email ??
      (id === LOCAL ? `This ${COMPUTER_TITLE}` : "another account")
    );
  };
  const limited = await limitedThreads(bb, accountName);
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
    const id = current("claude-code");
    const account = accounts.find((entry) => entry.id === id);
    if (id === inCloud && !cloudStale) return null;
    if (!account && !(id === LOCAL && macCloudReady())) return null;
    const plan = account ? account.plan : macCloud?.plan;
    cloudPending = id;
    try {
      const secret = await readSecret(id);
      const switched = await cloudSwitch("claude-code", inCloud, id);
      const status = await bb.sdk.cloudroom.claudeAuth({
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
      cloudStale = false;
      await kv.set("cloud:v1", id);
      await kv.set("cloud-stale:v1", false);
      return null;
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      bb.log.warn(`Cloud could not switch Claude accounts: ${message}`);
      return message;
    } finally {
      cloudPending = null;
    }
  };
  const markStale = async () => {
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
      const status = await bb.sdk.cloudroom.cursorAccount({
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
      bb.log.warn(`Cloud could not switch Cursor accounts: ${message}`);
      return message;
    }
  };

  const refreshUsage = async (account: Stored, force = false) => {
    const previous = usage.get(account.id);
    if (!force && previous && Date.now() - previous.at < USAGE_EVERY_MS) return;
    const before = previous?.error ?? null;
    try {
      usage.set(account.id, {
        ...(account.provider === "acp-cursor"
          ? { windows: await cursorUsage(await readCursorKey(account)), credits: null }
          : await claudeUsage(
              await readSecret(account.id),
              account.profile ? profilePath(account.profile) : undefined,
              previous?.windows.length ? previous : undefined,
            )),
        error: null,
        signInAgain: false,
        at: Date.now(),
      });
    } catch (error) {
      usage.set(account.id, {
        windows: previous?.windows ?? [],
        credits: previous?.credits ?? null,
        error: error instanceof Error ? error.message : String(error),
        signInAgain: error instanceof SignInAgainError,
        at: Date.now(),
      });
    }
    const measured = usage.get(account.id);
    if (
      (measured?.error ?? null) !== before ||
      !measured?.credits !== !previous?.credits
    )
      await changed();
  };
  // A Claude check is a real 1-token reply that can open a 5-hour window,
  // so only the account in use is checked in the background. Cursor's usage is a plain read.
  const refreshAll = (force = false) =>
    Promise.all(
      accounts
        .filter(
          (account) =>
            account.provider === "acp-cursor" ||
            account.id === current("claude-code"),
        )
        .map((account) => refreshUsage(account, force)),
    );
  // A token Cloud hasn't confirmed yet is retried every few minutes, and at start.
  const timer = setInterval(() => {
    void refreshAll();
    if (cloudStale) void followInCloud(false);
  }, USAGE_EVERY_MS);
  if (cloudStale) void followInCloud(false);
  timer.unref();
  bb.onDispose(() => clearInterval(timer));
  void refreshAll();

  // Adding never switches accounts: the one in use stays in use.
  const add = async (
    signedIn: SignedIn,
    login: Pick<Stored, "profile" | "org">,
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
    void refreshUsage(account, true);
  };

  const rows = (provider: Ordered, localEmail: string | null): AccountView[] => {
    const using = current(provider);
    return ids(provider).map((id) => {
      const account = accounts.find((entry) => entry.id === id);
      const measured = usage.get(id);
      return {
        id,
        name: account?.name ?? null,
        email: id === LOCAL ? localEmail : (account?.email ?? null),
        plan: account?.plan ?? null,
        inUse: id === using,
        limitedUntil: limitedUntil(provider, id),
        error: measured?.error ?? null,
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
      };
    });
  };
  const claudeView = async (): Promise<AccountView[]> => {
    await refreshMac();
    const needsCloud = macNeedsCloud();
    return rows("claude-code", mac?.email ?? null).map((row) =>
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
        await bb.sdk.system
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
      if (changed) bb.realtime.publish(ACCOUNTS_CHANGED, {});
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
      result ?? (await bb.sdk.cloudroom.codexAccounts({ action: "list" })),
    );
    const selected = list.accounts.find((account) => account.inUse);
    codexInUse = selected?.id ?? LOCAL;
    codexAccounts = list.accounts.length;
    codexResumed = noteInUse("codex", codexInUse);
    void refreshCodexLocal();
    return [
      {
        id: LOCAL,
        name: null,
        email: await localCodexEmail(),
        plan: null,
        inUse: !selected,
        limitedUntil: limitedUntil("codex", LOCAL),
        error: null,
        credits: null,
        windows: codexLocal.windows,
        needsSignIn: false,
        limitedLogin: false,
      },
      ...list.accounts.map((account) => ({
        ...account,
        limitedUntil: limitedUntil("codex", account.id),
        needsSignIn: false,
        limitedLogin: false,
      })),
    ];
  };
  const codex = async (
    input: Parameters<typeof bb.sdk.cloudroom.codexAccounts>[0],
  ) => {
    const views = await codexView(await bb.sdk.cloudroom.codexAccounts(input));
    bb.realtime.publish(ACCOUNTS_CHANGED, {});
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
        { profile: state.profile, org: account.orgId },
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
    existing.profile = state.profile;
    existing.org = account.orgId;
    if (old) void dropProfile(old);
    // Cloud gets the new token on its next follow, even after a restart.
    if (existing.id === inCloud) await markStale();
    await changed(true);
    void refreshUsage(existing, true);
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
    void refreshUsage(account, true);
  };

  const remove = async (provider: Provider, id: string) => {
    stored(id);
    delete limits[`${provider}:${id}`];
    if (provider === "codex") {
      await codex({ action: "remove", id });
      await kv.set("limits:v1", limits);
      return;
    }
    const removed = accounts.find((account) => account.id === id);
    accounts = accounts.filter((account) => account.id !== id);
    if (removed?.profile) void dropProfile(removed.profile);
    order[provider] = order[provider].filter((entry) => entry !== id);
    usage.delete(id);
    await dropSecret(id);
    // Cloud can't follow the Mac's login without its approval, so the next added account goes in use.
    if (provider === "claude-code" && current(provider) === LOCAL && macNeedsCloud()) {
      const next = ids(provider).find((entry) => entry !== LOCAL);
      if (next) move(next, 0);
    }
    await changed();
  };

  bb.rpc.register(
    accountsRpcContract,
    {
      "accounts.list": ({ provider }) =>
        provider === "codex"
          ? codexView()
          : provider === "acp-cursor"
            ? cursorView()
            : claudeView(),
      "accounts.use": async ({ provider, id, cloud, threadId }) => {
        delete limits[`${provider}:${id}`];
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
          return null;
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
        move(id, 0, provider);
        const follow = await changed(true);
        const following = provider === "acp-cursor" ? follow.cursor : follow.cloud;
        const account = accounts.find((entry) => entry.id === id);
        if (account) void refreshUsage(account, true);
        await follow.resumed;
        const failed = cloud ? await following : null;
        if (failed) throw new Error(`Cloud didn't switch accounts: ${failed}`);
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
        const views =
          provider === "codex"
            ? await codexView()
            : provider === "acp-cursor"
              ? await cursorView()
              : await claudeView();
        // The account in use goes last, so Cloud never switches to another one on the way.
        const added = views
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
        if (provider === "codex") {
          await codex({ action: "rename", id: stored(id), name });
          return null;
        }
        const account = accounts.find((entry) => entry.id === id);
        if (!account) throw new Error("This account is no longer connected.");
        account.name = name.trim() || null;
        await changed();
        return null;
      },
      "claude.start": async (input) => {
        // The Mac's own login already runs Local threads: Cloud only needs its one-year token.
        if (input?.mac) {
          if (!(await refreshMac()))
            throw new Error(
              "Sign in to Claude Code on this Mac first: run `claude`.",
            );
          const started = await claudeLogin.start();
          adding.set(started.sessionId, {
            login: started.sessionId,
            replace: null,
            mac: true,
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
          });
          return started;
        } catch (error) {
          void dropProfile(profile);
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
            return { status: "complete" as const, message: null, authorizeUrl: null };
          }
          if (!state.account) {
            state.account = await profileAccount(profilePath(state.profile!));
            const next = await claudeLogin.start();
            state.login = next.sessionId;
            state.url = next.authorizeUrl;
            return { ...pending, authorizeUrl: next.authorizeUrl };
          }
          adding.delete(sessionId);
          await save(state, result);
          return { status: "complete" as const, message: null, authorizeUrl: null };
        } catch (error) {
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
      "cursor.add": async ({ apiKey }) => {
        await addCursor(apiKey);
        return null;
      },
      "codex.start": async () =>
        codexStartSchema.parse(
          await bb.sdk.cloudroom.codexAccounts({ action: "start" }),
        ),
      "codex.poll": async ({ sessionId }) => {
        const polled = codexPollSchema.parse(
          await bb.sdk.cloudroom.codexAccounts({ action: "poll", sessionId }),
        );
        if (polled.status === "complete")
          bb.realtime.publish(ACCOUNTS_CHANGED, {});
        return polled;
      },
    },
    {
      experimental_discoverable: true,
      experimental_description:
        "Several subscriptions per provider (Claude Code, Codex, Cursor). accounts.list returns one provider's accounts in order, with usage and which one is in use.",
    },
  );

  bb.providers.experimental_contributeEnv(
    "claude-code",
    async (context: { threadId: string }) => {
      await refreshMac();
      const id = current("claude-code");
      threadAccount.set(context.threadId, id);
      const account = accounts.find((entry) => entry.id === id);
      if (!account) return [];
      const reason = `Cloudroom account ${account.email ?? account.id}`;
      if (account.profile) {
        const profile = profilePath(account.profile);
        await prepareProfile(profile).catch((error: unknown) =>
          bb.log.warn(
            `Claude account folder not refreshed: ${error instanceof Error ? error.message : String(error)}`,
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
      return [
        { name: "CLAUDE_CODE_OAUTH_TOKEN", value: secret.accessToken, reason },
        { name: "ANTHROPIC_API_KEY", value: "", reason },
      ];
    },
  );

  bb.providers.experimental_contributeEnv(
    "acp-cursor",
    async (context: { threadId: string }) => {
      const id = current("acp-cursor");
      threadAccount.set(context.threadId, id);
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

  bb.events.on("turn.failed", async (event) => {
    if (event.errorInfo?.category !== "rate-limit") return;
    const thread = await bb.sdk.threads
      .get({ threadId: event.threadId })
      .catch(() => null);
    const provider = providerSchema.safeParse(thread?.providerId);
    if (!provider.success) return;
    // Cloud threads and Codex use the selected account, so they have no entry here.
    const used = threadAccount.get(event.threadId) ?? current(provider.data);
    const several =
      provider.data === "codex"
        ? codexAccounts > 0
        : ids(provider.data).length > 1;
    if (used !== LOCAL || several) {
      limits[`${provider.data}:${used}`] =
        blockedUntil(event.rateLimits) ?? Date.now() + DEFAULT_REST_MS;
      await changed();
      // A full login's usage read is free, so its bars show the limit right away instead of minutes later.
      const account = accounts.find((entry) => entry.id === used);
      if (account?.profile)
        void refreshUsage(account, true).then(() =>
          bb.realtime.publish(ACCOUNTS_CHANGED, {}),
        );
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
    bb.events.on(name, ({ thread }) => limited.forget(thread.id));

  // Codex signs in from the app (codex-accounts.ts); this only notes which account each thread starts on.
  bb.providers.experimental_contributeEnv(
    "codex",
    async (context: { threadId: string }) => {
      threadAccount.set(context.threadId, codexInUse);
      return [];
    },
  );
}
