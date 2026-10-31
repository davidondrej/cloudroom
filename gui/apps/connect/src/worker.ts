import { serveWithCache } from "./cache.js";
import { OFFLINE_HEADER, codePage, messagePage, offlinePage } from "./pages.js";
import {
  GATE_AUTH_HEADER,
  GATE_MACHINE_ID_HEADER,
  MACHINE_CREDENTIAL_HEADER,
  PHONE_SESSION_HEADER,
  SESSION_COOKIE,
  TUNNEL_MACHINE_HEADER,
  TUNNEL_SESSION_HEADER,
  TUNNEL_TARGET_HEADER,
  TUNNEL_VPS_HEADER,
} from "./protocol-headers.js";
import {
  DESKTOP_SESSION_TTL_MS,
  PHONE_CODE_TTL_MS,
  SESSION_TTL_MS,
  accountHandles,
  accountServers,
  codeHandle,
  createCode,
  createMachine,
  createSession,
  createShareCode,
  deleteMachine,
  formatCode,
  hasPhone,
  machineByCredential,
  newHandle,
  normalizeCode,
  phoneUser,
  pickServer,
  redeemCode,
  registerServer,
  registerVps,
  retireServer,
  revokeSessions,
  serverByCredential,
  serverByHandle,
  serverById,
  sessionByToken,
  setServerName,
  sha256Hex,
  type Server,
  type Session,
} from "./store.js";
import { TUNNEL_OFFLINE_HEADER, TunnelDO, type Env } from "./tunnel-do.js";

export { TunnelDO };

const WRONG_CODE = "That code is wrong or expired. Get a new one in the Cloudroom desktop app.";
const PORT = /^[1-9][0-9]{0,4}$/;
const CLOUD_PATH = /^\/__cloud\/([a-z0-9_/-]{1,200})$/;
const TOKEN = /^[a-f0-9]{64}$/;
const HANDLE = /^[a-z0-9]{1,63}$/;
const PUBLIC_APP_FILES =
  /^\/(?:manifest[\w-]*\.webmanifest|apple-touch-icon[\w-]*\.png|icon-[\w-]+\.png|favicon[\w.-]*)$/;
/** What a new remote host downloads before it has a credential, and its type. The Mac checks the one-time enrollment itself. */
const INSTALL_FILES = new Map([
  ["/install.sh", "text/x-shellscript; charset=utf-8"],
  ["/install/version", "application/json"],
  ["/install/bb-app.tgz", "application/gzip"],
]);
/** The only Mac headers a download keeps, so no Mac can answer it with a web page or a cookie for cloudroom.run. */
const INSTALL_HEADERS = new Set(["cache-control", "content-encoding", "content-length", "etag", "vary", "x-bb-artifact-sha256"]);
const MAC_ONLY_CONNECT_RPCS = new Set(["relayCredential", "revokeMachine", "runSetupJob", "setupJobStatus", "macs"]);
const APP_HANDLE = "app";
const LOGIN_TOKEN = /^[\w-]+\.[\w-]+\.[\w-]+$/;
const MAC_HEADER = "x-cloudroom-mac";
const NEXT_COOKIE = "__Host-cloudroom-next";

interface Visitor {
  handle: string;
  target: string | null;
}

function text(body: string, status: number): Response {
  return new Response(body, {
    status,
    headers: { "content-type": "text/plain; charset=utf-8" },
  });
}

function json(value: unknown, status = 200): Response {
  return Response.json(value, {
    status,
    headers: { "cache-control": "no-store" },
  });
}

async function readJson(request: Request): Promise<Record<string, unknown>> {
  const body: unknown = await request.json().catch(() => null);
  return body !== null && typeof body === "object" ? (body as Record<string, unknown>) : {};
}

function computerName(value: unknown): string | null {
  if (typeof value !== "string") return null;
  return value.replace(/[\u0000-\u001f\u007f]/g, "").trim().slice(0, 64) || null;
}

/** Asks the Mac's tunnel object, so it's right the moment a Mac sleeps or wakes. */
async function isOnline(env: Env, handle: string): Promise<boolean> {
  const stub = env.TUNNEL_DO.get(env.TUNNEL_DO.idFromName(handle));
  const status = await stub
    .fetch(new Request(`https://${handle}.${env.BASE_DOMAIN}/__control/status`))
    .then((response) => response.json() as Promise<{ online?: unknown }>)
    .catch(() => null);
  return status?.online === true;
}

