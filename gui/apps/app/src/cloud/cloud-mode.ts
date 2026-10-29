import { COMPUTER } from "@cloudroom/domain";
import { wsManager } from "@/lib/ws";

export const isPhoneRelay = () =>
  window.location.hostname.endsWith(".cloudroom.run");

export const isPhoneApp = () =>
  window.location.hostname === "app.cloudroom.run";

export async function openMacOnPhone(handle: string): Promise<void> {
  const response = await fetch("/__mac", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ handle }),
  });
  if (!response.ok) throw new Error(`Couldn't open that ${COMPUTER}.`);
  window.location.reload();
}

export const SAVED_API = "cloudroom-api";
const SHELL = "cloudroom-shell";
const SAVE_AFTER_MS = 5000;
const CONFIRM_OFFLINE_MS = 5000;
const ASSETS = "cloudroom-assets";

let macOff = false;

export const macIsOff = () => macOff;
export const markMacOff = () => {
  macOff = true;
};

const tunnelOffline = (response: Response) =>
  response.status === 503 &&
  response.headers.get("x-bb-tunnel-offline") === "1";

let bootMac: string | null | undefined;
const nativeFetch = window.fetch.bind(window);

export const startupMac = () => bootMac ?? null;

const probeMac = async (timeoutMs = 4000) => {
  const response = await nativeFetch("/api/v1/system/version", {
    cache: "no-store",
    signal: AbortSignal.timeout(timeoutMs),
  }).catch(() => null);
  if (bootMac === undefined && response) {
    bootMac =
      response.headers.get("x-cloudroom-mac") ??
      (isPhoneApp() ? null : window.location.hostname);
    tellWorkerMac();
    navigator.serviceWorker?.addEventListener(
      "controllerchange",
      tellWorkerMac,
    );
  }
  return response;
};

const tellWorkerMac = () =>
  navigator.serviceWorker?.controller?.postMessage({
    type: "page-mac",
    mac: bootMac ?? null,
  });

export const macOffline = async () => {
  const response = await probeMac();
  return response !== null && tunnelOffline(response);
};

export const macOnline = async () => (await probeMac())?.ok === true;

export function keepOfflineCopy(): void {
  if (!("serviceWorker" in navigator)) return;
  void navigator.serviceWorker
    .register("/sw.js")
    .then(() => navigator.serviceWorker.ready)
    .then(async () => {
      await (await caches.open(SHELL)).add("/").catch(() => undefined);
      await new Promise((resolve) => setTimeout(resolve, SAVE_AFTER_MS));
      const listed = await fetch("/app-files.json", { cache: "no-store" })
        .then((response) => (response.ok ? response.json() : []))
        .catch(() => []);
      const loaded = performance
        .getEntriesByType("resource")
        .map((entry) => new URL(entry.name))
        .filter(
          (url) =>
            url.origin === window.location.origin &&
            url.pathname.startsWith("/assets/"),
        )
        .map((url) => url.pathname);
      const files = [
        ...new Set([
          ...loaded,
          ...(Array.isArray(listed)
            ? listed.filter(
                (file): file is string =>
                  typeof file === "string" && file.startsWith("/assets/"),
              )
            : []),
        ]),
      ];
      const assets = await caches.open(ASSETS);
      const keys = await assets.keys();
      const current = new Set(files);
      const sameBuild =
        Array.isArray(listed) &&
        listed.length > 0 &&
        loaded.every((file) => listed.includes(file));
      if (sameBuild)
        for (const key of keys)
          if (!current.has(new URL(key.url).pathname))
            await assets.delete(key).catch(() => undefined);
      const saved = new Set(
        keys.map((request) => new URL(request.url).pathname),
      );
      const connection = (
        navigator as Navigator & { connection?: { saveData?: boolean } }
      ).connection;
      if (connection?.saveData) return;
      const missing = files.filter((file) => !saved.has(file));
      let workers = 0;
      const save = async () => {
        if (workers >= 2) return;
        workers++;
        while (missing.length && document.visibilityState === "visible") {
          const file = missing.shift()!;
          await (
            navigator.serviceWorker.controller
              ? fetch(file).then((response) => response.body?.cancel())
              : assets.add(file)
          ).catch(() => undefined);
        }
        workers--;
      };
      await Promise.all([save(), save()]);
      document.addEventListener("visibilitychange", () => {
        if (document.visibilityState === "visible" && missing.length)
          void Promise.all([save(), save()]);
      });
    })
    .catch(() => undefined);
}

const OFFLINE_RELOAD_KEY = "cloudroom:offline-reload";

export function reloadWhenMacGoesOffline(): void {
  let checking = false;
  let writes = 0;
  const reloadWhenIdle = (): unknown =>
    setTimeout(
      () => (writes > 0 ? reloadWhenIdle() : window.location.reload()),
      1000,
    );
  const check = () => {
    if (checking || document.visibilityState !== "visible") return;
    checking = true;
    void macOffline()
      .then(async (offline) => {
        if (!offline) return false;
        await new Promise((resolve) => setTimeout(resolve, CONFIRM_OFFLINE_MS));
        return macOffline();
      })
      .then((offline) => {
        if (!offline) return;
        const last = Number(sessionStorage.getItem(OFFLINE_RELOAD_KEY));
        if (Date.now() - last < 60_000) return;
        sessionStorage.setItem(OFFLINE_RELOAD_KEY, String(Date.now()));
        reloadWhenIdle();
      })
      .finally(() => {
        checking = false;
      });
  };
  document.addEventListener("visibilitychange", () => {
    if (document.visibilityState === "visible") check();
  });
  let lost: ReturnType<typeof setTimeout> | undefined;
  const checkWhileLost = (delay: number) => {
    lost = setTimeout(() => {
      check();
      checkWhileLost(Math.min(delay * 2, 5 * 60_000));
    }, delay);
  };
  const watchSocket = () => {
    clearTimeout(lost);
    if (wsManager.getConnectionState() !== "connected") checkWhileLost(60_000);
  };
  wsManager.onConnectionStateChange(watchSocket);
  watchSocket();
  navigator.serviceWorker?.addEventListener("message", (event) => {
    if ((event.data as { type?: unknown } | null)?.type === "mac-offline")
      check();
  });
  const network = window.fetch.bind(window);
  window.fetch = async (input, init) => {
    const method =
      init?.method ?? (input instanceof Request ? input.method : "GET");
    const write = !["GET", "HEAD"].includes(method.toUpperCase());
    if (write) writes++;
    try {
      const response = await network(input, init);
      if (tunnelOffline(response)) check();
      return response;
    } finally {
      if (write) writes--;
    }
  };
}
