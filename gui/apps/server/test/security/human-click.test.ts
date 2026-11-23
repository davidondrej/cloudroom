import {
  createHumanClickSigner,
  HUMAN_CLICK_HEADER,
  HUMAN_CLICK_REQUIRED_CODE,
} from "@cloudroom/config/human-click";
import type { InstalledPlugin } from "@cloudroom/server-contract";
import { afterEach, describe, expect, it, vi } from "vitest";
import { cloudroom } from "../../src/services/cloudroom/commands.js";
import {
  createTestAppHarness,
  type TestAppHarness,
} from "../helpers/test-app.js";

const INSTALL = "/api/v1/plugins/install";
const MAC_ACCESS = "/api/v1/cloudroom/account/mac-access";
const SOURCE = "npm:some-plugin@1.0.0";
// What the phone relay sends: it runs in the server, so the harness's own token is on every request.
const PHONE = { "x-bb-gate-auth": "session" };

let harness: TestAppHarness | null = null;

afterEach(async () => {
  await harness?.cleanup();
  harness = null;
});

async function start() {
  const signer = createHumanClickSigner();
  harness = await createTestAppHarness({
    humanClickPublicKey: signer.publicKey,
  });
  const install = vi
    .spyOn(harness.pluginService, "install")
    .mockResolvedValue({ id: "some-plugin" } as InstalledPlugin);
  const app = harness.app;
  const post = (
    path: string,
    headers: Record<string, string> = {},
    body: unknown = { source: SOURCE },
  ) =>
    app.request(path, {
      method: "POST",
      headers: { "content-type": "application/json", ...headers },
      body: JSON.stringify(body),
    });
  const signed = (path: string) =>
    post(path, { [HUMAN_CLICK_HEADER]: signer.sign("POST", path) ?? "" });
  return { app, harness, install, post, signed, signer };
}

describe("human clicks (ADR 0260)", () => {
  it("runs a plugin install the desktop app signed, once per signature", async () => {
    const { install, post, signer } = await start();
    const click = signer.sign("POST", INSTALL) ?? "";

    expect((await post(INSTALL, { [HUMAN_CLICK_HEADER]: click })).status).toBe(
      200,
    );
    expect(install).toHaveBeenCalledTimes(1);

    // The same signature again (also spelled another way), one for another path, and one from another key.
    const other = createHumanClickSigner().sign("POST", INSTALL) ?? "";
    const elsewhere = signer.sign("POST", "/api/v1/plugins/x/update") ?? "";
    for (const header of [click, `${click}==`, elsewhere, other]) {
      expect(
        (await post(INSTALL, { [HUMAN_CLICK_HEADER]: header })).status,
      ).toBe(403);
    }
    expect(install).toHaveBeenCalledTimes(1);
  });

  it("holds an agent's install until a person answers it in the app", async () => {
    const { app, install, post, signed } = await start();

    const asked = await post(INSTALL);
    const { code, requestId } = (await asked.json()) as {
      code: string;
      requestId: string;
    };
    expect(asked.status).toBe(403);
    expect(code).toBe(HUMAN_CLICK_REQUIRED_CODE);
    expect(install).not.toHaveBeenCalled();

    // The app prints the server's own account of the request.
    const waiting = await app.request("/api/v1/human-clicks");
    expect(await waiting.json()).toMatchObject({
      requests: [
        {
          id: requestId,
          verb: "Install",
          rows: [{ label: "source", value: SOURCE }],
        },
      ],
    });

    // The asker can't answer its own request.
    const approve = `/api/v1/human-clicks/${requestId}/approve`;
    expect((await post(approve)).status).toBe(403);
    expect(
      (await post(`/api/v1/human-clicks/${requestId}/decline`)).status,
    ).toBe(403);
    expect(install).not.toHaveBeenCalled();

    expect((await signed(approve)).status).toBe(200);
    expect(install).toHaveBeenCalledWith(SOURCE, { kind: "root" });
    const answer = await app.request(`/api/v1/human-clicks/${requestId}`);
    expect(await answer.json()).toMatchObject({
      status: "done",
      response: {
        status: 200,
        body: { ok: true, plugin: { id: "some-plugin" } },
      },
    });
  });

  it("refuses a request it can't describe instead of showing it", async () => {
    const { app, post } = await start();

    // A plugin name that isn't one, a plugin that isn't installed, and a body with no source.
    for (const path of [
      "/api/v1/plugins/%E0%A4%A/update",
      "/api/v1/plugins/a%5Chttp%5Cx/update",
      "/api/v1/plugins/not-installed/update",
    ]) {
      expect((await post(path, {}, {})).status).toBe(422);
    }
    expect((await post(INSTALL, {}, { nope: true })).status).toBe(422);

    const waiting = await app.request("/api/v1/human-clicks");
    expect(await waiting.json()).toEqual({ requests: [] });
  });

  it("lets a signed-in phone raise Mac access, and nothing else", async () => {
    const { harness, install, post } = await start();
    const apply = vi
      .spyOn(cloudroom(harness.deps), "applyMacAccess")
      .mockImplementation(() => {});

    expect((await post(MAC_ACCESS, {}, { level: "full" })).status).toBe(403);
    expect(apply).not.toHaveBeenCalled();

    expect((await post(MAC_ACCESS, PHONE, { level: "full" })).status).toBe(200);
    expect(apply).toHaveBeenCalledTimes(1);

    // A plugin install from the phone waits for the desktop app like any other.
    const asked = await post(INSTALL, PHONE);
    const { requestId } = (await asked.json()) as { requestId: string };
    expect(asked.status).toBe(403);
    expect(
      (await post(`/api/v1/human-clicks/${requestId}/approve`, PHONE)).status,
    ).toBe(403);
    expect(install).not.toHaveBeenCalled();
  });
});
