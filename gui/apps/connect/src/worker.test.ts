import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { gzipSync } from "node:zlib";
import { build } from "esbuild";
import { Miniflare, Response as MiniflareResponse } from "miniflare";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { decodeFrame, encodeFrame, type Frame } from "@cloudroom/tunnel-contract";
import { OFFLINE_HEADER } from "./pages";
import { GATE_AUTH_HEADER, GATE_MACHINE_ID_HEADER, MACHINE_CREDENTIAL_HEADER, PHONE_SESSION_HEADER, RELAY_SIGNAL_HEADER, SESSION_COOKIE, TUNNEL_SESSION_HEADER, TUNNEL_TARGET_HEADER } from "./protocol-headers";
import { parseVisitorHost, requestForTunnelDo, returnUrl } from "./worker";
import { DESKTOP_SESSION_TTL_MS, KEEP, MACS_PER_ACCOUNT, SESSION_TTL_MS, createShareCode, sha256Hex } from "./store";

type ClientWebSocket = NonNullable<
  Awaited<ReturnType<Miniflare["dispatchFetch"]>>["webSocket"]
>;

const BASE = "cloudroom.test";
const INSTALL_ID = "0123456789abcdef0123456789abcdef";
const DESKTOP_AUTH = `Basic ${Buffer.from("user:token").toString("base64")}`;
const HTML = { accept: "text/html" };
const DIGEST = "a".repeat(64);
const MAC_HEADERS: [string, string][] = [
  ["content-type", "text/html"],
  ["cache-control", "no-store"],
  ["set-cookie", `planted=1; Domain=${BASE}; Path=/`],
  ["clear-site-data", '"cookies"'],
  ["x-bb-artifact-sha256", DIGEST],
];
const seen: { path: string; headers: Record<string, string>; target?: string }[] = [];
let website: (request: Request) => MiniflareResponse = () => MiniflareResponse.json({ userId: "user-1" });
let mf: Miniflare;
let tunnel: ClientWebSocket;
let handle: string;
let credential: string;

async function bundle(): Promise<string> {
  const result = await build({
    entryPoints: [fileURLToPath(new URL("./worker.ts", import.meta.url))],
    bundle: true,
    format: "esm",
    target: "esnext",
    conditions: ["workerd", "worker", "browser"],
    write: false,
  });
  return result.outputFiles[0].text;
}

function fetchRelay(url: string, init: RequestInit = {}) {
  return mf.dispatchFetch(url, { redirect: "manual", ...init } as never);
}

async function register(installId = INSTALL_ID) {
  const response = await fetchRelay(`https://${BASE}/api/register`, {
    method: "POST",
    headers: { authorization: DESKTOP_AUTH, "content-type": "application/json" },
    body: JSON.stringify({ installId }),
  });
  if (response.status !== 200) throw new Error(`register ${response.status}: ${await response.text()}`);
  return (await response.json()) as { handle: string; credential: string; serverUrl: string };
}

async function dial(secret: string) {
  return fetchRelay(`https://${handle}.${BASE}/__tunnel?v=1`, {
    headers: { upgrade: "websocket", authorization: `Bearer ${secret}` },
  });
}

function serveMac(ws: ClientWebSocket): void {
  ws.accept();
  ws.addEventListener("message", (event) => {
    if (typeof event.data === "string") return;
    const frame = decodeFrame(event.data as ArrayBuffer);
    const send = (out: Frame) => ws.send(new Uint8Array(encodeFrame(out)));
    if (frame.type === "ws-data") {
      send(frame);
      return;
    }
    if (frame.type !== "open-http" && frame.type !== "open-ws") return;
    const asked = Object.fromEntries(frame.headers.map(([k, v]) => [k.toLowerCase(), v]));
    seen.push({ path: frame.path, headers: asked, ...(frame.target ? { target: frame.target } : {}) });
    if (frame.type === "open-ws") {
      send({ type: "ws-open-ack", streamId: frame.streamId, protocol: null });
      return;
    }
    if (asked["if-none-match"]) {
      send({ type: "resp-head", streamId: frame.streamId, status: 304, headers: [["etag", asked["if-none-match"]]] });
      send({ type: "body-end", streamId: frame.streamId });
      return;
    }
    const gzip = (asked["accept-encoding"] ?? "").includes("gzip");
    const headers: [string, string][] = frame.path.startsWith("/assets/")
      ? [["cache-control", "public, max-age=31536000"]]
      : [...MAC_HEADERS];
    if (gzip) headers.push(["content-encoding", "gzip"]);
    send({ type: "resp-head", streamId: frame.streamId, status: 200, headers });
    const body = new TextEncoder().encode(`mac:${frame.target ?? "app"}:${frame.path}`);
    send({ type: "body-chunk", streamId: frame.streamId, data: gzip ? gzipSync(body) : body });
    send({ type: "body-end", streamId: frame.streamId });
  });
}

async function phoneCode(machineCredential = credential): Promise<string> {
  const response = await fetchRelay(`https://${BASE}/api/phone-code`, {
    method: "POST",
    headers: { authorization: `Bearer ${machineCredential}` },
  });
  expect(response.status).toBe(200);
  const body = (await response.json()) as { code: string; url: string };
  expect(body.url).toBe(`https://${BASE}/pair?code=${body.code}`);
  return body.code;
}

function cookieFrom(response: { headers: { get(name: string): string | null } }): string {
  const setCookie = response.headers.get("set-cookie") ?? "";
  expect(setCookie).toContain("HttpOnly");
  expect(setCookie).toContain("Secure");
  return setCookie.split(";")[0];
}

async function signInPhone(server = { handle, credential }): Promise<string> {
  const code = await phoneCode(server.credential);
  const apex = await fetchRelay(`https://${BASE}/pair?code=${code}`);
  expect(apex.status).toBe(302);
  const next = apex.headers.get("location")!;
  expect(new URL(next).host).toBe(`${server.handle}.${BASE}`);
  const paired = await fetchRelay(next);
  expect(paired.status).toBe(302);
  expect(paired.headers.get("location")).toBe(`https://${server.handle}.${BASE}/`);
  return cookieFrom(paired);
}

beforeAll(async () => {
  mf = new Miniflare({
    modules: [{ type: "ESModule", path: "/worker.js", contents: await bundle() }],
    modulesRoot: "/",
    scriptPath: "/worker.js",
    compatibilityDate: "2026-06-11",
    compatibilityFlags: ["nodejs_compat"],
    durableObjects: { TUNNEL_DO: "TunnelDO" },
    d1Databases: { DB: "relay-test" },
    bindings: { BASE_DOMAIN: BASE, WEBSITE_URL: "https://website.test", CONNECT_SIGNAL_SECRET: "signal-secret" },
    serviceBindings: { ASSETS: (request: { url: string }) => new MiniflareResponse(`asset:${new URL(request.url).pathname}`) },
    outboundService: (request: unknown) => website(request as Request),
  });
  const db = await mf.getD1Database("DB");
  const migration = ["0001_init.sql", "0002_server_name.sql", "0003_machines.sql", "0004_account_sessions.sql", "0005_vps.sql"]
    .map((file) => readFileSync(fileURLToPath(new URL(`../migrations/${file}`, import.meta.url)), "utf8"))
    .join(";\n");
  for (const statement of migration.replace(/--.*$/gm, "").split(";")) {
    if (statement.trim()) await db.prepare(statement).run();
  }
  ({ handle, credential } = await register());
  const dialed = await dial(credential);
  if (!dialed.webSocket) throw new Error(`tunnel dial failed: ${dialed.status}`);
  tunnel = dialed.webSocket;
  serveMac(tunnel);
}, 60_000);

