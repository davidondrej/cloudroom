const SHELL = "cloudroom-shell";
const ASSETS = "cloudroom-assets";
const API = "cloudroom-api";
const PLUGINS = "cloudroom-plugins";
const PLUGIN_ASSET = /^\/api\/v1\/plugins\/[^/]+\/assets\//;
const LIVE_API =
  /^\/api\/v1\/(?:search|threads\/[^/]+\/(?:timeline|host-files|events|search))/;
const OFFLINE_HEADERS = ["x-cloudroom-offline", "x-bb-tunnel-offline"];
const MAC_HEADER = "x-cloudroom-mac";
const MAC_KEY = "/__cloudroom-mac";
const OLD_INSTALL = self.location.hostname !== "app.cloudroom.run";

self.addEventListener("install", () => self.skipWaiting());
self.addEventListener("activate", (event) =>
  event.waitUntil(
    Promise.all([self.clients.claim(), moveOldCopies().catch(() => undefined)]),
  ),
);

self.addEventListener("fetch", (event) => {
  const { request } = event;
  if (request.method !== "GET") return;
  const url = new URL(request.url);
  if (url.origin !== self.location.origin) return;
  if (request.mode === "navigate") event.respondWith(page(request));
  else if (url.pathname.startsWith("/assets/"))
    event.respondWith(asset(request, ASSETS));
  else if (PLUGIN_ASSET.test(url.pathname) && url.searchParams.has("h"))
    event.respondWith(asset(request, PLUGINS));
  else if (url.pathname === "/api/v1/system/version")
    event.respondWith(probe(request));
  else if (url.pathname.startsWith("/api/v1/") && !LIVE_API.test(url.pathname))
    event.respondWith(api(request, event.clientId));
});

const pageMacs = new Map();
self.addEventListener("message", (event) => {
  if (event.data?.type === "page-mac" && event.source?.id)
    pageMacs.set(event.source.id, event.data.mac);
  if (pageMacs.size > 50) pageMacs.delete(pageMacs.keys().next().value);
});

const offline = (response) =>
  OFFLINE_HEADERS.some((name) => response.headers.get(name) === "1");

async function page(request) {
  const shell = await caches.open(SHELL);
  let response;
  try {
    response = await fetch(request);
  } catch {
    return (await shell.match("/")) ?? Response.error();
  }
  if (
    response.ok &&
    (response.headers.get("content-type") ?? "").startsWith("text/html")
  ) {
    await shell.put("/", response.clone());
    return response;
  }
  return offline(response) ? ((await shell.match("/")) ?? response) : response;
}

const noStore = (response) =>
  /no-store/i.test(response.headers.get("cache-control") ?? "");

async function storable(cache, request) {
  const saved = await cache.match(request);
  if (!saved || !noStore(saved)) return saved;
  await cache.delete(request).catch(() => undefined);
}

async function savedPlugin(request) {
  const saved = await caches.match(request);
  return saved && !noStore(saved) ? saved : undefined;
}

async function asset(request, name) {
  const assets = await caches.open(name);
  const saved = await storable(assets, request);
  if (saved) return saved;
  const response = await fetch(request).catch(() => Response.error());
  const unreachable = response.type === "error" || offline(response);
  if (!response.ok)
    return name === PLUGINS && unreachable
      ? ((await savedPlugin(request).catch(() => undefined)) ?? response)
      : response;
  if (noStore(response)) return response;
  const copy = response.clone();
  const save = async () => {
    if (name === PLUGINS) {
      await assets.delete(request, { ignoreSearch: true });
    }
    await assets.put(request, copy);
  };
  await save().catch(() => undefined);
  return response;
}

let markerMac;

async function knownMac() {
  if (markerMac === undefined) {
    const known = await (await caches.open(SHELL)).match(MAC_KEY);
    markerMac = known ? await known.text() : null;
  }
  return markerMac;
}

const macCache = (mac) => caches.open(`${API}:${mac}`);

const macOf = (response) =>
  response.headers.get(MAC_HEADER) ??
  (OLD_INSTALL ? self.location.hostname : null);

async function moveOldCopies() {
  if (!(await caches.has(API))) return;
  const old = await caches.open(API);
  const mac =
    (await knownMac()) || (OLD_INSTALL ? self.location.hostname : null);
  if (mac !== null) {
    const next = await macCache(mac);
    await Promise.all(
      (await old.keys()).map(async (request) => {
        const response = await old.match(request);
        if (response) await next.put(request, response);
      }),
    );
  }
  await caches.delete(API);
}

async function forgetAccount() {
  for (const name of await caches.keys())
    if (name.startsWith(`${API}:`) || name === PLUGINS)
      await caches.delete(name);
}

async function forMac(response) {
  const mac = macOf(response);
  if (mac === null || (await knownMac()) === mac) return;
  markerMac = mac;
  await (await caches.open(SHELL)).put(MAC_KEY, new Response(mac));
  for (const name of await caches.keys())
    if (name.startsWith(`${API}:`) && name !== `${API}:${mac}`)
      await caches.delete(name);
}

async function savedFor(request, mac) {
  return mac === null ? undefined : (await macCache(mac)).match(request);
}

async function probe(request) {
  const response = await fetch(request);
  await forMac(response).catch(() => undefined);
  return response;
}

async function api(request, clientId) {
  let response;
  try {
    response = await fetch(request);
  } catch {
    return (
      (await savedFor(
        request,
        pageMacs.get(clientId) ?? (await knownMac().catch(() => null)),
      ).catch(() => undefined)) ?? Response.error()
    );
  }
  if (
    response.status === 401 &&
    !OLD_INSTALL &&
    response.headers.get(MAC_HEADER) === null
  )
    await forgetAccount().catch(() => undefined);
  const mac = macOf(response);
  if (mac !== null && (await knownMac().catch(() => "")) === null)
    await forMac(response).catch(() => undefined);
  if (response.ok) {
    if (mac !== null)
      await (
        await macCache(mac)
      )
        .put(request, response.clone())
        .catch(() => undefined);
    return response;
  }
  if (!offline(response)) return response;
  void tellMacOffline();
  return (await savedFor(request, mac).catch(() => undefined)) ?? response;
}

async function tellMacOffline() {
  for (const client of await self.clients.matchAll())
    client.postMessage({ type: "mac-offline" });
}