/** Your Macs, for switching between them (signed in to the same Cloudroom account). Also saves the caller's name. */
async function computers(request: Request, env: Env, self: Server): Promise<Response> {
  const name = computerName((await readJson(request)).name);
  if (name !== null && name !== self.name) await setServerName(env.DB, self.id, name).catch(() => {});
  const servers = await accountServers(env.DB, self.userId);
  return json({
    selfHandle: self.handle,
    computers: await Promise.all(
      servers.map(async (server) => ({
        handle: server.handle,
        name: (server.id === self.id ? name : null) ?? server.name ?? "Mac",
        live: server.id === self.id || (await isOnline(env, server.handle)),
        url: `https://${server.handle}.${env.BASE_DOMAIN}`,
      })),
    ),
  });
}

/** Signs the caller in to another Mac on the same account. The desktop app installs the cookie and opens the Mac. */
async function openComputer(request: Request, env: Env, self: Server): Promise<Response> {
  const handle = (await readJson(request)).handle;
  const target = typeof handle === "string" && HANDLE.test(handle) ? await serverByHandle(env.DB, handle, true) : null;
  if (!target || target.userId !== self.userId || target.id === self.id) {
    return json({ error: "That Mac is not on your account." }, 404);
  }
  if (!(await isOnline(env, target.handle))) return json({ error: "That Mac is offline.", offline: true }, 409);
  const origin = `https://${target.handle}.${env.BASE_DOMAIN}`;
  const expiresAt = Date.now() + DESKTOP_SESSION_TTL_MS;
  const value = await createSession(env.DB, target.id, null, DESKTOP_SESSION_TTL_MS);
  return json({ url: origin, cookie: { name: SESSION_COOKIE, value, expiresAt } });
}

function redirect(location: string, ...setCookies: string[]): Response {
  const headers = new Headers({ location, "cache-control": "no-store" });
  for (const cookie of setCookies) headers.append("set-cookie", cookie);
  return new Response(null, { status: 302, headers });
}

function wantsHtml(request: Request): boolean {
  return (request.headers.get("accept") ?? "").includes("text/html");
}

function bearer(request: Request): string {
  const auth = request.headers.get("authorization") ?? "";
  return auth.startsWith("Bearer ") ? auth.slice(7) : "";
}

export function parseVisitorHost(host: string, baseDomain: string): Visitor | null {
  const suffix = `.${baseDomain}`;
  if (!host.endsWith(suffix)) return null;
  const [handle, target, extra] = host.slice(0, -suffix.length).split("--");
  if (!handle || !HANDLE.test(handle) || extra !== undefined) return null;
  if (target === undefined) return { handle, target: null };
  return PORT.test(target) && Number(target) <= 65535 ? { handle, target } : null;
}

export function readCookie(header: string | null, name: string): string | null {
  for (const part of (header ?? "").split(";")) {
    const index = part.indexOf("=");
    if (index !== -1 && part.slice(0, index).trim() === name) {
      return part.slice(index + 1).trim();
    }
  }
  return null;
}

export function requestForTunnelDo(
  request: Request,
  target: string | null,
  machineId: string | null = null,
): Request {
  const headers = new Headers(request.headers);
  for (const name of [
    TUNNEL_TARGET_HEADER,
    TUNNEL_SESSION_HEADER,
    TUNNEL_MACHINE_HEADER,
    MACHINE_CREDENTIAL_HEADER,
    GATE_AUTH_HEADER,
    GATE_MACHINE_ID_HEADER,
    TUNNEL_VPS_HEADER,
  ]) {
    headers.delete(name);
  }
  const cookie = (headers.get("cookie") ?? "")
    .split(";")
    .map((part) => part.trim())
    .filter((part) => part && !part.startsWith(`${SESSION_COOKIE}=`))
    .join("; ");
  if (cookie) headers.set("cookie", cookie);
  else headers.delete("cookie");
  if (target !== null) headers.set(TUNNEL_TARGET_HEADER, target);
  const upgrade = request.headers.get("upgrade")?.toLowerCase() === "websocket";
  if (machineId !== null) {
    headers.set(GATE_AUTH_HEADER, "machine");
    headers.set(GATE_MACHINE_ID_HEADER, machineId);
    if (upgrade) headers.set(TUNNEL_MACHINE_HEADER, machineId);
    return new Request(request, { headers });
  }
  const token = readCookie(request.headers.get("cookie"), SESSION_COOKIE);
  if (upgrade && token) headers.set(TUNNEL_SESSION_HEADER, token);
  headers.set(GATE_AUTH_HEADER, "session");
  return new Request(request, { headers });
}