afterAll(async () => {
  await mf?.dispose();
});

describe("Cloudroom Connect relay", () => {
  it("asks the website who the Mac belongs to before registering it", async () => {
    website = () => new MiniflareResponse("no", { status: 403 });
    const rejected = await fetchRelay(`https://${BASE}/api/register`, {
      method: "POST",
      headers: { authorization: DESKTOP_AUTH },
      body: JSON.stringify({ installId: INSTALL_ID }),
    });
    expect(rejected.status).toBe(401);
    website = () => MiniflareResponse.json({ userId: "user-1" });
    const unsigned = await fetchRelay(`https://${BASE}/api/register`, {
      method: "POST",
      body: JSON.stringify({ installId: INSTALL_ID }),
    });
    expect(unsigned.status).toBe(401);
  });

  it("keeps the address when the same Mac registers again and retires the old credential", async () => {
    const again = await register();
    expect(again.handle).toBe(handle);
    expect(again.credential).not.toBe(credential);
    expect((await dial(credential)).status).toBe(401);
    credential = again.credential;
    const dialed = await dial(credential);
    expect(dialed.status).toBe(101);
    tunnel.close();
    tunnel = dialed.webSocket!;
    serveMac(tunnel);
  });

  it("shows the code page to a phone that is not signed in", async () => {
    const page = await fetchRelay(`https://${handle}.${BASE}/`, { headers: HTML });
    expect(page.status).toBe(401);
    expect(await page.text()).toContain('action="/__pair"');
    const api = await fetchRelay(`https://${handle}.${BASE}/api/v1/threads`);
    expect(api.status).toBe(401);
  });

  it("never lets a Mac show a page or set a cookie for a visitor who is not signed in", async () => {
    const mac = `https://${handle}.${BASE}`;
    for (const url of [`${mac}/favicon.html`, `${mac}/manifest.webmanifest`, `https://app.${BASE}/icon-192.png`]) {
      expect(await (await fetchRelay(url)).text()).toBe(`asset:${new URL(url).pathname}`);
    }
    const downloads = {
      "/install.sh": "text/x-shellscript; charset=utf-8",
      "/install/version": "application/json",
      "/install/bb-app.tgz": "application/gzip",
    };
    for (const [path, type] of Object.entries(downloads)) {
      const download = await fetchRelay(`${mac}${path}`, { headers: { "accept-encoding": "gzip" } });
      expect(await download.text()).toBe(`mac:app:${path}`);
      expect(Object.fromEntries(download.headers)).toMatchObject({
        "content-type": type,
        "content-security-policy": "sandbox, frame-ancestors 'self'",
        "x-content-type-options": "nosniff",
        "x-bb-artifact-sha256": DIGEST,
      });
      expect(download.headers.get("set-cookie")).toBeNull();
      expect(download.headers.get("clear-site-data")).toBeNull();
    }
    const unchanged = await fetchRelay(`${mac}/install/bb-app.tgz`, { headers: { "if-none-match": '"sha256-1"' } });
    expect(unchanged.status).toBe(304);
    expect(unchanged.headers.get("etag")).toBe('"sha256-1"');
  });

  it("lets no other cloudroom.run address frame the app, a Mac, or a relay page", async () => {
    const appCookie = cookieFrom(await fetchRelay(`https://app.${BASE}/__signin`, {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded", origin: "https://website.test" },
      body: new URLSearchParams({ token: "a.b.c" }).toString(),
    }));
    const policies: (string | null)[] = [];
    for (const [url, cookie] of [[`https://${handle}.${BASE}/assets/mac.js`, await signInPhone()], [`https://app.${BASE}/assets/app.js`, appCookie]]) {
      for (const cache of ["miss", "hit"]) {
        const asset = await fetchRelay(url, { headers: { cookie, "accept-encoding": "gzip" } });
        expect(asset.headers.get("x-bb-cache")).toBe(cache);
        expect(await asset.text()).toBe(`mac:app:${new URL(url).pathname}`);
        policies.push(asset.headers.get("content-security-policy"));
      }
    }
    for (const page of [await fetchRelay(`https://app.${BASE}/`, { headers: HTML }), await fetchRelay(`https://${BASE}/pair`)]) {
      policies.push(page.headers.get("content-security-policy"));
    }
    expect(policies).toEqual(Array(6).fill("frame-ancestors 'self'"));
  });

  it("signs a phone in with one code and relays it to the Mac", async () => {
    const cookie = await signInPhone();
    const response = await fetchRelay(`https://${handle}.${BASE}/api/v1/threads`, {
      headers: { cookie: `${cookie}; theme=dark` },
    });
    expect(response.status).toBe(200);
    expect(await response.text()).toBe("mac:app:/api/v1/threads");
    const forwarded = seen.at(-1)!;
    expect(forwarded.headers[GATE_AUTH_HEADER]).toBe("session");
    expect(forwarded.headers.cookie).toBe("theme=dark");
  });

  it("refuses a code twice and rejects wrong codes", async () => {
    const code = await phoneCode();
    const first = await fetchRelay(`https://${handle}.${BASE}/__pair?code=${code}`);
    expect(first.status).toBe(302);
    const second = await fetchRelay(`https://${handle}.${BASE}/__pair?code=${code}`);
    expect(second.status).toBe(400);
    const wrong = await fetchRelay(`https://${BASE}/pair?code=AAAA-AAAA`);
    expect(wrong.status).toBe(400);
  });

  it("opens a shared port after a hop through the signed-in app", async () => {
    const cookie = await signInPhone();
    const share = `https://${handle}--3000.${BASE}`;
    const first = await fetchRelay(`${share}/page?x=1`, { headers: HTML });
    expect(first.status).toBe(302);
    const hop = first.headers.get("location")!;
    expect(hop).toBe(
      `https://app.${BASE}/__share?mac=${handle}&port=3000&return=%2Fpage%3Fx%3D1`,
    );
    const legacy = (await fetchRelay(hop, { headers: HTML })).headers.get("location")!;
    expect(legacy).toBe(`https://${handle}.${BASE}/__share?mac=${handle}&port=3000&return=%2Fpage%3Fx%3D1`);
    const ticket = await fetchRelay(legacy, { headers: { cookie } });
    expect(ticket.status).toBe(302);
    const pair = await fetchRelay(ticket.headers.get("location")!);
    expect(pair.headers.get("location")).toBe(`${share}/page?x=1`);
    const shareCookie = cookieFrom(pair);
    const page = await fetchRelay(`${share}/page?x=1`, { headers: { cookie: shareCookie } });
    expect(await page.text()).toBe("mac:3000:/page?x=1");
    expect(page.headers.get("content-security-policy")).toBeNull();
    expect(seen.at(-1)!.headers[TUNNEL_TARGET_HEADER]).toBeUndefined();
    const app = await fetchRelay(`https://${handle}.${BASE}/`, { headers: { cookie: shareCookie } });
    expect(app.status).toBe(401);
  });

  it("sends a phone back only to the shared port's own host after the code", async () => {
    const app = `https://app.${BASE}`;
    const cookie = cookieFrom(await fetchRelay(`${app}/__signin`, {
      method: "POST",
      headers: { origin: "https://website.test", "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({ token: "a.b.c" }).toString(),
    }));
    const share = `https://${handle}--3000.${BASE}`;
    const ticket = async (query = "") =>
      (await fetchRelay(`${app}/__share?mac=${handle}&port=3000${query}`, { headers: { cookie } })).headers.get("location")!;
    const reported = await fetchRelay(await ticket("&return=%2F%09%2Fevil.example"));
    expect(reported.status).toBe(302);
    expect(reported.headers.get("location")).toBe(`${share}/`);
    for (const [back, lands] of [
      ["/\n/evil.example", `${share}/`],
      [`blob:${share}/id`, `${share}/`],
      ["/a/..//evil.example", `${share}//evil.example`],
      ["/page\u0000\u007f?x", `${share}/page%00%7F?x`],
    ]) {
      const link = new URL(await ticket());
      link.searchParams.set("return", back);
      const pair = await fetchRelay(link.toString());
      expect(pair.status).toBe(302);
      expect(pair.headers.get("location")).toBe(lands);
      const page = await fetchRelay(lands, { headers: { cookie: cookieFrom(pair) } });
      expect(page.status).toBe(200);
    }
  });

  it("signs every phone out when the Mac asks", async () => {
    const otherMac = await register("fedcba9876543210fedcba9876543210");
    const otherTunnelResponse = await fetchRelay(`${otherMac.serverUrl}/__tunnel?v=1`, {
      headers: { upgrade: "websocket", authorization: `Bearer ${otherMac.credential}` },
    });
    expect(otherTunnelResponse.status).toBe(101);
    const otherTunnel = otherTunnelResponse.webSocket!;
    serveMac(otherTunnel);
    const otherCookie = await signInPhone(otherMac);
    const unusedCode = await phoneCode(otherMac.credential);
    const opened = await fetchRelay(`https://${BASE}/api/computers/open`, {
      method: "POST",
      headers: { authorization: `Bearer ${credential}`, "content-type": "application/json" },
      body: JSON.stringify({ handle: otherMac.handle }),
    });
    expect(opened.status).toBe(200);
    const { cookie: desktop } = (await opened.json()) as { cookie: { name: string; value: string } };
    const desktopCookie = `${desktop.name}=${desktop.value}`;
    expect((await fetchRelay(`${otherMac.serverUrl}/x`, { headers: { cookie: desktopCookie } })).status).toBe(200);
    website = () => MiniflareResponse.json({ userId: "user-2" });
    const strangerMac = await register("66666666666666666666666666666666");
    website = () => MiniflareResponse.json({ userId: "user-1" });
    const strangerTunnel = (await fetchRelay(`${strangerMac.serverUrl}/__tunnel?v=1`, {
      headers: { upgrade: "websocket", authorization: `Bearer ${strangerMac.credential}` },
    })).webSocket!;
    serveMac(strangerTunnel);
    const strangerCookie = await signInPhone(strangerMac);
    const cookie = await signInPhone();
    const secondCookie = await signInPhone();
    const share = await fetchRelay(`https://${handle}.${BASE}/__share?port=3000`, {
      headers: { cookie },
    });
    const shareCookie = cookieFrom(await fetchRelay(share.headers.get("location")!));
    const unusedTicket = (await fetchRelay(`https://${handle}.${BASE}/__share?port=3000`, {
      headers: { cookie },
    })).headers.get("location")!;
    const asMac = { authorization: `Bearer ${credential}`, "content-type": "application/json" };
    const machine = (await (await fetchRelay(`https://${BASE}/api/machines`, { method: "POST", headers: asMac, body: "{}" }))
      .json()) as { machineId: string; credential: string };
    const { label } = (await (await fetchRelay(`https://${BASE}/api/connect/machine-label`, {
      method: "POST",
      headers: { [MACHINE_CREDENTIAL_HEADER]: machine.credential, "content-type": "application/json" },
      body: "{}",
    })).json()) as { label: string };
    const db = await mf.getD1Database("DB");
    const untaggedShare = "d".repeat(64);
    await db.prepare("INSERT INTO session (token_hash, server_id, target, expires_at, created_at) VALUES (?, ?, '5173', ?, ?)")
      .bind(await sha256Hex(untaggedShare), machine.machineId, Date.now() + 60_000, Date.now()).run();
    const hostShare = () => fetchRelay(`https://${label}--5173.${BASE}/x`, {
      headers: { cookie: `${SESSION_COOKIE}=${untaggedShare}` },
    });
    expect((await hostShare()).status).toBe(503);
    const addresses = [
      { url: `https://${handle}.${BASE}/ws`, cookie },
      { url: `https://${handle}.${BASE}/ws/terminals/test`, cookie: secondCookie },
      { url: `https://${handle}--3000.${BASE}/ws`, cookie: shareCookie },
    ];
    const sockets = await Promise.all(addresses.map(async (address) => {
      const response = await fetchRelay(address.url, {
        headers: { upgrade: "websocket", cookie: address.cookie },
      });
      expect(response.status).toBe(101);
      const socket = response.webSocket!;
      socket.accept();
      const echoed = new Promise<unknown>((resolve) => {
        socket.addEventListener("message", (event) => resolve(event.data), { once: true });
      });
      socket.send("before sign-out");
      expect(await echoed).toBe("before sign-out");
      return socket;
    }));
    expect(seen.every((entry) => entry.headers[TUNNEL_SESSION_HEADER] === undefined)).toBe(true);
    const delayedUpgrade = requestForTunnelDo(new Request(addresses[0]!.url, {
      headers: { upgrade: "websocket", cookie },
    }), null);
    const namespace = await mf.getDurableObjectNamespace("TUNNEL_DO");
    const stub = namespace.get(namespace.idFromName(handle));
    const closed = sockets.map((socket) => new Promise<void>((resolve) => {
      socket.addEventListener("close", () => {
        socket.close();
        resolve();
      }, { once: true });
    }));
    const revoke = await fetchRelay(`https://${BASE}/api/phone-sessions/revoke`, {
      method: "POST",
      headers: { authorization: `Bearer ${credential}` },
    });
    expect(revoke.status).toBe(200);
    expect(((await revoke.json()) as { revoked: number }).revoked).toBeGreaterThan(0);
    await Promise.race([
      Promise.all(closed),
      new Promise<never>((_, reject) => setTimeout(() => reject(new Error("Signed-out sockets stayed open")), 1000)),
    ]);
    const delayedReconnect = await stub.fetch(delayedUpgrade.url, {
      headers: Object.fromEntries(delayedUpgrade.headers),
    });
    expect(delayedReconnect.status).toBe(401);
    for (const address of addresses) {
      const reconnect = await fetchRelay(address.url, {
        headers: { upgrade: "websocket", cookie: address.cookie },
      });
      expect(reconnect.status).toBe(401);
    }
    const after = await fetchRelay(`https://${handle}.${BASE}/x`, { headers: { cookie } });
    expect(after.status).toBe(401);
    for (const signedOut of [otherCookie, desktopCookie]) {
      expect((await fetchRelay(`${otherMac.serverUrl}/x`, { headers: { cookie: signedOut } })).status).toBe(401);
    }
    expect((await fetchRelay(`https://${BASE}/pair?code=${unusedCode}`)).status).toBe(400);
    expect((await fetchRelay(unusedTicket)).status).toBe(400);
    expect((await hostShare()).status).toBe(401);
    const mac = (await db.prepare("SELECT id FROM server WHERE handle = ?").bind(handle).first<{ id: string }>())!;
    expect(await createShareCode(db, mac.id, "3000", "user-1", cookie.slice(`${SESSION_COOKIE}=`.length))).toBeNull();
    const stranger = await fetchRelay(`${strangerMac.serverUrl}/x`, { headers: { cookie: strangerCookie } });
    expect(await stranger.text()).toBe("mac:app:/x");
    otherTunnel.close();
    strangerTunnel.close();

    const newCookie = await signInPhone();
    const working = await fetchRelay(`https://${handle}.${BASE}/x`, { headers: { cookie: newCookie } });
    expect(await working.text()).toBe("mac:app:/x");
    await db.prepare("DELETE FROM session WHERE token_hash = ?")
      .bind(await sha256Hex(newCookie.split("=")[1]!)).run();
    const expired = await fetchRelay(`https://${handle}.${BASE}/x`, { headers: { cookie: newCookie } });
    expect(expired.status).toBe(401);
    const expiredSocket = await fetchRelay(`https://${handle}.${BASE}/ws`, {
      headers: { upgrade: "websocket", cookie: newCookie },
    });
    expect(expiredSocket.status).toBe(401);
  });

  it("passes a signed-in phone's cloud requests to the website with its session", async () => {
    const cookie = await signInPhone();
    const token = cookie.slice(`${SESSION_COOKIE}=`.length);
    let forwarded: { url: string; method: string; session: string | null; body: string } | null = null;
    website = (request) => {
      forwarded = { url: request.url, method: request.method, session: request.headers.get(PHONE_SESSION_HEADER), body: "" };
      return MiniflareResponse.json({ threads: [] });
    };
    const response = await fetchRelay(`https://${handle}.${BASE}/__cloud/threads?x=1`, { headers: { cookie } });
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ threads: [] });
    expect(forwarded).toEqual({ url: "https://website.test/api/connect/cloud/threads?x=1", method: "GET", session: token, body: "" });
    const post = (origin: string) => fetchRelay(`https://${handle}.${BASE}/__cloud/threads/thr_a`, {
      method: "POST",
      headers: { cookie, origin, "content-type": "application/json" },
      body: JSON.stringify({ action: "stop" }),
    });
    expect((await post("https://evil.test")).status).toBe(403);
    expect((await post(`https://${handle}.${BASE}`)).status).toBe(200);
    expect(forwarded).toMatchObject({ url: "https://website.test/api/connect/cloud/threads/thr_a", method: "POST", session: token });
    const anonymous = await fetchRelay(`https://${handle}.${BASE}/__cloud/threads`);
    expect(anonymous.status).toBe(401);
    const encoded = await fetchRelay(`https://${handle}.${BASE}/__cloud/threads%2F..%2Fadmin`, { headers: { cookie } });
    expect(encoded.status).toBe(404);
    website = () => MiniflareResponse.json({ userId: "user-1" });
  });

  it("tells the website whose phone session it is, for app sessions only", async () => {
    const token = (await signInPhone()).slice(`${SESSION_COOKIE}=`.length);
    const known = await fetchRelay(`https://${BASE}/api/phone-session`, { headers: { authorization: `Bearer ${token}` } });
    expect(await known.json()).toEqual({ userId: "user-1" });
    const unknown = await fetchRelay(`https://${BASE}/api/phone-session`, { headers: { authorization: `Bearer ${"0".repeat(64)}` } });
    expect(unknown.status).toBe(401);
    const garbage = await fetchRelay(`https://${BASE}/api/phone-session`, { headers: { authorization: "Bearer nope" } });
    expect(garbage.status).toBe(401);
  });

  it("lets a remote host run threads for the Mac and share its own ports", async () => {
    const asMac = { authorization: `Bearer ${credential}`, "content-type": "application/json" };
    const added = await fetchRelay(`https://${BASE}/api/machines`, {
      method: "POST",
      headers: asMac,
      body: JSON.stringify({ name: "MacBook Air" }),
    });
    expect(added.status).toBe(200);
    const machine = (await added.json()) as { machineId: string; credential: string; serverUrl: string };
    expect(machine.serverUrl).toBe(`https://${handle}.${BASE}`);
    const asMachine = { [MACHINE_CREDENTIAL_HEADER]: machine.credential };

    const notAMac = await fetchRelay(`https://${BASE}/api/phone-code`, {
      method: "POST",
      headers: { authorization: `Bearer ${machine.credential}` },
    });
    expect(notAMac.status).toBe(401);

    const api = await fetchRelay(`https://${handle}.${BASE}/internal/session/open`, { method: "POST", headers: asMachine });
    expect(await api.text()).toBe("mac:app:/internal/session/open");
    expect(seen.at(-1)!.headers[GATE_AUTH_HEADER]).toBe("machine");
    expect(seen.at(-1)!.headers[GATE_MACHINE_ID_HEADER]).toBe(machine.machineId);
    expect(seen.at(-1)!.headers[MACHINE_CREDENTIAL_HEADER]).toBeUndefined();
    const socket = await fetchRelay(`https://${handle}.${BASE}/internal/ws`, {
      headers: { upgrade: "websocket", ...asMachine },
    });
    expect(socket.status).toBe(101);
    socket.webSocket!.accept();
    socket.webSocket!.close();
    const otherMac = await register("fedcba9876543210fedcba9876543210");
    const elsewhere = await fetchRelay(`${otherMac.serverUrl}/internal/session/open`, { method: "POST", headers: asMachine });
    expect(elsewhere.status).toBe(403);
    const manage = await fetchRelay(`https://${handle}.${BASE}/api/v1/hosts/join-codes`, { method: "POST", headers: asMachine });
    expect(manage.status).toBe(403);
    expect((await fetchRelay(`https://${handle}.${BASE}/internal/session/open`, { method: "POST" })).status).toBe(404);
    expect(await (await fetchRelay(`https://${handle}.${BASE}/install.sh`)).text()).toBe("mac:app:/install.sh");

    const labeled = await fetchRelay(`https://${BASE}/api/connect/machine-label`, {
      method: "POST",
      headers: { ...asMachine, "content-type": "application/json" },
      body: JSON.stringify({ desiredName: "MacBook Air" }),
    });
    const { label } = (await labeled.json()) as { label: string };
    const machineTunnel = await fetchRelay(`https://${label}.${BASE}/__tunnel?v=1`, {
      headers: { upgrade: "websocket", authorization: `Bearer ${machine.credential}` },
    });
    expect(machineTunnel.status).toBe(101);
    serveMac(machineTunnel.webSocket!);

    const cookie = await signInPhone();
    const share = `https://${label}--5173.${BASE}`;
    const first = await fetchRelay(`${share}/app`, { headers: HTML });
    expect(first.headers.get("location")).toBe(
      `https://app.${BASE}/__share?mac=${handle}&port=5173&machine=${label}&return=%2Fapp`,
    );
    const legacy = (await fetchRelay(first.headers.get("location")!, { headers: HTML })).headers.get("location")!;
    const otherCookie = await signInPhone(otherMac);
    const stolenHop = await fetchRelay(`${otherMac.serverUrl}/__share?port=5173&machine=${label}`, {
      headers: { cookie: otherCookie },
    });
    expect(stolenHop.status).toBe(404);
    const ticket = await fetchRelay(legacy, { headers: { cookie } });
    const shareCookie = cookieFrom(await fetchRelay(ticket.headers.get("location")!));
    expect(await (await fetchRelay(`${share}/app`, { headers: { cookie: shareCookie } })).text()).toBe("mac:5173:/app");
    expect((await fetchRelay(`https://${label}.${BASE}/`, { headers: { cookie } })).status).toBe(404);

    const listed = await fetchRelay(`https://${BASE}/api/computers`, { method: "POST", headers: asMac });
    const { computers } = (await listed.json()) as { computers: { handle: string }[] };
    expect(computers.map((computer) => computer.handle)).not.toContain(label);

    const revoked = await fetchRelay(`https://${BASE}/api/machines/revoke`, {
      method: "POST",
      headers: asMac,
      body: JSON.stringify({ machineId: machine.machineId }),
    });
    expect(revoked.status).toBe(200);
    const after = await fetchRelay(`https://${handle}.${BASE}/internal/session/open`, { method: "POST", headers: asMachine });
    expect(after.status).toBe(403);
    machineTunnel.webSocket!.close();
  });

  it("keeps a remote host away from the Mac's relay key and its other Macs, however the path is written", async () => {
    const added = await fetchRelay(`https://${BASE}/api/machines`, {
      method: "POST",
      headers: { authorization: `Bearer ${credential}`, "content-type": "application/json" },
      body: JSON.stringify({ name: "Build box" }),
    });
    const machine = (await added.json()) as { credential: string };
    const call = (path: string, headers: Record<string, string> = {}) =>
      fetchRelay(`https://${handle}.${BASE}${path}`, {
        method: "POST",
        headers: { [MACHINE_CREDENTIAL_HEADER]: machine.credential, "content-type": "application/json", ...headers },
        body: "null",
      });
    for (const path of [
      "/api/v1/plugins/connect/rpc/relayCredential",
      "/api/v1/plugins/connect/rpc/%72elayCredential",
      "/api/v1/plugins/%63onnect/rpc/revokeMachine",
      "/api/v1/plugins/connect/rpc/runSetupJob",
      "/api/v1/plugins/connect/rpc/setupJobStatus",
      "/api/v1/plugins/connect/rpc/macs",
      "/api/v1/host%73/join-codes",
      "/api/v1/plugins/connect/rpc/%E0%A4%A",
    ]) {
      expect((await call(path)).status, path).toBe(403);
    }
    const forged = await call("/api/v1/plugins/connect/rpc/status", { [GATE_AUTH_HEADER]: "session" });
    expect(await forged.text()).toBe("mac:app:/api/v1/plugins/connect/rpc/status");
    expect(seen.at(-1)!.headers[GATE_AUTH_HEADER]).toBe("machine");

    const cookie = await signInPhone();
    for (const method of ["macs", "runSetupJob", "setupJobStatus"]) {
      const path = `/api/v1/plugins/connect/rpc/${method}`;
      const phone = await fetchRelay(`https://${handle}.${BASE}${path}`, {
        method: "POST",
        headers: { cookie, "content-type": "application/json" },
        body: "null",
      });
      expect(await phone.text()).toBe(`mac:app:${path}`);
      expect(seen.at(-1)!.headers[GATE_AUTH_HEADER]).toBe("session");
    }
  });

  it("signs phones in with the account only from the website, keeps them to its Macs, and signs them all out", async () => {
    const app = `https://app.${BASE}`;
    const signIn = (origin?: string) => fetchRelay(`${app}/__signin`, {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded", ...(origin ? { origin } : {}) },
      body: new URLSearchParams({ token: "a.b.c" }).toString(),
    });
    website = () => MiniflareResponse.json({ userId: "user-1" });
    expect((await signIn()).headers.get("set-cookie")).toBeNull();
    expect((await signIn("https://evil.test")).headers.get("set-cookie")).toBeNull();
    const cookie = cookieFrom(await signIn("https://website.test"));

    website = () => MiniflareResponse.json({ userId: "user-2" });
    const stranger = await register("33333333333333333333333333333333");
    website = () => MiniflareResponse.json({ userId: "user-1" });
    const pick = await fetchRelay(`${app}/__mac`, {
      method: "POST",
      headers: { cookie, origin: app, "content-type": "application/json" },
      body: JSON.stringify({ handle: stranger.handle }),
    });
    expect(pick.status).toBe(404);
    expect((await fetchRelay(`${app}/__share?mac=${stranger.handle}&port=3000`, { headers: { cookie } })).status).toBe(404);

    const ticket = await fetchRelay(`${app}/__share?mac=${handle}&port=3000&return=%2F`, { headers: { cookie } });
    const shareCookie = cookieFrom(await fetchRelay(ticket.headers.get("location")!));
    const share = `https://${handle}--3000.${BASE}/`;
    expect((await fetchRelay(share, { headers: { cookie: shareCookie } })).status).toBe(200);
    const revoke = await fetchRelay(`https://${BASE}/api/phone-sessions/revoke`, {
      method: "POST",
      headers: { authorization: `Bearer ${credential}` },
    });
    expect(revoke.status).toBe(200);
    expect((await fetchRelay(share, { headers: { cookie: shareCookie } })).status).toBe(401);
    expect((await fetchRelay(`${app}/`, { headers: { ...HTML, cookie } })).headers.get("location")).toBe("https://website.test/m");
  });

  it("retires a Mac's key when it signs out or signs in to another account", async () => {
    const asMac = (key: string, path: string, body: unknown = {}) => fetchRelay(`https://${BASE}${path}`, {
      method: "POST",
      headers: { authorization: `Bearer ${key}`, "content-type": "application/json" },
      body: JSON.stringify(body),
    });
    const leaving = await register("44444444444444444444444444444444");
    expect((await asMac(leaving.credential, "/api/computers/open", { handle })).status).toBe(200);
    expect((await asMac(leaving.credential, "/api/unregister")).status).toBe(200);
    expect((await asMac(leaving.credential, "/api/computers")).status).toBe(401);
    expect((await asMac(leaving.credential, "/api/computers/open", { handle })).status).toBe(401);

    const before = await register("55555555555555555555555555555555");
    website = () => MiniflareResponse.json({ userId: "user-2" });
    const after = await register("55555555555555555555555555555555");
    website = () => MiniflareResponse.json({ userId: "user-1" });
    expect((await asMac(before.credential, "/api/computers")).status).toBe(401);
    const listed = await asMac(after.credential, "/api/computers");
    const { computers } = (await listed.json()) as { computers: { handle: string }[] };
    expect(computers.map((computer) => computer.handle)).not.toContain(handle);
  });

  it("keeps the newest sign-ins of each kind, and one kind never signs out another", async () => {
    website = () => MiniflareResponse.json({ userId: "user-limits" });
    try {
      const a = await register("a".repeat(32));
      const b = await register("b".repeat(32));
      const bTunnel = (await fetchRelay(`${b.serverUrl}/__tunnel?v=1`, {
        headers: { upgrade: "websocket", authorization: `Bearer ${b.credential}` },
      })).webSocket!;
      serveMac(bTunnel);
      const db = await mf.getD1Database("DB");
      const idOf = async (mac: { handle: string }) =>
        (await db.prepare("SELECT id FROM server WHERE handle = ?").bind(mac.handle).first<{ id: string }>())!.id;
      const [aId, bId] = [await idOf(a), await idOf(b)];
      const app = `https://app.${BASE}`;
      const signIn = async () => cookieFrom(await fetchRelay(`${app}/__signin`, {
        method: "POST",
        headers: { origin: "https://website.test", "content-type": "application/x-www-form-urlencoded" },
        body: new URLSearchParams({ token: "a.b.c" }).toString(),
      }));
      const openB = async () => {
        const opened = await fetchRelay(`https://${BASE}/api/computers/open`, {
          method: "POST",
          headers: { authorization: `Bearer ${a.credential}`, "content-type": "application/json" },
          body: JSON.stringify({ handle: b.handle }),
        });
        expect(opened.status).toBe(200);
        const { cookie } = (await opened.json()) as { cookie: { name: string; value: string } };
        return `${cookie.name}=${cookie.value}`;
      };
      const share = async (phone: string) => {
        const ticket = await fetchRelay(`${app}/__share?mac=${a.handle}&port=3000&return=%2F`, { headers: { cookie: phone } });
        return cookieFrom(await fetchRelay(ticket.headers.get("location")!));
      };
      const hashOf = (cookie: string) => sha256Hex(cookie.slice(cookie.indexOf("=") + 1));
      const live = async (...cookies: string[]) => Promise.all(cookies.map(async (cookie) =>
        (await db.prepare("SELECT 1 FROM session WHERE token_hash = ?").bind(await hashOf(cookie)).first()) !== null));
      const count = async (where: string, owner: string) =>
        (await db.prepare(`SELECT COUNT(*) AS n FROM session WHERE ${where}`).bind(owner).first<{ n: number }>())!.n;
      // Rows of one kind, newer than the next real one, as if its request reached the database late.
      const fill = async (n: number, serverId: string, target: string | null, userId: string | null, ttl: number) => {
        const start = Date.now() + 60 * 60_000;
        await db.batch(Array.from({ length: n }, (_, i) => db
          .prepare("INSERT INTO session (token_hash, server_id, target, expires_at, created_at, user_id) VALUES (?, ?, ?, ?, ?, ?)")
          .bind(crypto.randomUUID().replaceAll("-", "").repeat(2), serverId, target, start + i + ttl, start + i, userId)));
      };

      // Only Macs can be opened: a remote host's or VPS's address serves no app.
      const asA = { authorization: `Bearer ${a.credential}`, "content-type": "application/json" };
      expect((await fetchRelay(`https://${BASE}/api/machines`, { method: "POST", headers: asA, body: "{}" })).status).toBe(200);
      await db.prepare("INSERT INTO server (id, user_id, install_id, handle, credential_hash, kind, created_at) VALUES ('limits-vps', 'user-limits', 'vps-user-limits', 'limitsvps', 'hash-limits-vps', 'vps', ?)")
        .bind(Date.now()).run();
      const hostHandle = (await db.prepare("SELECT handle FROM server WHERE owner_server_id = ?").bind(aId).first<{ handle: string }>())!.handle;
      for (const target of [hostHandle, "limitsvps"]) {
        const opened = await fetchRelay(`https://${BASE}/api/computers/open`, { method: "POST", headers: asA, body: JSON.stringify({ handle: target }) });
        expect(opened.status).toBe(404);
      }
      const others = async () =>
        (await db.prepare("SELECT COUNT(*) AS n FROM session WHERE server_id NOT IN (?, ?) AND user_id IS NOT 'user-limits'").bind(aId, bId).first<{ n: number }>())!.n;
      const othersBefore = await others();

      // One sign-in of each kind, a day older than everything else, so each is the oldest of its kind.
      const phone = await signIn();
      const desktop = await openB();
      const paired = await signInPhone(a);
      const shared = await share(phone);
      for (const cookie of [phone, desktop, paired, shared]) {
        await db.prepare("UPDATE session SET created_at = created_at - 86400000, expires_at = expires_at - 86400000 WHERE token_hash = ?")
          .bind(await hashOf(cookie)).run();
      }

      await fill(KEEP.macToMac.newest, bId, null, null, DESKTOP_SESSION_TTL_MS);
      const desktop2 = await openB();
      expect(await count(`server_id = ? AND target IS NULL AND user_id IS NULL AND expires_at - created_at = ${DESKTOP_SESSION_TTL_MS}`, bId))
        .toBe(KEEP.macToMac.newest);
      expect((await fetchRelay(`${b.serverUrl}/x`, { headers: { cookie: desktop } })).status).toBe(401);
      expect(await (await fetchRelay(`${b.serverUrl}/x`, { headers: { cookie: desktop2 } })).text()).toBe("mac:app:/x");
      expect(await live(phone, paired, shared)).toEqual([true, true, true]);

      // Too many already (as before this limit): a wrong code ends none of them, the next pairing trims them.
      const pairedOnA = () => count(`server_id = ? AND target IS NULL AND user_id IS NULL AND expires_at - created_at = ${SESSION_TTL_MS}`, aId);
      await fill(KEEP.pairedPhones.newest + 5, aId, null, null, SESSION_TTL_MS);
      expect((await fetchRelay(`https://${a.handle}.${BASE}/__pair?code=ZZZZ-ZZZZ`)).status).toBe(400);
      expect(await pairedOnA()).toBe(KEEP.pairedPhones.newest + 6);
      const paired2 = await signInPhone(a);
      expect(await pairedOnA()).toBe(KEEP.pairedPhones.newest);
      expect(await live(paired, paired2)).toEqual([false, true]);
      expect(await live(phone, shared, desktop2)).toEqual([true, true, true]);

      await fill(KEEP.shares.newest, aId, "3000", "user-limits", SESSION_TTL_MS);
      const shared2 = await share(phone);
      expect(await count("user_id = ? AND target IS NOT NULL", "user-limits")).toBe(KEEP.shares.newest);
      expect(await live(shared, shared2)).toEqual([false, true]);
      expect(await live(phone, paired2, desktop2)).toEqual([true, true, true]);

      await fill(KEEP.phones.newest, bId, null, "user-limits", SESSION_TTL_MS);
      const phone2 = await signIn();
      expect(await count("user_id = ? AND target IS NULL", "user-limits")).toBe(KEEP.phones.newest);
      expect(await live(phone, phone2)).toEqual([false, true]);
      expect(await live(shared2, paired2, desktop2)).toEqual([true, true, true]);
      expect(await others()).toBe(othersBefore);
      bTunnel.close();
    } finally {
      website = () => MiniflareResponse.json({ userId: "user-1" });
    }
  });

  it("keeps the newest unused codes of each kind", async () => {
    website = () => MiniflareResponse.json({ userId: "user-codes" });
    try {
      const mac = await register("c".repeat(32));
      const otherMac = await register("2".repeat(32));
      const db = await mf.getD1Database("DB");
      const idOf = async (server: { handle: string }) =>
        (await db.prepare("SELECT id FROM server WHERE handle = ?").bind(server.handle).first<{ id: string }>())!.id;
      const [macId, otherMacId, strangerMacId] = [await idOf(mac), await idOf(otherMac), await idOf({ handle })];
      // Phone codes count per account: the oldest ones are on the account's other Mac.
      const alphabet = "ABCDEFGHJKMNPQRSTVWXYZ23456789";
      const old = Array.from({ length: KEEP.phoneCodes.newest }, (_, i) => `TEST${alphabet[i]}AAA`);
      await db.batch(await Promise.all(old.map(async (code, i) => db
        .prepare("INSERT INTO code (code_hash, server_id, target, expires_at) VALUES (?, ?, NULL, ?)")
        .bind(await sha256Hex(code), i < 10 ? otherMacId : macId, Date.now() + 20 * 60_000 + i))));
      const stranger = "STRANGE2";
      await db.prepare("INSERT INTO code (code_hash, server_id, target, expires_at) VALUES (?, ?, NULL, ?)")
        .bind(await sha256Hex(stranger), strangerMacId, Date.now() + 5 * 60_000).run();
      const code = await phoneCode(mac.credential);
      const codes = async (where: string, owner: string) =>
        (await db.prepare(`SELECT COUNT(*) AS n FROM code WHERE ${where}`).bind(owner).first<{ n: number }>())!.n;
      expect(await codes("server_id IN (SELECT id FROM server WHERE user_id = ?) AND target IS NULL", "user-codes"))
        .toBe(KEEP.phoneCodes.newest);
      expect((await fetchRelay(`https://${BASE}/pair?code=${stranger}`)).status).toBe(302);
      expect((await fetchRelay(`https://${BASE}/pair?code=${old[0]}`)).status).toBe(400);
      expect((await fetchRelay(`https://${BASE}/pair?code=${old[1]}`)).status).toBe(302);
      expect((await fetchRelay(`https://${BASE}/pair?code=${code}`)).status).toBe(302);

      const phone = cookieFrom(await fetchRelay(`https://app.${BASE}/__signin`, {
        method: "POST",
        headers: { origin: "https://website.test", "content-type": "application/x-www-form-urlencoded" },
        body: new URLSearchParams({ token: "a.b.c" }).toString(),
      }));
      await db.batch(Array.from({ length: KEEP.shareCodes.newest }, (_, i) => db
        .prepare("INSERT INTO code (code_hash, server_id, target, expires_at, user_id) VALUES (?, ?, '3000', ?, 'user-codes')")
        .bind(`ticket-${i}`, macId, Date.now() + 2 * 60_000 + i)));
      expect(await createShareCode(db, macId, "3000", "user-codes", "f".repeat(64))).toBeNull();
      expect(await codes("user_id = ? AND target IS NOT NULL", "user-codes")).toBe(KEEP.shareCodes.newest);
      const ticket = await fetchRelay(`https://app.${BASE}/__share?mac=${mac.handle}&port=3000&return=%2F`, { headers: { cookie: phone } });
      expect(await codes("user_id = ? AND target IS NOT NULL", "user-codes")).toBe(KEEP.shareCodes.newest);
      expect(await codes("code_hash = ?", "ticket-0")).toBe(0);
      expect((await fetchRelay(ticket.headers.get("location")!)).status).toBe(302);
    } finally {
      website = () => MiniflareResponse.json({ userId: "user-1" });
    }
  });

  it("refuses a new Mac past the account's limit, but always takes back a Mac it knows", async () => {
    website = () => MiniflareResponse.json({ userId: "user-macs" });
    try {
      const db = await mf.getD1Database("DB");
      const now = Date.now();
      await db.batch(Array.from({ length: MACS_PER_ACCOUNT - 3 }, (_, i) => db
        .prepare("INSERT INTO server (id, user_id, install_id, handle, credential_hash, created_at) VALUES (?, 'user-macs', ?, ?, ?, ?)")
        .bind(`macs-${i}`, String(i).padStart(32, "0"), `macs${i}`, `hash-macs-${i}`, now)));
      // A VPS is not a Mac, so it doesn't count.
      await db.prepare("INSERT INTO server (id, user_id, install_id, handle, credential_hash, kind, created_at) VALUES ('macs-vps', 'user-macs', 'vps-user-macs', 'macsvps', 'hash-macs-vps', 'vps', ?)")
        .bind(now).run();
      // Five new installs at once, with room for three.
      const installs = ["d", "e", "8", "9", "1"].map((digit) => digit.repeat(32));
      const tries = await Promise.all(installs.map((installId) => fetchRelay(`https://${BASE}/api/register`, {
        method: "POST",
        headers: { authorization: DESKTOP_AUTH, "content-type": "application/json" },
        body: JSON.stringify({ installId }),
      })));
      expect(tries.map((response) => response.status).sort()).toEqual([200, 200, 200, 409, 409]);
      const refused = tries.find((response) => response.status === 409)!;
      expect(((await refused.json()) as { error: string }).error).toContain(`(${MACS_PER_ACCOUNT})`);
      expect((await register("0".repeat(32))).handle).toBe("macs0");
      const joined = installs[tries.findIndex((response) => response.status === 200)]!;
      const first = (await tries.find((response) => response.status === 200)!.json()) as { handle: string };
      expect((await register(joined)).handle).toBe(first.handle);
    } finally {
      website = () => MiniflareResponse.json({ userId: "user-1" });
    }
  });

  it("never lets requests at the same time pass a Mac's remote-host limit", async () => {
    const mac = await register("f".repeat(32));
    const added = await Promise.all(Array.from({ length: 25 }, () => fetchRelay(`https://${BASE}/api/machines`, {
      method: "POST",
      headers: { authorization: `Bearer ${mac.credential}`, "content-type": "application/json" },
      body: "{}",
    })));
    expect(added.filter((response) => response.status === 200)).toHaveLength(20);
    expect(added.filter((response) => response.status === 409)).toHaveLength(5);
  });

  it("sends an unanswered read again on the Mac's next tunnel, but never a write", async () => {
    const mac = await register("66666666666666666666666666666666");
    const dialMac = () => fetchRelay(`${mac.serverUrl}/__tunnel?v=1`, {
      headers: { upgrade: "websocket", authorization: `Bearer ${mac.credential}` },
    });
    (await dialMac()).webSocket!.accept();
    const cookie = await signInPhone(mac);
    const origin = `https://${mac.handle}.${BASE}`;
    const read = fetchRelay(`${origin}/slow`, { headers: { ...HTML, cookie } });
    const write = fetchRelay(`${origin}/api/v1/send`, { method: "POST", headers: { cookie }, body: "hi" });
    await new Promise((resolve) => setTimeout(resolve, 100));
    serveMac((await dialMac()).webSocket!);
    const [page, post] = await Promise.all([read, write]);
    expect(page.status).toBe(200);
    expect(await page.text()).toBe("mac:app:/slow");
    expect(post.status).toBe(502);
    expect(await post.text()).toContain("tunnel reconnected mid-request");
    expect(seen.some((request) => request.path === "/api/v1/send")).toBe(false);
  });

  it("tells the account's Macs their Cloud threads changed, only for the website, and sends a burst's last one", async () => {
    const signal = (secret: string) => fetchRelay(`https://${BASE}/api/threads-changed`, {
      method: "POST", headers: { authorization: `Bearer ${secret}`, "content-type": "application/json" }, body: JSON.stringify({ user_id: "user-1" }),
    });
    expect((await signal("wrong")).status).toBe(401);
    const signals = () => seen.filter((asked) => asked.path === "/api/v1/cloudroom/threads-changed" && asked.headers[RELAY_SIGNAL_HEADER] === "threads").length;
    const wait = () => new Promise((resolve) => setTimeout(resolve, 1_300));
    let before = signals();
    expect((await signal("signal-secret")).status).toBe(202);
    await wait();
    const macs = signals() - before;
    expect(macs).toBeGreaterThan(0);
    // Three at once reach each online Mac twice: at once, then once more at the end of the second.
    before = signals();
    for (let i = 0; i < 3; i++) await signal("signal-secret");
    await wait();
    expect(signals() - before).toBe(2 * macs);
    // A visitor can't send one: the relay drops its header.
    expect(requestForTunnelDo(new Request(`https://${handle}.${BASE}/`, { headers: { [RELAY_SIGNAL_HEADER]: "threads" } }), null).headers.get(RELAY_SIGNAL_HEADER)).toBeNull();
  });

  it("holds new requests while a Mac's tunnel is briefly gone, then sends them on its next tunnel", async () => {
    const mac = await register("88888888888888888888888888888888");
    const dialMac = () => fetchRelay(`${mac.serverUrl}/__tunnel?v=2`, {
      headers: { upgrade: "websocket", authorization: `Bearer ${mac.credential}` },
    });
    const dropped = (await dialMac()).webSocket!;
    dropped.accept();
    const cookie = await signInPhone(mac);
    const origin = `https://${mac.handle}.${BASE}`;
    dropped.close(1001, "network dropped");
    await new Promise((resolve) => setTimeout(resolve, 100));
    const read = fetchRelay(`${origin}/api/v1/projects`, { headers: { cookie } });
    const write = fetchRelay(`${origin}/api/v1/held-send`, { method: "POST", headers: { cookie }, body: "hi" });
    await new Promise((resolve) => setTimeout(resolve, 300));
    serveMac((await dialMac()).webSocket!);
    const [got, sent] = await Promise.all([read, write]);
    expect(got.status).toBe(200);
    expect(sent.status).toBe(200);
    expect(await sent.text()).toBe("mac:app:/api/v1/held-send");
  });

  it("shows a page that retries by itself when a page load's tunnel drops twice", async () => {
    const mac = await register("77777777777777777777777777777777");
    const dialMac = () => fetchRelay(`${mac.serverUrl}/__tunnel?v=1`, {
      headers: { upgrade: "websocket", authorization: `Bearer ${mac.credential}` },
    });
    (await dialMac()).webSocket!.accept();
    const cookie = await signInPhone(mac);
    const read = fetchRelay(`https://${mac.handle}.${BASE}/stuck`, { headers: { ...HTML, cookie } });
    for (let drop = 0; drop < 2; drop++) {
      await new Promise((resolve) => setTimeout(resolve, 100));
      (await dialMac()).webSocket!.accept();
    }
    const page = await read;
    expect(page.status).toBe(502);
    expect(page.headers.get("cache-control")).toBe("no-store");
    expect(await page.text()).toContain("Reconnecting to your Mac");
  });

  it("shows the offline page when the Mac is not connected", async () => {
    const cookie = await signInPhone();
    // A normal close: the relay does not wait for this Mac to come back.
    tunnel.close(1000, "quit");
    await new Promise((resolve) => setTimeout(resolve, 100));
    const page = await fetchRelay(`https://${handle}.${BASE}/`, {
      headers: { ...HTML, cookie },
    });
    expect(page.status).toBe(503);
    expect(page.headers.get(OFFLINE_HEADER)).toBe("1");
    expect(await page.text()).toContain("Your Mac is offline");
    const fromOtherAddress = await fetchRelay(`https://${handle}.${BASE}/`, {
      headers: { ...HTML, cookie, "mf-sec-fetch-mode": "navigate", "sec-fetch-site": "same-site" },
    });
    expect(fromOtherAddress.status).toBe(503);
    expect(fromOtherAddress.headers.get(OFFLINE_HEADER)).toBeNull();
    expect(fromOtherAddress.headers.get("content-security-policy")).toBe("frame-ancestors 'self'");
  });
});

