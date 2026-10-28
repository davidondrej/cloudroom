// One-time cloud sign-ins to MCP servers that use OAuth (docs/scopes/sandboxes.md). The Mac's own Claude Code login
// stays in its Keychain; this signs in again in the browser, and the website keeps the tokens as Claude Code's
// `mcpOAuth` records for every sandbox. Follows the MCP authorization spec: discovery, client registration, PKCE.
import { createHash, randomBytes } from "node:crypto";
import { CloudroomError } from "./client.js";
import type { McpServer, SandboxAccount } from "./sandboxes.js";

export type RemoteMcpServer = Extract<McpServer, { type: "http" | "sse" }>;
/** Claude Code's record of one MCP sign-in, as it keeps it in .credentials.json. */
export type McpSignIn = {
  serverName: string; serverUrl: string; accessToken: string; refreshToken?: string; expiresAt?: number; scope?: string;
  clientId: string; clientSecret?: string; discoveryState?: { authorizationServerUrl: string; oauthMetadataFound: true; authServerMetadataUrl: null };
};
type Json = Record<string, unknown>;
type Pending = {
  account: SandboxAccount;
  name: string; server: RemoteMcpServer; verifier: string; redirect: string; resource?: string; at: number;
  clientId: string; clientSecret?: string; secretInBody: boolean; tokenUrl: string; issuer: string; metadataFound: boolean;
};

const TIMEOUT_MS = 10_000, SIGN_IN_MS = 10 * 60_000, PROBE_MS = 10 * 60_000;
const pending = new Map<string, Pending>();
const probes = new Map<string, { at: number; needed: Promise<boolean> }>();

export const cancelMcpSignIns = () => pending.clear();

export const isRemoteMcp = (server: McpServer | null): server is RemoteMcpServer => server?.type === "http" || server?.type === "sse";
/** Claude Code files a sign-in under the server's name and a hash of its config; sandboxes re-file it if theirs differs. */
export const mcpSignInKey = (name: string, server: RemoteMcpServer) =>
  `${name}|${createHash("sha256").update(JSON.stringify({ type: server.type, url: server.url, headers: server.headers })).digest("hex").slice(0, 16)}`;

/** A request with no token. Servers that use OAuth answer 401. */
async function knock(server: RemoteMcpServer): Promise<Response> {
  const response = await fetch(server.url, server.type === "sse"
    ? { headers: { accept: "text/event-stream" }, redirect: "manual", signal: AbortSignal.timeout(TIMEOUT_MS) }
    : {
      method: "POST", redirect: "manual", signal: AbortSignal.timeout(TIMEOUT_MS),
      headers: { accept: "application/json, text/event-stream", "content-type": "application/json" },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "cloudroom", version: "1" } } }),
    });
  void response.body?.cancel().catch(() => {});
  return response;
}

/** Whether the server needs an OAuth sign-in. Servers with headers bring their own key, so they never do. */
export function needsMcpSignIn(server: RemoteMcpServer): Promise<boolean> {
  if (Object.keys(server.headers).length) return Promise.resolve(false);
  const cached = probes.get(server.url);
  if (cached && Date.now() - cached.at < PROBE_MS) return cached.needed;
  const needed = knock(server).then(response => response.status === 401, () => false);
  probes.set(server.url, { at: Date.now(), needed });
  return needed;
}

async function getJson(url: string, init: RequestInit = {}): Promise<Json | null> {
  const response = await fetch(url, { ...init, redirect: "follow", signal: AbortSignal.timeout(TIMEOUT_MS), headers: { accept: "application/json", ...init.headers } }).catch(() => null);
  if (!response?.ok) { void response?.body?.cancel().catch(() => {}); return null; }
  const value: unknown = await response.json().catch(() => null);
  return value && typeof value === "object" && !Array.isArray(value) ? value as Json : null;
}
async function firstJson(urls: string[]): Promise<Json | null> {
  for (const url of urls) { const found = await getJson(url); if (found) return found; }
  return null;
}
/** RFC 8414 and OpenID addresses for a URL's metadata, path-aware first. */
function wellKnown(base: string, ...names: string[]): string[] {
  const url = new URL(base), path = url.pathname.replace(/\/$/, "");
  return names.flatMap(name => [`${url.origin}/.well-known/${name}${path}`, ...(path ? [`${url.origin}/.well-known/${name}`] : [])]);
}
const text = (value: unknown) => typeof value === "string" && value ? value : undefined;
const base64url = (bytes: Buffer) => bytes.toString("base64url");