function decodedPath(pathname: string): string | null {
  try {
    return decodeURI(pathname);
  } catch {
    return null;
  }
}

/** Remote hosts may run threads but not change which machines this Mac trusts, read its relay key, or reach its other Macs. */
function isHostManagement(method: string, pathname: string): boolean {
  if (method === "POST" && (pathname === "/internal/hosts/enroll-key" || pathname === "/api/v1/hosts/join-codes")) {
    return true;
  }
  const connectRpc = /^\/api\/v1\/plugins\/connect\/rpc\/([^/]+)$/u.exec(pathname)?.[1];
  if (method === "POST" && connectRpc !== undefined && MAC_ONLY_CONNECT_RPCS.has(connectRpc)) return true;
  if (method === "PATCH" && /^\/api\/v1\/hosts\/[^/]+\/permission-ceiling$/u.test(pathname)) return true;
  return (method === "PATCH" || method === "DELETE") && /^\/api\/v1\/hosts\/[^/]+$/u.test(pathname);
}

export function returnUrl(origin: string, value: string | null): string {
  try {
    const href = new URL(value ?? "/", origin).href;
    if (href.startsWith(`${origin}/`)) return href;
  } catch {}
  return `${origin}/`;
}

function sessionCookie(token: string): string {
  return `${SESSION_COOKIE}=${token}; Path=/; Secure; HttpOnly; SameSite=Lax; Max-Age=${SESSION_TTL_MS / 1000}`;
}

async function register(request: Request, env: Env): Promise<Response> {
  const authorization = request.headers.get("authorization") ?? "";
  if (!/^Basic [A-Za-z0-9+/=]{1,2048}$/.test(authorization)) {
    return json({ error: "Sign in to Cloudroom first." }, 401);
  }
  const body = (await request.json().catch(() => null)) as { installId?: unknown } | null;
  const installId = body?.installId;
  if (typeof installId !== "string" || !/^[a-f0-9]{32}$/.test(installId)) {
    return json({ error: "Invalid install ID." }, 400);
  }
  const verified = await fetch(`${env.WEBSITE_URL}/api/desktop/connect`, {
    method: "POST",
    headers: { authorization },
    redirect: "manual",
  }).catch(() => null);
  if (verified?.status === 401 || verified?.status === 403) {
    return json({ error: "Cloudroom rejected this Mac's sign-in." }, 401);
  }
  const userId = verified?.ok
    ? ((await verified.json().catch(() => null)) as { userId?: unknown } | null)?.userId
    : undefined;
  if (typeof userId !== "string" || !userId) {
    return json({ error: "Cloudroom could not verify this Mac. Try again soon." }, 503);
  }
  const { handle, credential } = await registerServer(env.DB, userId, installId);
  return json({ handle, credential, serverUrl: `https://${handle}.${env.BASE_DOMAIN}` });
}

async function cloud(request: Request, path: string, url: URL, env: Env, token: string): Promise<Response> {
  const headers = new Headers({ [PHONE_SESSION_HEADER]: token });
  for (const name of ["accept", "content-type"]) {
    const value = request.headers.get(name);
    if (value) headers.set(name, value);
  }
  const hasBody = request.method !== "GET" && request.method !== "HEAD";
  if (hasBody && request.headers.get("origin") !== url.origin) return json({ error: "Wrong origin." }, 403);
  const response = await fetch(new URL(`/api/connect/cloud/${path}${url.search}`, env.WEBSITE_URL), {
    method: request.method,
    headers,
    body: hasBody ? request.body : undefined,
    redirect: "manual",
  }).catch(() => null);
  return response ?? json({ error: "Cloudroom is unreachable. Try again." }, 502);
}

/** Adds a remote host that runs threads for this Mac. Its daemon sends the credential to reach the Mac. */
async function addMachine(request: Request, env: Env, owner: Server): Promise<Response> {
  const machine = await createMachine(env.DB, owner, computerName((await readJson(request)).name));
  if (!machine) return json({ error: "machine_limit" }, 409);
  return json({
    machineId: machine.id,
    credential: machine.credential,
    serverUrl: serverOrigin(owner, null, env),
  });
}

