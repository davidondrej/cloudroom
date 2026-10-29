const CODE_ALPHABET = "ABCDEFGHJKMNPQRSTVWXYZ23456789";
const HANDLE_ALPHABET = "abcdefghjkmnpqrstvwxyz23456789";
const SERVER_CACHE_MS = 15_000;
const MACHINES_PER_MAC = 20;
const SEEN_WRITE_INTERVAL_MS = 60_000;
export const PHONE_CODE_TTL_MS = 10 * 60_000;
export const SHARE_CODE_TTL_MS = 60_000;
export const SESSION_TTL_MS = 365 * 24 * 60 * 60_000;
export const DESKTOP_SESSION_TTL_MS = 30 * 24 * 60 * 60_000;

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
  value: Promise<T>;
  expires: number;
}

const servers = new Map<string, Cached<Server | null>>();
const credentials = new Map<string, Cached<Server | null>>();
const seenWrites = new Map<string, number>();

function cached<T>(
  map: Map<string, Cached<T>>,
  key: string,
  ttl: number,
  load: () => Promise<T>,
  fresh = false,
): Promise<T> {
  const now = Date.now();
  const hit = map.get(key);
  if (!fresh && hit && hit.expires > now) return hit.value;
  const value = load();
  map.set(key, { value, expires: now + ttl });
  value.catch(() => map.delete(key));
  return value;
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

/** Adds a remote host for this Mac. Null when the Mac already has the most it may have. */
export async function createMachine(
  db: D1Database,
  owner: Server,
  name: string | null,
): Promise<{ id: string; handle: string; credential: string } | null> {
  const count = await db
    .prepare("SELECT COUNT(*) AS n FROM server WHERE owner_server_id = ?")
    .bind(owner.id)
    .first<{ n: number }>();
  if ((count?.n ?? 0) >= MACHINES_PER_MAC) return null;
  const id = crypto.randomUUID();
  const handle = randomString(HANDLE_ALPHABET, 10);
  const credential = randomToken();
  await db
    .prepare(
      "INSERT INTO server (id, user_id, install_id, handle, credential_hash, name, owner_server_id, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
    )
    .bind(id, owner.userId, `machine:${id}`, handle, await sha256Hex(credential), name, owner.id, Date.now())
    .run();
  return { id, handle, credential };
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
  servers.delete(row.handle);
  credentials.delete(row.credential_hash);
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
  for (const row of results) servers.delete(row.handle);
}

export function retireServer(db: D1Database, serverId: string): Promise<void> {
  return retire(db, "id = ?", serverId);
}

export async function registerServer(
  db: D1Database,
  userId: string,
  installId: string,
): Promise<{ handle: string; credential: string }> {
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
    servers.delete(existing.handle);
    return { handle: existing.handle, credential };
  }
  const handle = randomString(HANDLE_ALPHABET, 10);
  await db
    .prepare(
      "INSERT INTO server (id, user_id, install_id, handle, credential_hash, created_at) VALUES (?, ?, ?, ?, ?, ?)",
    )
    .bind(crypto.randomUUID(), userId, installId, handle, credentialHash, Date.now())
    .run();
  return { handle, credential };
}

export const newHandle = () => randomString(HANDLE_ALPHABET, 10);

/** Gives an account's VPS its address (ADR 0319). Registering again replaces the old row, so the website's saved
 *  handle, which it got before this ran, is always the live one. */
export async function registerVps(db: D1Database, userId: string, handle: string, name: string | null): Promise<string> {
  const installId = `vps-${userId}`;
  const credential = randomToken();
  const old = await db.prepare("DELETE FROM server WHERE user_id = ? AND install_id = ? RETURNING handle").bind(userId, installId).first<{ handle: string }>();
  if (old) servers.delete(old.handle);
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

export async function createCode(
  db: D1Database,
  serverId: string,
  target: string | null,
  ttlMs: number,
  userId: string | null = null,
): Promise<{ code: string; expiresAt: number }> {
  const now = Date.now();
  const code = randomString(CODE_ALPHABET, 8);
  const expiresAt = now + ttlMs;
  await db.batch([
    db.prepare("DELETE FROM code WHERE expires_at < ?").bind(now),
    db
      .prepare(
        "INSERT INTO code (code_hash, server_id, target, expires_at, user_id) VALUES (?, ?, ?, ?, ?)",
      )
      .bind(await sha256Hex(code), serverId, target, expiresAt, userId),
  ]);
  return { code, expiresAt };
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

export async function consumeCode(
  db: D1Database,
  code: string,
  serverId: string,
  target: string | null,
): Promise<{ userId: string | null } | null> {
  const row = await db
    .prepare(
      "DELETE FROM code WHERE code_hash = ? AND server_id = ? AND target IS ? AND expires_at > ? RETURNING user_id",
    )
    .bind(await sha256Hex(code), serverId, target, Date.now())
    .first<{ user_id: string | null }>();
  return row ? { userId: row.user_id } : null;
}

export async function createSession(
  db: D1Database,
  serverId: string,
  target: string | null,
  ttlMs = SESSION_TTL_MS,
  userId: string | null = null,
): Promise<string> {
  const now = Date.now();
  const token = randomToken();
  await db.batch([
    db.prepare("DELETE FROM session WHERE expires_at < ?").bind(now),
    db
      .prepare(
        "INSERT INTO session (token_hash, server_id, target, expires_at, created_at, user_id) VALUES (?, ?, ?, ?, ?, ?)",
      )
      .bind(await sha256Hex(token), serverId, target, now + ttlMs, now, userId),
  ]);
  return token;
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

export async function accountHandles(db: D1Database, userId: string): Promise<string[]> {
  const { results } = await db
    .prepare("SELECT handle FROM server WHERE user_id = ?")
    .bind(userId)
    .all<{ handle: string }>();
  return results.map((row) => row.handle);
}

export async function revokeSessions(db: D1Database, server: Server): Promise<number> {
  const result = await db
    .prepare("DELETE FROM session WHERE server_id = ? OR user_id = ?")
    .bind(server.id, server.userId)
    .run();
  return result.meta.changes;
}
