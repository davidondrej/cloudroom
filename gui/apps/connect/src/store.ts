const CODE_ALPHABET = "ABCDEFGHJKMNPQRSTVWXYZ23456789";
const HANDLE_ALPHABET = "abcdefghjkmnpqrstvwxyz23456789";
const SERVER_CACHE_MS = 15_000;
const SEEN_WRITE_INTERVAL_MS = 60_000;
export const PHONE_CODE_TTL_MS = 10 * 60_000;
export const SHARE_CODE_TTL_MS = 60_000;
export const SESSION_TTL_MS = 365 * 24 * 60 * 60_000;
export const DESKTOP_SESSION_TTL_MS = 30 * 24 * 60 * 60_000;

/** Most Macs on one account, and remote hosts on one Mac. Past these, a new one is refused. */
export const MACS_PER_ACCOUNT = 100;
const MACHINES_PER_MAC = 20;

/**
 * Most sessions and codes of each kind one owner keeps (2026-11-07). Sessions last up to a year, so without these one
 * account could fill the relay's shared database. A new one past the limit ends the oldest of its own kind and owner,
 * never another kind. Each kind's rows all get the same lifetime, so the newest are the ones that expire last. The `?`
 * is the owner. Phone sessions last a year and Mac-to-Mac ones 30 days, which is how `hasPhone` tells them apart too.
 */
export const KEEP = {
  /** Phones signed in with the account at app.cloudroom.run (ADR 0268), per account. */
  phones: { table: "session", rows: "user_id = ? AND target IS NULL", newest: 100 },
  /** Port-share sign-ins, per account. Share codes carry the account (migration 0004). */
  shares: { table: "session", rows: "user_id = ? AND target IS NOT NULL", newest: 200 },
  /** Phones paired with a code from an older desktop app, per Mac. */
  pairedPhones: {
    table: "session",
    rows: `server_id = ? AND target IS NULL AND user_id IS NULL AND expires_at - created_at > ${DESKTOP_SESSION_TTL_MS}`,
    newest: 50,
  },
  /** The desktop app's sign-ins to another Mac, per Mac. Each desktop only uses the newest one it made, so another
   *  desktop's sign-in ends only after 200 newer ones to the same Mac. Then the desktop signs in again by itself. */
  macToMac: {
    table: "session",
    rows: `server_id = ? AND target IS NULL AND user_id IS NULL AND expires_at - created_at <= ${DESKTOP_SESSION_TTL_MS}`,
    newest: 200,
  },
  /** Unused phone codes, per account, so the code table (no owner index) stays small to scan. They carry no account, so
   *  it comes from their Mac. */
  phoneCodes: {
    table: "code",
    rows: "server_id IN (SELECT id FROM server WHERE user_id = ?) AND target IS NULL",
    newest: 20,
  },
  /** Unused port-share tickets, per account. */
  shareCodes: { table: "code", rows: "user_id = ? AND target IS NOT NULL", newest: 20 },
} as const;

/**
 * Goes in the same batch, after the insert of `added`. If that insert happened, it keeps `added` and the owner's newest
 * other rows of the kind up to the limit, and ends the rest. A failed insert (a wrong code) ends nothing.
 */
function keepNewest(db: D1Database, kind: keyof typeof KEEP, owner: string, added: string): D1PreparedStatement {
  const { table, rows, newest } = KEEP[kind];
  const key = table === "session" ? "token_hash" : "code_hash";
  return db
    .prepare(
      `DELETE FROM ${table} WHERE ${key} IN (SELECT ${key} FROM ${table} WHERE ${rows} AND ${key} <> ? AND EXISTS (SELECT 1 FROM ${table} WHERE ${key} = ?) ORDER BY expires_at DESC, ${key} DESC LIMIT -1 OFFSET ?)`,
    )
    .bind(owner, added, added, newest - 1);
}

export interface Server {
  id: string;
  userId: string;
  handle: string;
  credentialHash: string;
  lastSeenAt: number | null;
  name: string | null;
  /** Set for a remote host: the Mac it runs threads for. */
  ownerServerId: string | null;
  /** An account's own VPS (ADR 0319): not a Mac, and its ports pass straight to the VPS. */
  vps: boolean;
}

export interface Session {
  serverId: string;
  target: string | null;
  userId: string | null;
}

interface Cached<T> {
  value: T;
  expires: number;
}