async function removeMachine(request: Request, env: Env, owner: Server): Promise<Response> {
  const machineId = (await readJson(request)).machineId;
  if (typeof machineId !== "string" || !machineId) return json({ error: "Missing machineId." }, 400);
  const handle = await deleteMachine(env.DB, owner.id, machineId);
  if (handle !== null) {
    const stub = env.TUNNEL_DO.get(env.TUNNEL_DO.idFromName(handle));
    await stub.fetch(new Request(`https://${handle}.${env.BASE_DOMAIN}/__control/close`)).catch(() => {});
  }
  return json({ ok: true });
}

/** A user's VPS gets its address once the website confirms its token (ADR 0319). The website saves the handle first. */
async function vpsRegister(request: Request, env: Env): Promise<Response> {
  const token = bearer(request);
  if (!/^[a-f0-9]{64}$/.test(token)) return json({ error: "Unknown VPS." }, 401);
  const name = computerName((await readJson(request)).name);
  const handle = newHandle();
  const verified = await fetch(`${env.WEBSITE_URL}/api/connect/vps`, {
    method: "POST",
    headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
    body: JSON.stringify({ handle }),
    redirect: "manual",
  }).catch(() => null);
  if (verified?.status === 401) return json({ error: "Unknown VPS." }, 401);
  const userId = verified?.ok
    ? ((await verified.json().catch(() => null)) as { userId?: unknown } | null)?.userId
    : undefined;
  if (typeof userId !== "string" || !userId) {
    return json({ error: "Cloudroom could not verify this VPS. Try again soon." }, 503);
  }
  const credential = await registerVps(env.DB, userId, handle, name);
  return json({ handle, credential, baseDomain: env.BASE_DOMAIN });
}

/** A VPS's ports are its sandboxes' Cores and its service's API, which check their own tokens (ADR 0319). The relay
 *  only carries the bytes: no phone session, cookie, or cache, since cached responses would skip those tokens. */
function vpsForward(request: Request, env: Env, server: Server, target: string): Promise<Response> {
  const headers = new Headers(request.headers);
  for (const name of [TUNNEL_SESSION_HEADER, TUNNEL_MACHINE_HEADER, MACHINE_CREDENTIAL_HEADER, GATE_AUTH_HEADER, GATE_MACHINE_ID_HEADER, "cookie"]) {
    headers.delete(name);
  }
  headers.set(TUNNEL_TARGET_HEADER, target);
  headers.set(TUNNEL_VPS_HEADER, "1");
  return env.TUNNEL_DO.get(env.TUNNEL_DO.idFromName(server.handle)).fetch(new Request(request, { headers }));
}

/** A remote host's daemon asks for its own address, which carries the ports it shares. */
async function machineLabel(request: Request, env: Env): Promise<Response> {
  const machine = await machineByCredential(env.DB, request.headers.get(MACHINE_CREDENTIAL_HEADER) ?? "");
  if (!machine) return json({ error: "unauthorized" }, 401);
  const name = computerName((await readJson(request)).desiredName);
  if (name !== null && name !== machine.name) await setServerName(env.DB, machine.id, name).catch(() => {});
  return json({ label: machine.handle });
}