describe("host and path parsing", () => {
  it("accepts handles and port shares only", () => {
    expect(parseVisitorHost(`abc.${BASE}`, BASE)).toEqual({ handle: "abc", target: null });
    expect(parseVisitorHost(`abc--8080.${BASE}`, BASE)).toEqual({ handle: "abc", target: "8080" });
    expect(parseVisitorHost(`abc--99999.${BASE}`, BASE)).toBeNull();
    expect(parseVisitorHost(`a.b.${BASE}`, BASE)).toBeNull();
    expect(parseVisitorHost(`evil.com`, BASE)).toBeNull();
  });

  it("only returns to pages on the same host, read the way a browser reads them", () => {
    const origin = `https://abc--3000.${BASE}`;
    expect(returnUrl(origin, "/thread/1?x=2")).toBe(`${origin}/thread/1?x=2`);
    expect(returnUrl(origin, null)).toBe(`${origin}/`);
    for (const offHost of [
      "//evil.com",
      "/\\evil.com",
      "https://evil.com",
      "/\t/evil.com",
      "/\t\\evil.com",
      "/\n/evil.com",
      "/\r/evil.com",
      "javascript:alert(1)",
      `http://abc--3000.${BASE}/x`,
      `blob:${origin}/id`,
      `https://user:pass@abc--3000.${BASE}/x`,
      `${origin}@evil.com/`,
      `${origin}.evil.com/`,
      "https://[",
    ]) {
      expect(returnUrl(origin, offHost)).toBe(`${origin}/`);
    }
    expect(returnUrl(origin, "/a/..//evil.com")).toBe(`${origin}//evil.com`);
    expect(returnUrl(origin, "/x?")).toBe(`${origin}/x?`);
    expect(returnUrl(origin, "/a\u0000b\u007f/é")).toBe(`${origin}/a%00b%7F/%C3%A9`);
    expect(SESSION_COOKIE.startsWith("__Host-")).toBe(true);
  });
});
