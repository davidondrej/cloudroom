import { randomUUID } from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import type { BbPluginApi, PluginTurnFailedEvent } from "@get-bb/plugin-sdk";
import { z } from "zod";
import {
  ClaudeLogin,
  claudeSecret,
  claudeUsage,
  localClaudeEmail,
  profileAccount,
  signOut,
  tokenOrganization,
} from "./src/claude.js";
import {
  codexListSchema,
  codexPollSchema,
  codexStartSchema,
  localCodexEmail,
} from "./src/codex.js";
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
import { prepareProfile } from "./src/profile.js";
import { SignInAgainError, type Secret, type SignedIn } from "./src/tokens.js";

const USAGE_EVERY_MS = 5 * 60_000;
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
const secretSchema = z.object({
  accessToken: z.string(),
  refreshToken: z.string(),
  expiresAt: z.number().nullable(),
  idToken: z.string().optional(),
  issuedAt: z.number().optional(),
});
type Adding = {
  login: string;
  profile: string;
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
    await signOut(profilePath(profile));
    await fs.rm(profilePath(profile), { recursive: true, force: true });
  };
  let accounts = z
    .array(storedSchema)
    .catch([])
    .parse(await kv.get("accounts:v1"));
  // Codex accounts moved to the website, which renews them for Local and Cloud threads (ADR 0195). The ones this Mac
  // kept sign in again (docs/scopes/multiple-subscriptions.md, decision 14).
  const moved = accounts.filter((account) => account.provider === "codex");
  if (moved.length > 0) {
    accounts = accounts.filter((account) => account.provider !== "codex");
    await Promise.all(
      moved.map((account) => fs.rm(secretPath(account.id), { force: true })),
    );
    await kv.set("accounts:v1", accounts);
  }
  const order = z
    .object({ "claude-code": z.array(z.string()) })
    .catch({ "claude-code": [LOCAL] })
    .parse(await kv.get("order:v1"));
  const limits = z
    .record(z.string(), z.number())
    .catch({})
    .parse(await kv.get("limits:v1"));
  let inCloud = z.string().nullable().catch(null).parse(await kv.get("cloud:v1"));
  const usage = new Map<string, Usage>();
  const threadAccount = new Map<string, string>();
  const claudeLogin = new ClaudeLogin();
  const adding = new Map<string, Adding>();
  void fs.readdir(profilesDir).then(
    (found) =>
      Promise.all(
        found
          .filter((profile) => !accounts.some((entry) => entry.profile === profile))
          .map(dropProfile),
      ),
    () => {},
  );
  let codexInUse = LOCAL;
  let codexAccounts = 0;

  const changed = async () => {
    await Promise.all([
      kv.set("accounts:v1", accounts),
      kv.set("order:v1", order),
      kv.set("limits:v1", limits),
    ]);
    bb.realtime.publish(ACCOUNTS_CHANGED, {});
    void followInCloud();
  };
  const ids = (): string[] => {
    const saved = accounts.map((account) => account.id);
    const kept = order["claude-code"].filter(
      (id) => id === LOCAL || saved.includes(id),
    );
    order["claude-code"] = [
      ...(kept.includes(LOCAL) ? [] : [LOCAL]),
      ...kept,
      ...saved.filter((id) => !kept.includes(id)),
    ];
    // Claude's own Mac login has no one-year token, so Cloud can't follow it (ADR 0197).
    return saved.length > 0
      ? order["claude-code"].filter((id) => id !== LOCAL)
      : order["claude-code"];
  };
  // The top account is the one every thread uses (ADR 0197).
  const current = (provider: Provider): string =>
    provider === "codex" ? codexInUse : (ids()[0] ?? LOCAL);
  const limitedUntil = (provider: Provider, id: string): number | null => {
    const until = limits[`${provider}:${id}`];
    return until !== undefined && until > Date.now() ? until : null;
  };

  const writeSecret = async (id: string, secret: Secret) => {
    const temp = `${secretPath(id)}.${randomUUID()}.tmp`;
    await fs.writeFile(temp, JSON.stringify(secret), { mode: 0o600 });
    await fs.rename(temp, secretPath(id));
  };
  const readSecret = async (account: Stored): Promise<Secret> =>
    secretSchema.parse(
      JSON.parse(await fs.readFile(secretPath(account.id), "utf8")),
    );
  // Cloud keeps one Claude login per user, so it follows the account in use (ADR 0197).
  const followInCloud = async () => {
    const id = current("claude-code");
    const account = accounts.find((entry) => entry.id === id);
    if (!account || id === inCloud) return;
    try {
      const secret = await readSecret(account);
      await bb.sdk.cloudroom.claudeAuth({
        action: "token",
        requestId: randomUUID(),
        token: secret.accessToken,
        ...(account.plan ? { plan: account.plan } : {}),
      });
      inCloud = id;
      await kv.set("cloud:v1", id);
    } catch (error) {
      bb.log.warn(
        `Cloud could not switch Claude accounts: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
  };

  const refreshUsage = async (account: Stored, force = false) => {
    const previous = usage.get(account.id);
    if (!force && previous && Date.now() - previous.at < USAGE_EVERY_MS) return;
    const before = previous?.error ?? null;
    try {
      usage.set(account.id, {
        ...(await claudeUsage(await readSecret(account))),
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
  // so only the account in use is checked in the background.
  const refreshAll = (force = false) =>
    Promise.all(
      accounts
        .filter((account) => account.id === current("claude-code"))
        .map((account) => refreshUsage(account, force)),
    );
  const timer = setInterval(() => void refreshAll(), USAGE_EVERY_MS);
  timer.unref();
  bb.onDispose(() => clearInterval(timer));
  void refreshAll();

  const add = async (
    signedIn: SignedIn,
    use: boolean,
    login: Pick<Stored, "profile" | "org">,
  ) => {
    if (ids().length >= MAX_ACCOUNTS)
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
    accounts = [...accounts, account];
    ids();
    if (use) move(account.id, 0);
    await changed();
    void refreshUsage(account, true);
  };

  const claudeView = async (): Promise<AccountView[]> => {
    const using = current("claude-code");
    const localEmail = await localClaudeEmail();
    const rows: AccountView[] = ids().map((id) => {
      const account = accounts.find((entry) => entry.id === id);
      const measured = usage.get(id);
      return {
        id,
        name: account?.name ?? null,
        email: id === LOCAL ? localEmail : (account?.email ?? null),
        plan: account?.plan ?? null,
        inUse: id === using,
        limitedUntil: limitedUntil("claude-code", id),
        error: measured?.error ?? null,
        credits: id === using ? (measured?.credits ?? null) : null,
        // Accounts not in use aren't checked, so a window past its reset shows empty.
        windows: (measured?.windows ?? []).map((window) =>
          window.resetsAt !== null && window.resetsAt <= Date.now()
            ? { ...window, usedPercent: 0, resetsAt: null }
            : window,
        ),
        needsSignIn: false,
        limitedLogin: account !== undefined && !account.profile,
      };
    });
    // Keep the Mac's Claude login visible until it is added again (ADR 0197).
    const macAdded = accounts.some((entry) => entry.email === localEmail);
    if (localEmail && !rows.some((row) => row.id === LOCAL) && !macAdded)
      rows.unshift({
        id: LOCAL,
        name: null,
        email: localEmail,
        plan: null,
        inUse: false,
        limitedUntil: null,
        error: null,
        credits: null,
        windows: [],
        needsSignIn: true,
        limitedLogin: false,
      });
    return rows;
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
        windows: [],
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
  const move = (id: string, to: number) => {
    const list = ids().filter((entry) => entry !== id);
    list.splice(Math.max(0, Math.min(list.length, to)), 0, id);
    order["claude-code"] = list;
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
          entry.org === account.orgId && entry.email === account.email,
      );
    if (!existing)
      return add(
        { email: account.email, plan: account.plan, accountKey: null, secret },
        state.mac,
        { profile: state.profile, org: account.orgId },
      );
    // A revoked token can't name its account; anything else unconfirmed keeps the saved login.
    const before =
      existing.org ??
      (await readSecret(existing)
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
    if (existing.id === inCloud) inCloud = null;
    if (state.mac) move(existing.id, 0);
    await changed();
    void refreshUsage(existing, true);
  };

  bb.rpc.register(
    accountsRpcContract,
    {
      "accounts.list": ({ provider }) =>
        provider === "codex" ? codexView() : claudeView(),
      "accounts.use": async ({ provider, id }) => {
        delete limits[`${provider}:${id}`];
        if (provider === "codex") {
          await codex({ action: "use", id: id === LOCAL ? null : id });
          await kv.set("limits:v1", limits);
          return null;
        }
        move(id, 0);
        await changed();
        const account = accounts.find((entry) => entry.id === id);
        if (account) void refreshUsage(account, true);
        return null;
      },
      "accounts.move": async ({ provider, id, direction }) => {
        if (provider === "codex") {
          await codex({ action: "move", id: stored(id), direction });
          return null;
        }
        move(id, ids().indexOf(id) + (direction === "up" ? -1 : 1));
        await changed();
        return null;
      },
      "accounts.remove": async ({ provider, id }) => {
        stored(id);
        delete limits[`${provider}:${id}`];
        if (provider === "codex") {
          await codex({ action: "remove", id });
          await kv.set("limits:v1", limits);
          return null;
        }
        const removed = accounts.find((account) => account.id === id);
        if (removed?.profile) void dropProfile(removed.profile);
        accounts = accounts.filter((account) => account.id !== id);
        order["claude-code"] = order["claude-code"].filter(
          (entry) => entry !== id,
        );
        usage.delete(id);
        await fs.rm(secretPath(id), { force: true });
        await changed();
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
        const replace = input?.id ? stored(input.id) : null;
        const profile = randomUUID();
        try {
          await prepareProfile(profilePath(profile));
          const started = await claudeLogin.start(profilePath(profile));
          adding.set(started.sessionId, {
            login: started.sessionId,
            profile,
            replace,
            mac: input?.mac ?? false,
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
          if (!state.account) {
            state.account = await profileAccount(profilePath(state.profile));
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
          void dropProfile(state.profile);
          return {
            status: "error" as const,
            message: error instanceof Error ? error.message : String(error),
            authorizeUrl: null,
          };
        } finally {
          state.busy = false;
        }
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
        "Several subscriptions per provider. accounts.list returns one provider's accounts in order, with usage and which one is in use.",
    },
  );

  bb.providers.experimental_contributeEnv(
    "claude-code",
    async (context: { threadId: string }) => {
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
      const secret = await readSecret(account).catch(() => null);
      if (!secret) return [];
      return [
        { name: "CLAUDE_CODE_OAUTH_TOKEN", value: secret.accessToken, reason },
        { name: "ANTHROPIC_API_KEY", value: "", reason },
      ];
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
      provider.data === "codex" ? codexAccounts > 0 : ids().length > 1;
    if (used === LOCAL && !several) return;
    limits[`${provider.data}:${used}`] =
      blockedUntil(event.rateLimits) ?? Date.now() + DEFAULT_REST_MS;
    await changed();
  });
}