async function apex(request: Request, url: URL, env: Env): Promise<Response> {
  if (request.method === "POST" && url.pathname === "/api/register") {
    return register(request, env);
  }
  if (request.method === "POST" && url.pathname === "/api/connect/machine-label") {
    return machineLabel(request, env);
  }
  if (request.method === "POST" && url.pathname === "/api/vps/register") {
    return vpsRegister(request, env);
  }
  if (request.method === "GET" && url.pathname === "/api/phone-session") {
    const token = bearer(request);
    const userId = TOKEN.test(token) ? await phoneUser(env.DB, token) : null;
    return userId ? json({ userId }) : json({ error: "Unknown phone." }, 401);
  }
  if (request.method === "POST" && url.pathname.startsWith("/api/")) {
    const server = await serverByCredential(env.DB, bearer(request));
    if (!server || server.ownerServerId !== null || server.vps) return json({ error: "Unknown Mac." }, 401);
    if (url.pathname === "/api/computers") return computers(request, env, server);
    if (url.pathname === "/api/computers/open") return openComputer(request, env, server);
    if (url.pathname === "/api/phones") return json({ phone: await hasPhone(env.DB, server.userId) });
    if (url.pathname === "/api/machines") return addMachine(request, env, server);
    if (url.pathname === "/api/machines/revoke") return removeMachine(request, env, server);
    if (url.pathname === "/api/unregister") {
      await retireServer(env.DB, server.id);
      return json({ ok: true });
    }
    if (url.pathname === "/api/phone-code") {
      const { code, expiresAt } = await createCode(env.DB, server.id, null, PHONE_CODE_TTL_MS);
      const formatted = formatCode(code);
      return json({
        code: formatted,
        expiresAt,
        url: `https://${env.BASE_DOMAIN}/pair?code=${formatted}`,
      });
    }
    if (url.pathname === "/api/phone-sessions/revoke") {
      const revoked = await revokeSessions(env.DB, server.userId);
      const closed = await Promise.all(
        (await accountHandles(env.DB, server.userId)).map((handle) =>
          env.TUNNEL_DO.get(env.TUNNEL_DO.idFromName(handle))
            .fetch(new Request(`https://${handle}.${env.BASE_DOMAIN}/__control/revoke-visitors`, { method: "POST" }))
            .then((response) => response.ok, () => false),
        ),
      );
      if (closed.includes(false)) {
        return json({ error: "Could not close phone connections. Try again." }, 503);
      }
      return json({ revoked });
    }
  }
  if (request.method === "GET" && (url.pathname === "/" || url.pathname === "/pair")) {
    const raw = url.searchParams.get("code");
    if (raw === null && url.pathname === "/") return redirect(`${new URL(env.WEBSITE_URL).origin}/m`);
    if (raw === null) return codePage("/pair", undefined, 200);
    const code = normalizeCode(raw);
    const handle = code === null ? null : await codeHandle(env.DB, code);
    if (code === null || handle === null) return codePage("/pair", WRONG_CODE);
    return redirect(`https://${handle}.${env.BASE_DOMAIN}/__pair?code=${code}`);
  }
  return text("Not found\n", 404);
}

function sessionToken(request: Request): string | null {
  const token = readCookie(request.headers.get("cookie"), SESSION_COOKIE);
  return token && TOKEN.test(token) ? token : null;
}

function serverOrigin(server: Server, target: string | null, env: Env): string {
  return `https://${server.handle}${target === null ? "" : `--${target}`}.${env.BASE_DOMAIN}`;
}

/** Sends a phone to the app to get a one-time ticket for a shared port, on the Mac or one of its remote hosts. */
function shareHop(mac: Server, port: string, returnPath: string, env: Env, machineHandle?: string): string {
  const next = new URL(`https://${APP_HANDLE}.${env.BASE_DOMAIN}/__share`);
  next.searchParams.set("mac", mac.handle);
  next.searchParams.set("port", port);
  if (machineHandle !== undefined) next.searchParams.set("machine", machineHandle);
  next.searchParams.set("return", returnPath);
  return next.toString();
}

/** Icons and manifests come from the relay's own copy, so a Mac never answers a visitor who is not signed in. */
function publicAppFile(request: Request, url: URL, env: Env): Promise<Response> | null {
  return env.ASSETS && request.method === "GET" && PUBLIC_APP_FILES.test(url.pathname) ? env.ASSETS.fetch(request) : null;
}

/** A browser can only save an install download, never open it as a page on cloudroom.run. */
function installFile(response: Response, contentType: string): Response {
  const download = new Response(response.body, response);
  for (const name of [...download.headers.keys()]) {
    if (!INSTALL_HEADERS.has(name)) download.headers.delete(name);
  }
  download.headers.set("content-type", contentType);
  download.headers.set("content-security-policy", "sandbox");
  download.headers.set("x-content-type-options", "nosniff");
  return download;
}