/** Registers Cloudroom with the server's sign-in service and returns the page the user approves in their browser. */
export async function startMcpSignIn(name: string, server: RemoteMcpServer, redirect: string, account: SandboxAccount): Promise<string> {
  for (const [state, login] of pending) if (Date.now() - login.at > SIGN_IN_MS) pending.delete(state);
  const challenge = (await knock(server).catch(() => null))?.headers.get("www-authenticate") ?? "";
  const hinted = /resource_metadata="([^"]+)"/.exec(challenge)?.[1];
  const resource = await firstJson(hinted ? [hinted] : wellKnown(server.url, "oauth-protected-resource"));
  const servers = Array.isArray(resource?.authorization_servers) ? resource.authorization_servers.filter(text) : [];
  // Servers from before protected-resource metadata host their sign-in at their own origin.
  const issuer = servers[0] ?? new URL(server.url).origin;
  const metadata = await firstJson(new URL(issuer).pathname.replace(/\/$/, "")
    ? [...wellKnown(issuer, "oauth-authorization-server", "openid-configuration"), `${issuer.replace(/\/$/, "")}/.well-known/openid-configuration`]
    : wellKnown(issuer, "oauth-authorization-server", "openid-configuration"));
  const endpoint = (key: string, fallback: string) => metadata ? text(metadata[key]) : new URL(fallback, issuer).href;
  const authorizeUrl = endpoint("authorization_endpoint", "/authorize"), tokenUrl = endpoint("token_endpoint", "/token"), registerUrl = endpoint("registration_endpoint", "/register");
  if (!authorizeUrl || !tokenUrl) throw new CloudroomError(`${name} has no sign-in Cloudroom can use. Give it an API key instead.`, 400);
  if (!registerUrl) throw new CloudroomError(`${name} doesn't let new apps sign in by themselves. Give it an API key instead.`, 400);
  const client = await getJson(registerUrl, {
    method: "POST", headers: { "content-type": "application/json" },
    body: JSON.stringify({ client_name: "Cloudroom", redirect_uris: [redirect], grant_types: ["authorization_code", "refresh_token"], response_types: ["code"], token_endpoint_auth_method: "none" }),
  });
  const clientId = text(client?.client_id);
  if (!clientId) throw new CloudroomError(`${name} didn't accept Cloudroom's sign-in. Try again later.`, 502);
  const verifier = base64url(randomBytes(32)), state = base64url(randomBytes(24));
  const scope = /scope="([^"]+)"/.exec(challenge)?.[1] ?? (Array.isArray(resource?.scopes_supported) ? resource.scopes_supported.filter(text).join(" ") : "");
  // RFC 8707: name the server the tokens are for, when it published its metadata.
  const audience = resource ? text(resource.resource) ?? server.url : undefined;
  const url = new URL(authorizeUrl);
  const params = { response_type: "code", client_id: clientId, redirect_uri: redirect, state, code_challenge: base64url(createHash("sha256").update(verifier).digest()), code_challenge_method: "S256", ...(scope ? { scope } : {}), ...(audience ? { resource: audience } : {}) };
  for (const [key, value] of Object.entries(params)) url.searchParams.set(key, value);
  pending.set(state, {
    account, name, server, verifier, redirect, resource: audience, at: Date.now(), clientId, clientSecret: text(client?.client_secret),
    secretInBody: client?.token_endpoint_auth_method === "client_secret_post", tokenUrl, issuer, metadataFound: Boolean(metadata),
  });
  return url.href;
}

/** Trades the browser's answer for tokens. Each sign-in can finish once. */
export async function finishMcpSignIn(query: URLSearchParams, account: SandboxAccount | null): Promise<{ name: string; server: RemoteMcpServer; signIn: McpSignIn; account: SandboxAccount }> {
  const state = query.get("state") ?? "", login = pending.get(state);
  pending.delete(state);
  if (!login || Date.now() - login.at > SIGN_IN_MS) throw new CloudroomError("This sign-in expired. Start it again in Cloudroom.", 400);
  if (!account || account.userId !== login.account.userId || account.website !== login.account.website) throw new CloudroomError("The Cloudroom account changed. Start the sign-in again.", 409);
  const code = query.get("code");
  if (!code) throw new CloudroomError(`${login.name} sign-in was cancelled${query.get("error_description") ? `: ${query.get("error_description")}` : "."}`, 400);
  const body = new URLSearchParams({ grant_type: "authorization_code", code, redirect_uri: login.redirect, client_id: login.clientId, code_verifier: login.verifier, ...(login.resource ? { resource: login.resource } : {}) });
  const headers: Record<string, string> = { "content-type": "application/x-www-form-urlencoded" };
  if (login.clientSecret && login.secretInBody) body.set("client_secret", login.clientSecret);
  else if (login.clientSecret) headers.authorization = `Basic ${Buffer.from(`${encodeURIComponent(login.clientId)}:${encodeURIComponent(login.clientSecret)}`).toString("base64")}`;
  const tokens = await getJson(login.tokenUrl, { method: "POST", headers, body });
  const accessToken = text(tokens?.access_token);
  if (!accessToken) throw new CloudroomError(`${login.name} didn't finish the sign-in. Try again.`, 502);
  const expiresIn = Number(tokens?.expires_in);
  return {
    name: login.name, server: login.server, account: login.account,
    signIn: {
      serverName: login.name, serverUrl: login.server.url, accessToken, refreshToken: text(tokens?.refresh_token),
      expiresAt: Number.isFinite(expiresIn) && expiresIn > 0 ? Date.now() + expiresIn * 1000 : undefined, scope: text(tokens?.scope),
      clientId: login.clientId, clientSecret: login.clientSecret,
      // Claude refreshes through this sign-in service, as after its own browser sign-in.
      ...(login.metadataFound ? { discoveryState: { authorizationServerUrl: login.issuer, oauthMetadataFound: true as const, authServerMetadataUrl: null } } : {}),
    },
  };
}
