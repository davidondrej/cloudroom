import { expect, it } from "vitest";
import { createBbSdk } from "../src/core.js";
import { createHttpTransport } from "../src/transport-http.js";

it("exposes account status, sign-in, cancellation and local logout over the same API", async () => {
  const calls: { path: string; method: string; body: unknown }[] = [];
  const sdk = createBbSdk({ transport: createHttpTransport({ runtime: "node", baseUrl: "http://localhost:1234", fetch: async (input, init) => {
    calls.push({ path: new URL(String(input)).pathname, method: init?.method ?? "GET", body: init?.body ? JSON.parse(String(init.body)) : null });
    return Response.json(calls.length === 1 ? { account: null, ready: false } : calls.length === 2 ? { url: "https://www.cloudroom.dev/desktop" } : { ok: true });
  } }) });
  expect(await sdk.cloudroom.status()).toEqual({ account: null, ready: false });
  expect(await sdk.cloudroom.signIn()).toEqual({ url: "https://www.cloudroom.dev/desktop" });
  await sdk.cloudroom.cancel(); await sdk.cloudroom.logout();
  await sdk.cloudroom.retryStart("thread");
  await sdk.cloudroom.threadWorkspace("thread");
  await sdk.cloudroom.cursorAuth();
  await sdk.cloudroom.cursorLogin("cursor-login");
  await sdk.cloudroom.cancelCursorLogin("cursor-login");
  await sdk.cloudroom.cursorApiKey("cursor-key", "synthetic-key");
  expect(calls).toEqual([
    { path: "/api/v1/cloudroom/account", method: "GET", body: null },
    { path: "/api/v1/cloudroom/account/sign-in", method: "POST", body: {} },
    { path: "/api/v1/cloudroom/account/cancel", method: "POST", body: {} },
    { path: "/api/v1/cloudroom/account/logout", method: "POST", body: {} },
    { path: "/api/v1/cloudroom/threads/thread/retry-start", method: "POST", body: {} },
    { path: "/api/v1/cloudroom/threads/thread/workspace", method: "GET", body: null },
    { path: "/api/v1/cloudroom/account/cursor", method: "GET", body: null },
    { path: "/api/v1/cloudroom/account/cursor/login", method: "POST", body: { requestId: "cursor-login" } },
    { path: "/api/v1/cloudroom/account/cursor/cancel", method: "POST", body: { requestId: "cursor-login" } },
    { path: "/api/v1/cloudroom/account/cursor/key", method: "POST", body: { requestId: "cursor-key", apiKey: "synthetic-key" } },
  ]);
});