async function visitor(
  request: Request,
  url: URL,
  env: Env,
  ctx: ExecutionContext,
  { handle, target }: Visitor,
): Promise<Response> {
  const isTunnel = url.pathname === "/__tunnel";
  const server = await serverByHandle(env.DB, handle, isTunnel);
  if (!server) {
    return wantsHtml(request)
      ? messagePage("Not found", "This Cloudroom address does not exist.", 404)
      : text("Not found\n", 404);
  }
  const stub = env.TUNNEL_DO.get(env.TUNNEL_DO.idFromName(server.handle));

  if (isTunnel) {
    if (target !== null) return text("Not found\n", 404);
    if ((await sha256Hex(bearer(request))) !== server.credentialHash) {
      return text("Invalid credential\n", 401);
    }
    const forward = new URL(request.url);
    forward.searchParams.set("serverId", server.id);
    return stub.fetch(new Request(forward, request));
  }

  // `/__` paths are the tunnel's own controls (close, revoke), never a sandbox's.
  if (server.vps) return target === null || url.pathname.startsWith("/__") ? text("Not found\n", 404) : vpsForward(request, env, server, target);

  if (server.ownerServerId === null && target === null) {
    const installType = request.method === "GET" ? INSTALL_FILES.get(url.pathname) : undefined;
    if (installType !== undefined) {
      return installFile(await stub.fetch(requestForTunnelDo(request, null)), installType);
    }
    const presented = request.headers.get(MACHINE_CREDENTIAL_HEADER);
    if (presented !== null) {
      const machine = await machineByCredential(env.DB, presented);
      const path = decodedPath(url.pathname);
      const machinePath =
        path !== null && (path.startsWith("/internal") || path === "/api/v1" || path.startsWith("/api/v1/"));
      if (!machine || machine.ownerServerId !== server.id || !machinePath) {
        return text("Machine not authorized\n", 403);
      }
      if (isHostManagement(request.method, path)) {
        return text("Remote hosts cannot manage machines\n", 403);
      }
      return stub.fetch(requestForTunnelDo(request, null, machine.id));
    }
    if (url.pathname.startsWith("/internal")) return text("Not found\n", 404);
  }

  if (url.pathname === "/__pair") {
    const code = normalizeCode(url.searchParams.get("code") ?? "");
    const token = code === null ? null : await redeemCode(env.DB, code, server.id, target);
    if (token === null) {
      return target === null
        ? codePage("/__pair", WRONG_CODE)
        : messagePage("Link expired", "Open the link again.", 400);
    }
    return redirect(returnUrl(serverOrigin(server, target, env), url.searchParams.get("return")), sessionCookie(token));
  }

  const token = sessionToken(request);
  const session: Session | null = token ? await sessionByToken(env.DB, token) : null;
  const signedIn = session?.serverId === server.id && session.target === target;

  // A remote host's address only carries its shared ports. Phones sign in to them through the Mac they belong to.
  if (server.ownerServerId !== null) {
    if (target === null || url.pathname.startsWith("/__")) return text("Not found\n", 404);
    if (!signedIn) {
      if (request.method !== "GET" || !wantsHtml(request)) return text("Sign in required\n", 401);
      const owner = await serverById(env.DB, server.ownerServerId);
      if (!owner) return text("Not found\n", 404);
      return redirect(shareHop(owner, target, url.pathname + url.search, env, server.handle));
    }
  }

  const cloudPath = CLOUD_PATH.exec(url.pathname)?.[1];
  if (cloudPath !== undefined) {
    if (!signedIn || target !== null || !token) return json({ error: "Sign in required." }, 401);
    return cloud(request, cloudPath, url, env, token);
  }

  if (url.pathname === "/__share") {
    if (target !== null) return text("Not found\n", 404);
    if (!signedIn || !token) {
      const next = new URL(`https://${APP_HANDLE}.${env.BASE_DOMAIN}/__share${url.search}`);
      next.searchParams.set("mac", server.handle);
      next.searchParams.set("signin", "1");
      return redirect(next.toString());
    }
    return shareRedirect(env, server, url, token);
  }
  if (url.pathname.startsWith("/__")) return text("Not found\n", 404);

  if (!signedIn) {
    const file = target === null ? publicAppFile(request, url, env) : null;
    if (file) return file;
    if (request.method !== "GET" || !wantsHtml(request)) return text("Sign in required\n", 401);
    if (target === null) return codePage("/__pair");
    return redirect(shareHop(server, target, url.pathname + url.search, env));
  }
  return forward(request, env, ctx, server, target);
}

async function shareRedirect(env: Env, mac: Server, url: URL, token: string): Promise<Response> {
  const port = url.searchParams.get("port") ?? "";
  if (!PORT.test(port)) return text("Not found\n", 404);
  const machineHandle = url.searchParams.get("machine");
  const host =
    machineHandle === null
      ? mac
      : HANDLE.test(machineHandle)
        ? await serverByHandle(env.DB, machineHandle, true)
        : null;
  if (!host || (host.id !== mac.id && host.ownerServerId !== mac.id)) return text("Not found\n", 404);
  const code = await createShareCode(env.DB, host.id, port, mac.userId, token);
  if (code === null) return text("Sign in required\n", 401);
  const next = new URL(`${serverOrigin(host, port, env)}/__pair`);
  next.searchParams.set("code", code);
  next.searchParams.set("return", url.searchParams.get("return") ?? "/");
  return redirect(next.toString());
}