const servers = new Map<string, Cached<Server | null>>();
const credentials = new Map<string, Cached<Server | null>>();
const seenWrites = new Map<string, number>();

/**
 * Caches finished lookups only, never a pending one. A pending lookup belongs to the request that started it. When that
 * request is canceled (the app aborts one on every keystroke), Cloudflare drops its lookup and its timers, so every
 * other request waiting on it hung until the app gave up: up to 30 minutes, sends included (2026-11-10).
 */
async function cached<T>(
  map: Map<string, Cached<T>>,
  key: string,
  ttl: number,
  load: () => Promise<T>,
  fresh = false,
): Promise<T> {
  const hit = map.get(key);
  if (!fresh && hit && hit.expires > Date.now()) return hit.value;
  const dropsBefore = drops;
  const value = await load();
  if (drops === dropsBefore) map.set(key, { value, expires: Date.now() + ttl });
  return value;
}

/** Counts every `drop`. A lookup that started before one may hold the old row, so it is not saved. */
let drops = 0;

/** Forgets a Mac or host whose row just changed (revoked, signed out, new key). */
function drop(map: Map<string, Cached<Server | null>>, key: string): void {
  drops += 1;
  map.delete(key);
}

function randomString(alphabet: string, length: number): string {
  const bytes = crypto.getRandomValues(new Uint8Array(length));
  return [...bytes].map((byte) => alphabet[byte % alphabet.length]).join("");
}

function randomToken(): string {
  return [...crypto.getRandomValues(new Uint8Array(32))]
    .map((byte) => byte.toString(16).padStart(2, "0"))
    .join("");
}

export async function sha256Hex(value: string): Promise<string> {
  const digest = await crypto.subtle.digest(
    "SHA-256",
    new TextEncoder().encode(value),
  );
  return [...new Uint8Array(digest)]
    .map((byte) => byte.toString(16).padStart(2, "0"))
    .join("");
}

export function normalizeCode(raw: string): string | null {
  const code = raw.toUpperCase().replace(/[^A-Z0-9]/g, "");
  return code.length === 8 && [...code].every((c) => CODE_ALPHABET.includes(c))
    ? code
    : null;
}

export function formatCode(code: string): string {
  return `${code.slice(0, 4)}-${code.slice(4)}`;
}

interface ServerRow {
  id: string;
  user_id: string;
  handle: string;
  credential_hash: string;
  last_seen_at: number | null;
  name?: string | null;
  owner_server_id?: string | null;
  kind?: string | null;
}

function toServer(row: ServerRow | null): Server | null {
  return row
    ? {
        id: row.id,
        userId: row.user_id,
        handle: row.handle,
        credentialHash: row.credential_hash,
        lastSeenAt: row.last_seen_at,
        name: row.name ?? null,
        ownerServerId: row.owner_server_id ?? null,
        vps: row.kind === "vps",
      }
    : null;
}

export function serverByHandle(
  db: D1Database,
  handle: string,
  fresh = false,
): Promise<Server | null> {
  return cached(
    servers,
    handle,
    SERVER_CACHE_MS,
    async () =>
      toServer(
        await db
          .prepare("SELECT * FROM server WHERE handle = ?")
          .bind(handle)
          .first<ServerRow>(),
      ),
    fresh,
  );
}

export async function serverByCredential(
  db: D1Database,
  credential: string,
): Promise<Server | null> {
  if (!credential) return null;
  return toServer(
    await db
      .prepare("SELECT * FROM server WHERE credential_hash = ?")
      .bind(await sha256Hex(credential))
      .first<ServerRow>(),
  );
}

/** A remote host's credential, cached briefly because its daemon sends it on every request. */
export async function machineByCredential(
  db: D1Database,
  credential: string,
): Promise<Server | null> {
  if (!credential) return null;
  const hash = await sha256Hex(credential);
  return cached(credentials, hash, SERVER_CACHE_MS, async () =>
    toServer(
      await db
        .prepare("SELECT * FROM server WHERE credential_hash = ? AND owner_server_id IS NOT NULL")
        .bind(hash)
        .first<ServerRow>(),
    ),
  );
}

export async function serverById(db: D1Database, id: string): Promise<Server | null> {
  return toServer(
    await db.prepare("SELECT * FROM server WHERE id = ?").bind(id).first<ServerRow>(),
  );
}

