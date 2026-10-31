import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { gzipSync } from "node:zlib";
import { build } from "esbuild";
import { Miniflare, Response as MiniflareResponse } from "miniflare";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { decodeFrame, encodeFrame, type Frame } from "@cloudroom/tunnel-contract";
import { OFFLINE_HEADER } from "./pages";
import { GATE_AUTH_HEADER, GATE_MACHINE_ID_HEADER, MACHINE_CREDENTIAL_HEADER, PHONE_SESSION_HEADER, SESSION_COOKIE, TUNNEL_SESSION_HEADER, TUNNEL_TARGET_HEADER } from "./protocol-headers";
import { parseVisitorHost, requestForTunnelDo, returnUrl } from "./worker";
import { createShareCode, sha256Hex } from "./store";

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
    bindings: { BASE_DOMAIN: BASE, WEBSITE_URL: "https://website.test" },
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

  it("shows the offline page when the Mac is not connected", async () => {
    const cookie = await signInPhone();
    tunnel.close();
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