async function forward(
  request: Request,
  env: Env,
  ctx: ExecutionContext,
  server: Server,
  target: string | null,
): Promise<Response> {
  const stub = env.TUNNEL_DO.get(env.TUNNEL_DO.idFromName(server.handle));
  const doRequest = requestForTunnelDo(request, target);
  if (request.headers.get("upgrade")?.toLowerCase() === "websocket") {
    return stub.fetch(doRequest);
  }
  const { response } = await serveWithCache(
    request,
    target === null ? server.handle : `${server.handle}--${target}`,
    ctx,
    (init) => {
      if (init === undefined) return stub.fetch(doRequest);
      const headers = new Headers(doRequest.headers);
      headers.set("if-none-match", init.ifNoneMatch);
      return stub.fetch(new Request(doRequest, { headers }));
    },
  );
  const offline = response.status === 503 && response.headers.get(TUNNEL_OFFLINE_HEADER) === "1";
  if (response.status >= 502 && response.status <= 504) {
    console.log({
      event: "phone_request_failed",
      mac: server.handle,
      port: target,
      path: new URL(request.url).pathname,
      status: response.status,
      reason: offline ? "mac offline" : response.status === 504 ? "timed out" : "mac error",
    });
  }
  if (offline && wantsHtml(request)) return offlinePage(server.lastSeenAt);
  return response;
}

async function signIn(request: Request, env: Env): Promise<Response> {
  const website = new URL(env.WEBSITE_URL);
  const setup = `${website.origin}/m`;
  if (request.headers.get("origin") !== website.origin) return redirect(setup);
  const login = (await request.formData().catch(() => null))?.get("token");
  if (typeof login !== "string" || login.length > 8192 || !LOGIN_TOKEN.test(login)) return redirect(setup);
  const verified = await fetch(`${website.origin}/api/connect/phone-sign-in`, {
    method: "POST",
    headers: { authorization: `Bearer ${login}` },
    redirect: "manual",
  }).catch(() => null);
  if (verified?.status === 401) return redirect(setup);
  if (verified?.status === 403) {
    return messagePage("No access yet", "This Cloudroom account can't use the app yet.", 403);
  }
  const userId = verified?.ok
    ? ((await verified.json().catch(() => null)) as { userId?: unknown } | null)?.userId
    : undefined;
  if (typeof userId !== "string" || !userId) {
    return messagePage("Try again", "Cloudroom could not check your sign-in. Try again soon.", 503);
  }
  const [mac] = (await accountServers(env.DB, userId)).sort((a, b) => (b.lastSeenAt ?? 0) - (a.lastSeenAt ?? 0));
  if (!mac) {
    return messagePage(
      "Open Cloudroom on your computer",
      "Sign in to the Cloudroom desktop app once, then open cloudroom.dev/m again.",
      409,
    );
  }
  const token = await createSession(env.DB, mac.id, null, SESSION_TTL_MS, userId);
  return redirect(
    shareReturn(readCookie(request.headers.get("cookie"), NEXT_COOKIE)),
    sessionCookie(token),
    `${NEXT_COOKIE}=; Path=/; Secure; HttpOnly; SameSite=None; Max-Age=0`,
  );
}

function shareReturn(value: string | null): string {
  try {
    const next = decodeURIComponent(value ?? "");
    return next.startsWith("/__share?") ? next : "/";
  } catch {
    return "/";
  }
}

function withOrigin(request: Request, origin: string): Request {
  const headers = new Headers(request.headers);
  headers.set("origin", origin);
  return new Request(request, { headers });
}

async function switchMac(request: Request, url: URL, env: Env, token: string, userId: string): Promise<Response> {
  if (request.headers.get("origin") !== url.origin) return json({ error: "Wrong origin." }, 403);
  const handle = (await readJson(request)).handle;
  const mac = typeof handle === "string" && HANDLE.test(handle) ? await serverByHandle(env.DB, handle, true) : null;
  if (!mac || mac.userId !== userId || mac.ownerServerId !== null || !(await pickServer(env.DB, token, mac))) {
    return json({ error: "That Mac is not on your account." }, 404);
  }
  return json({ ok: true });
}

async function onlineMac(env: Env, picked: Server): Promise<Server | null> {
  for (const mac of await accountServers(env.DB, picked.userId)) {
    if (mac.id !== picked.id && (await isOnline(env, mac.handle))) return mac;
  }
  return null;
}