/** Every Mac on one Cloudroom account, oldest first. Remote hosts are not Macs you switch to. */
export async function accountServers(db: D1Database, userId: string): Promise<Server[]> {
  const { results } = await db
    .prepare("SELECT * FROM server WHERE user_id = ? AND owner_server_id IS NULL AND kind IS NULL ORDER BY created_at")
    .bind(userId)
    .all<ServerRow>();
  return results.map((row) => toServer(row)!);
}

/** Adds a remote host for this Mac. Null when the Mac already has the most it may have. The count is in the insert, so
 *  requests at the same time can't pass it together. */
export async function createMachine(
  db: D1Database,
  owner: Server,
  name: string | null,
): Promise<{ id: string; handle: string; credential: string } | null> {
  const id = crypto.randomUUID();
  const handle = randomString(HANDLE_ALPHABET, 10);
  const credential = randomToken();
  const created = await db
    .prepare(
      "INSERT INTO server (id, user_id, install_id, handle, credential_hash, name, owner_server_id, created_at) SELECT ?, ?, ?, ?, ?, ?, ?, ? WHERE (SELECT COUNT(*) FROM server WHERE owner_server_id = ?) < ?",
    )
    .bind(id, owner.userId, `machine:${id}`, handle, await sha256Hex(credential), name, owner.id, Date.now(), owner.id, MACHINES_PER_MAC)
    .run();
  return created.meta.changes === 1 ? { id, handle, credential } : null;
}

/** Removes a remote host and everything signed in to its shares. Returns its handle, or null if it was not this Mac's. */
export async function deleteMachine(
  db: D1Database,
  ownerId: string,
  machineId: string,
): Promise<string | null> {
  const row = await db
    .prepare("DELETE FROM server WHERE id = ? AND owner_server_id = ? RETURNING handle, credential_hash")
    .bind(machineId, ownerId)
    .first<{ handle: string; credential_hash: string }>();
  if (!row) return null;
  drop(servers, row.handle);
  drop(credentials, row.credential_hash);
  return row.handle;
}

/** Which Mac a remote host belongs to, read fresh for each new connection. */
export async function machineOwner(db: D1Database, machineId: string): Promise<string | null> {
  const row = await db
    .prepare("SELECT owner_server_id FROM server WHERE id = ?")
    .bind(machineId)
    .first<{ owner_server_id: string | null }>();
  return row?.owner_server_id ?? null;
}

export async function setServerName(db: D1Database, serverId: string, name: string): Promise<void> {
  await db.prepare("UPDATE server SET name = ? WHERE id = ?").bind(name, serverId).run();
}

// A random hash nobody holds the key for: the server keeps its address and phones, but its old key stops working.
const RETIRED_HASH = "lower(hex(randomblob(32)))";

/** Retires keys (sign-out, or the Mac signed in to another account), so they can't list or open the account's Macs. */
async function retire(db: D1Database, where: string, ...values: string[]): Promise<void> {
  const { results } = await db
    .prepare(`UPDATE server SET credential_hash = ${RETIRED_HASH} WHERE ${where} RETURNING handle`)
    .bind(...values)
    .all<{ handle: string }>();
  for (const row of results) drop(servers, row.handle);
}

export function retireServer(db: D1Database, serverId: string): Promise<void> {
  return retire(db, "id = ?", serverId);
}

/** Null when this install is new and the account already has `MACS_PER_ACCOUNT` Macs. A known install always registers. */
export async function registerServer(
  db: D1Database,
  userId: string,
  installId: string,
): Promise<{ handle: string; credential: string } | null> {
  await retire(db, "install_id = ? AND user_id <> ?", installId, userId);
  const credential = randomToken();
  const credentialHash = await sha256Hex(credential);
  const existing = await db
    .prepare(
      "UPDATE server SET credential_hash = ? WHERE user_id = ? AND install_id = ? RETURNING handle",
    )
    .bind(credentialHash, userId, installId)
    .first<{ handle: string }>();
  if (existing) {
    drop(servers, existing.handle);
    return { handle: existing.handle, credential };
  }
  const handle = randomString(HANDLE_ALPHABET, 10);
  const created = await db
    .prepare(
      "INSERT INTO server (id, user_id, install_id, handle, credential_hash, created_at) SELECT ?, ?, ?, ?, ?, ? WHERE (SELECT COUNT(*) FROM server WHERE user_id = ? AND owner_server_id IS NULL AND kind IS NULL) < ?",
    )
    .bind(crypto.randomUUID(), userId, installId, handle, credentialHash, Date.now(), userId, MACS_PER_ACCOUNT)
    .run();
  return created.meta.changes === 1 ? { handle, credential } : null;
}