async function phoneApp(request: Request, url: URL, env: Env, ctx: ExecutionContext): Promise<Response> {
  if (request.method === "POST" && url.pathname === "/__signin") return signIn(request, env);
  const token = sessionToken(request);
  const session = token ? await sessionByToken(env.DB, token) : null;
  const picked = session?.userId && session.target === null ? await serverById(env.DB, session.serverId) : null;
  if (!token || !session?.userId || !picked || picked.userId !== session.userId) {
    const mac = url.searchParams.get("mac") ?? "";
    if (url.pathname === "/__share" && HANDLE.test(mac)) {
      if (url.searchParams.get("signin") !== "1") {
        return redirect(`https://${mac}.${env.BASE_DOMAIN}/__share${url.search}`);
      }
      url.searchParams.delete("signin");
      return redirect(
        `${new URL(env.WEBSITE_URL).origin}/m`,
        `${NEXT_COOKIE}=${encodeURIComponent(url.pathname + url.search)}; Path=/; Secure; HttpOnly; SameSite=None; Max-Age=900`,
      );
    }
    const file = publicAppFile(request, url, env);
    if (file) return file;
    if (request.method !== "GET" || !wantsHtml(request)) return text("Sign in required\n", 401);
    return redirect(`${new URL(env.WEBSITE_URL).origin}/m`);
  }
  if (request.method === "POST" && url.pathname === "/__mac") {
    return switchMac(request, url, env, token, session.userId);
  }
  if (url.pathname === "/__share") {
    const handle = url.searchParams.get("mac") ?? "";
    const mac = HANDLE.test(handle) ? await serverByHandle(env.DB, handle, true) : null;
    if (!mac || mac.userId !== session.userId || mac.ownerServerId !== null) return text("Not found\n", 404);
    return shareRedirect(env, mac, url, token);
  }
  const cloudPath = CLOUD_PATH.exec(url.pathname)?.[1];
  if (cloudPath !== undefined) return cloud(request, cloudPath, url, env, token);
  if (url.pathname.startsWith("/__")) return text("Not found\n", 404);
  let server = picked;
  if (request.method === "GET" && wantsHtml(request) && !(await isOnline(env, server.handle))) {
    const other = await onlineMac(env, server);
    if (other && (await pickServer(env.DB, token, other))) server = other;
  }
  const proxied =
    request.headers.get("origin") === url.origin ? withOrigin(request, serverOrigin(server, null, env)) : request;
  const response = await forward(proxied, env, ctx, server, null);
  if (response.webSocket) return response;
  const scoped = new Response(response.body, response);
  scoped.headers.set(MAC_HEADER, server.handle);
  return scoped;
}

/**
 * Every cloudroom.run address is one browser site, and any account can serve pages on its own. So no other address may
 * frame ours. A page opened from another address also never gets the offline mark: with it, the phone's service worker
 * shows its saved copy instead, and copies saved before this rule have no frame rule.
 */
function guardFromOtherAddresses(request: Request, response: Response): Response {
  if (response.webSocket) return response;
  const guarded = new Response(response.body, response);
  guarded.headers.append("content-security-policy", "frame-ancestors 'self'");
  if (request.headers.get("sec-fetch-mode") === "navigate" && request.headers.get("sec-fetch-site") === "same-site") {
    guarded.headers.delete(OFFLINE_HEADER);
    guarded.headers.delete(TUNNEL_OFFLINE_HEADER);
  }
  return guarded;
}

/** Port shares serve the owner's own dev servers, which set their own rules. */
function route(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
  const url = new URL(request.url);
  const host = url.hostname.toLowerCase();
  const guard = (response: Response) => guardFromOtherAddresses(request, response);
  if (host === env.BASE_DOMAIN) return apex(request, url, env).then(guard);
  if (host === `${APP_HANDLE}.${env.BASE_DOMAIN}`) return phoneApp(request, url, env, ctx).then(guard);
  const parsed = parseVisitorHost(host, env.BASE_DOMAIN);
  if (!parsed) return Promise.resolve(text("Not found\n", 404));
  const response = visitor(request, url, env, ctx, parsed);
  return parsed.target === null ? response.then(guard) : response;
}

export default {
  async fetch(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
    try {
      return await route(request, env, ctx);
    } catch (error) {
      if (!String((error as Error)?.message).startsWith("D1_ERROR")) throw error;
      console.log({ event: "db_unavailable", message: (error as Error).message });
      return new Response("Cloudroom is busy. Try again in a few seconds.\n", {
        status: 503,
        headers: { "content-type": "text/plain; charset=utf-8", "cache-control": "no-store", "retry-after": "5" },
      });
    }
  },
} satisfies ExportedHandler<Env>;