export const newHandle = () => randomString(HANDLE_ALPHABET, 10);

/** Gives an account's VPS its address (ADR 0319). Registering again replaces the old row, so the website's saved
 *  handle, which it got before this ran, is always the live one. */
export async function registerVps(db: D1Database, userId: string, handle: string, name: string | null): Promise<string> {
  const installId = `vps-${userId}`;
  const credential = randomToken();
  const old = await db.prepare("DELETE FROM server WHERE user_id = ? AND install_id = ? RETURNING handle").bind(userId, installId).first<{ handle: string }>();
  if (old) drop(servers, old.handle);
  await db
    .prepare("INSERT INTO server (id, user_id, install_id, handle, credential_hash, name, kind, created_at) VALUES (?, ?, ?, ?, ?, ?, 'vps', ?)")
    .bind(crypto.randomUUID(), userId, installId, handle, await sha256Hex(credential), name, Date.now())
    .run();
  return credential;
}

export async function markServerSeen(
  db: D1Database,
  serverId: string,
): Promise<void> {
  const now = Date.now();
  const previous = seenWrites.get(serverId);
  if (previous !== undefined && now - previous < SEEN_WRITE_INTERVAL_MS) return;
  seenWrites.set(serverId, now);
  await db
    .prepare("UPDATE server SET last_seen_at = ? WHERE id = ?")
    .bind(now, serverId)
    .run();
}

/** A phone code for an older desktop app to show. Its phone signs in to this Mac only. */
export async function createPhoneCode(
  db: D1Database,
  mac: Server,
): Promise<{ code: string; expiresAt: number }> {
  const now = Date.now();
  const code = randomString(CODE_ALPHABET, 8);
  const codeHash = await sha256Hex(code);
  const expiresAt = now + PHONE_CODE_TTL_MS;
  await db.batch([
    db.prepare("DELETE FROM code WHERE expires_at < ?").bind(now),
    db
      .prepare("INSERT INTO code (code_hash, server_id, target, expires_at) VALUES (?, ?, NULL, ?)")
      .bind(codeHash, mac.id, expiresAt),
    keepNewest(db, "phoneCodes", mac.userId, codeHash),
  ]);
  return { code, expiresAt };
}

export async function createShareCode(
  db: D1Database,
  hostId: string,
  port: string,
  userId: string,
  sessionToken: string,
): Promise<string | null> {
  const now = Date.now();
  const code = randomString(CODE_ALPHABET, 8);
  const codeHash = await sha256Hex(code);
  const [, created] = await db.batch([
    db.prepare("DELETE FROM code WHERE expires_at < ?").bind(now),
    db
      .prepare(
        "INSERT INTO code (code_hash, server_id, target, expires_at, user_id) SELECT ?, ?, ?, ?, ? WHERE EXISTS (SELECT 1 FROM session WHERE token_hash = ? AND expires_at > ?)",
      )
      .bind(codeHash, hostId, port, now + SHARE_CODE_TTL_MS, userId, await sha256Hex(sessionToken), now),
    keepNewest(db, "shareCodes", userId, codeHash),
  ]);
  return created?.meta.changes === 1 ? code : null;
}

export async function codeHandle(
  db: D1Database,
  code: string,
): Promise<string | null> {
  const row = await db
    .prepare(
      "SELECT server.handle FROM code JOIN server ON server.id = code.server_id WHERE code.code_hash = ? AND code.target IS NULL AND code.expires_at > ?",
    )
    .bind(await sha256Hex(code), Date.now())
    .first<{ handle: string }>();
  return row?.handle ?? null;
}

/** Turns a code into a session on `server`: a phone paired with this Mac, or a port share on the code's account. */
export async function redeemCode(
  db: D1Database,
  code: string,
  server: Server,
  target: string | null,
): Promise<string | null> {
  const now = Date.now();
  const token = randomToken();
  const tokenHash = await sha256Hex(token);
  const codeHash = await sha256Hex(code);
  const [created] = await db.batch([
    db
      .prepare(
        "INSERT INTO session (token_hash, server_id, target, expires_at, created_at, user_id) SELECT ?, server_id, target, ?, ?, user_id FROM code WHERE code_hash = ? AND server_id = ? AND target IS ? AND expires_at > ?",
      )
      .bind(tokenHash, now + SESSION_TTL_MS, now, codeHash, server.id, target, now),
    db.prepare("DELETE FROM code WHERE code_hash = ? AND server_id = ? AND target IS ?").bind(codeHash, server.id, target),
    target === null
      ? keepNewest(db, "pairedPhones", server.id, tokenHash)
      : keepNewest(db, "shares", server.userId, tokenHash),
  ]);
  return created?.meta.changes === 1 ? token : null;
}

async function createSession(
  db: D1Database,
  serverId: string,
  userId: string | null,
  ttlMs: number,
  keep: (added: string) => D1PreparedStatement,
): Promise<string> {
  const now = Date.now();
  const token = randomToken();
  const tokenHash = await sha256Hex(token);
  await db.batch([
    db.prepare("DELETE FROM session WHERE expires_at < ?").bind(now),
    db
      .prepare(
        "INSERT INTO session (token_hash, server_id, target, expires_at, created_at, user_id) VALUES (?, ?, NULL, ?, ?, ?)",
      )
      .bind(tokenHash, serverId, now + ttlMs, now, userId),
    keep(tokenHash),
  ]);
  return token;
}

/** A phone signed in with the account (ADR 0268), starting on `serverId`. It can switch to the account's other Macs. */
export function createPhoneSession(db: D1Database, serverId: string, userId: string): Promise<string> {
  return createSession(db, serverId, userId, SESSION_TTL_MS, (added) => keepNewest(db, "phones", userId, added));
}

/** The desktop app's sign-in to another Mac on its account. It renews it before the 30 days are up. */
export function createMacSession(db: D1Database, serverId: string): Promise<string> {
  return createSession(db, serverId, null, DESKTOP_SESSION_TTL_MS, (added) => keepNewest(db, "macToMac", serverId, added));
}

export async function sessionByToken(
  db: D1Database,
  token: string,
): Promise<Session | null> {
  const row = await db
    .prepare(
      "SELECT server_id, target, user_id FROM session WHERE token_hash = ? AND expires_at > ?",
    )
    .bind(await sha256Hex(token), Date.now())
    .first<{ server_id: string; target: string | null; user_id: string | null }>();
  return row ? { serverId: row.server_id, target: row.target, userId: row.user_id } : null;
}

export async function pickServer(db: D1Database, token: string, server: Server): Promise<boolean> {
  const result = await db
    .prepare("UPDATE session SET server_id = ? WHERE token_hash = ? AND user_id = ? AND target IS NULL")
    .bind(server.id, await sha256Hex(token), server.userId)
    .run();
  return result.meta.changes === 1;
}

export async function phoneUser(db: D1Database, token: string): Promise<string | null> {
  const row = await db
    .prepare(
      "SELECT server.user_id FROM session JOIN server ON server.id = session.server_id WHERE session.token_hash = ? AND session.target IS NULL AND session.expires_at > ?",
    )
    .bind(await sha256Hex(token), Date.now())
    .first<{ user_id: string }>();
  return row?.user_id ?? null;
}

/** Whether a phone is signed in to the account, on any of its Macs. Phone sessions last a year, Mac-to-Mac ones 30 days. */
export async function hasPhone(db: D1Database, userId: string): Promise<boolean> {
  const row = await db
    .prepare(
      "SELECT 1 FROM session JOIN server ON server.id = session.server_id WHERE server.user_id = ? AND session.target IS NULL AND session.expires_at > ? AND session.expires_at - session.created_at > ? LIMIT 1",
    )
    .bind(userId, Date.now(), DESKTOP_SESSION_TTL_MS)
    .first();
  return row !== null;
}

export async function accountHandles(db: D1Database, userId: string): Promise<string[]> {
  const { results } = await db
    .prepare("SELECT handle FROM server WHERE user_id = ?")
    .bind(userId)
    .all<{ handle: string }>();
  return results.map((row) => row.handle);
}

export async function revokeSessions(db: D1Database, userId: string): Promise<number> {
  const [, sessions] = await db.batch([
    db
      .prepare("DELETE FROM code WHERE user_id = ? OR server_id IN (SELECT id FROM server WHERE user_id = ?)")
      .bind(userId, userId),
    db
      .prepare("DELETE FROM session WHERE user_id = ? OR server_id IN (SELECT id FROM server WHERE user_id = ?)")
      .bind(userId, userId),
  ]);
  return sessions?.meta.changes ?? 0;
}
