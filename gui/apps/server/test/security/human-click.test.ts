import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import { CALLER_TOKEN_HEADER } from "@cloudroom/config/caller-proof";
import {
  createHumanClickSigner,
  HUMAN_CLICK_HEADER,
  HUMAN_CLICK_REQUIRED_CODE,
} from "@cloudroom/config/human-click";
import type { InstalledPlugin } from "@cloudroom/server-contract";
import { afterEach, describe, expect, it, vi } from "vitest";
import { cloudroom } from "../../src/services/cloudroom/commands.js";
import { seedThreadFixture } from "../helpers/seed.js";
import {
  createTestAppHarness,
  type TestAppHarness,
} from "../helpers/test-app.js";

const INSTALL = "/api/v1/plugins/install";
const SKILL_INSTALL = "/api/v1/skills-registry/install";
const SKILL_ID = "github.com/owner/repo/review";
const MAC_ACCESS = "/api/v1/cloudroom/account/mac-access";
const SOURCE = "npm:some-plugin@1.0.0";
// What the phone relay sends: it runs in the server, so the harness's own token is on every request.
const PHONE = { "x-bb-gate-auth": "session" };

const installSkill = vi.hoisted(() =>
  vi.fn(async () => ({ filePath: "/skills/review/SKILL.md" })),
);
vi.mock("../../src/services/skills/registry-skill-install.js", () => ({
  installServerRegistrySkill: installSkill,
}));

let harness: TestAppHarness | null = null;

afterEach(async () => {
  vi.unstubAllGlobals();
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

  it("installs a registry skill only after a person approves the entry shown", async () => {
    const { app, post, signed, signer } = await start();
    // skills.sh answers for whichever entry is asked for.
    vi.stubGlobal(
      "fetch",
      vi.fn(
        async (url: string) =>
          new Response(
            `<script type="application/ld+json">${JSON.stringify({
              "@type": "SoftwareApplication",
              name: "Review",
              url,
              interactionStatistic: { userInteractionCount: 1 },
            })}</script>`,
          ),
      ),
    );
    const body = { registrySkillId: SKILL_ID };
    const click = signer.sign("POST", SKILL_INSTALL) ?? "";
    expect(
      (await post(SKILL_INSTALL, { [HUMAN_CLICK_HEADER]: click }, body)).status,
    ).toBe(200);
    // Replayed, forged with another key, and signed for a plugin install instead.
    for (const header of [
      click,
      createHumanClickSigner().sign("POST", SKILL_INSTALL) ?? "",
      signer.sign("POST", INSTALL) ?? "",
    ]) {
      expect(
        (await post(SKILL_INSTALL, { [HUMAN_CLICK_HEADER]: header }, body))
          .status,
      ).toBe(403);
    }
    expect(installSkill).toHaveBeenCalledTimes(1);

    // Unsigned: held, shown with its ID and source, and run only after a click.
    const asked = await post(SKILL_INSTALL, {}, body);
    const { requestId } = (await asked.json()) as { requestId: string };
    expect(asked.status).toBe(403);
    expect(
      await (await app.request("/api/v1/human-clicks")).json(),
    ).toMatchObject({
      requests: [
        {
          id: requestId,
          action: "skill-registry-install",
          rows: [
            { label: "skill", value: "Review" },
            { label: "registry ID", value: SKILL_ID },
            { label: "source", value: "github.com/owner/repo" },
            { label: "reviewed", value: "no: anyone can publish to skills.sh" },
          ],
        },
      ],
    });
    expect(installSkill).toHaveBeenCalledTimes(1);
    expect(
      (await signed(`/api/v1/human-clicks/${requestId}/approve`)).status,
    ).toBe(200);
    expect(installSkill).toHaveBeenCalledTimes(2);
    expect(installSkill).toHaveBeenLastCalledWith(
      expect.objectContaining({ packageRef: "owner/repo", skillId: "review" }),
    );

    // A source the installer would refuse is never shown.
    expect(
      (
        await post(
          SKILL_INSTALL,
          {},
          { registrySkillId: "github.com/-x/review" },
        )
      ).status,
    ).toBe(422);
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

  it("refuses forged Origin and remote-machine answers to a GPU approval card, and accepts a desktop click or signed-in phone", async () => {
    const { app, harness, post, signer } = await start();
    const { thread } = seedThreadFixture(harness);
    const origin = `http://127.0.0.1:${harness.config.serverPort}`;

    // Obtain a real non-internal caller-proof token, like a local agent or curl.
    const started = (await (
      await app.request("/api/v1/caller-proofs", { method: "POST" })
    ).json()) as { claim: string; directory: string; id: string };
    await writeFile(join(started.directory, started.id), started.id);
    const { token: localAgentToken } = (await (
      await app.request(`/api/v1/caller-proofs/${started.id}`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ claim: started.claim }),
      })
    ).json()) as { token: string };
    expect(localAgentToken).toBeTruthy();

    const openGpuCard = () => {
      const pending = harness.deps.pendingInteractions.requestPluginInteraction(
        {
          pluginId: "gpu",
          rendererId: "gpu-approval",
          threadId: thread.id,
          title: "Use a GPU?",
          payload: { max_credits: 320_000 },
          timeoutMs: 60_000,
        },
      );
      const [interaction] =
        harness.deps.pendingInteractions.listPendingThreadInteractions(
          thread.id,
        );
      expect(interaction).toBeDefined();
      return {
        pending,
        path: `/api/v1/threads/${thread.id}/interactions/${interaction!.id}/respond`,
      };
    };

    const first = openGpuCard();
    // Local agent forging a trusted Origin header (with or without a spoofed gate-auth header).
    expect(
      (
        await post(
          first.path,
          { [CALLER_TOKEN_HEADER]: localAgentToken, origin },
          { value: { approve: true } },
        )
      ).status,
    ).toBe(403);
    expect(
      (
        await post(
          first.path,
          {
            [CALLER_TOKEN_HEADER]: localAgentToken,
            "x-bb-gate-auth": "session",
            origin,
          },
          { value: { approve: true } },
        )
      ).status,
    ).toBe(403);
    // Remote Connect machine (internal relay token) forging a trusted Origin header.
    expect(
      (
        await post(
          first.path,
          { "x-bb-gate-auth": "machine", origin },
          { value: { approve: true } },
        )
      ).status,
    ).toBe(403);
    // Wrong-path signature and another key's signature are refused.
    const elsewhere = signer.sign("POST", MAC_ACCESS) ?? "";
    const otherKey = createHumanClickSigner().sign("POST", first.path) ?? "";
    for (const header of [elsewhere, otherKey]) {
      expect(
        (
          await post(
            first.path,
            {
              [CALLER_TOKEN_HEADER]: localAgentToken,
              [HUMAN_CLICK_HEADER]: header,
              origin,
            },
            { value: { approve: true } },
          )
        ).status,
      ).toBe(403);
    }
    // Card is still pending until a real human click answers it.
    expect(
      harness.deps.pendingInteractions.listPendingThreadInteractions(thread.id),
    ).toHaveLength(1);

    const click = signer.sign("POST", first.path) ?? "";
    expect(click).not.toBe("");
    expect(
      (
        await post(
          first.path,
          { [HUMAN_CLICK_HEADER]: click, origin },
          { value: { approve: true } },
        )
      ).status,
    ).toBe(200);
    expect(await first.pending).toEqual({
      outcome: "submitted",
      value: { approve: true },
    });
    // Replaying the same signature is refused with 403 before interaction resolution.
    expect(
      (
        await post(
          first.path,
          {
            [CALLER_TOKEN_HEADER]: localAgentToken,
            [HUMAN_CLICK_HEADER]: click,
            origin,
          },
          { value: { approve: true } },
        )
      ).status,
    ).toBe(403);

    // Signed-in Connect phone (internal relay token + session gate) can approve a GPU card.
    const second = openGpuCard();
    expect(
      (
        await post(
          second.path,
          { ...PHONE, origin },
          { value: { approve: true } },
        )
      ).status,
    ).toBe(200);
    expect(await second.pending).toEqual({
      outcome: "submitted",
      value: { approve: true },
    });

    // Computer-use cards also require a real human click (agents cannot self-approve over localhost).
    const computerUse = harness.deps.pendingInteractions.requestPluginInteraction({
      pluginId: "computer-use",
      rendererId: "computer-use-approval",
      threadId: thread.id,
      title: "Allow this thread to use Computer Use?",
      payload: {},
      timeoutMs: 60_000,
    });
    const [cuItem] =
      harness.deps.pendingInteractions.listPendingThreadInteractions(thread.id);
    const cuPath = `/api/v1/threads/${thread.id}/interactions/${cuItem!.id}/respond`;
    expect(
      (
        await post(
          cuPath,
          { [CALLER_TOKEN_HEADER]: localAgentToken, origin },
          { value: { decision: "thread" } },
        )
      ).status,
    ).toBe(403);
    const cuClick = signer.sign("POST", cuPath) ?? "";
    expect(
      (
        await post(
          cuPath,
          { [HUMAN_CLICK_HEADER]: cuClick, origin },
          { value: { decision: "thread" } },
        )
      ).status,
    ).toBe(200);
    expect(await computerUse).toEqual({
      outcome: "submitted",
      value: { decision: "thread" },
    });

    // Ordinary plugin interactions (outside APP_ONLY_PLUGINS) still accept unsigned CLI responses.
    const ordinary = harness.deps.pendingInteractions.requestPluginInteraction({
      pluginId: "ask-user-question",
      rendererId: "question",
      threadId: thread.id,
      title: "Pick one",
      payload: {},
      timeoutMs: 60_000,
    });
    const [ordinaryItem] =
      harness.deps.pendingInteractions.listPendingThreadInteractions(thread.id);
    expect(
      (
        await post(
          `/api/v1/threads/${thread.id}/interactions/${ordinaryItem!.id}/respond`,
          { [CALLER_TOKEN_HEADER]: localAgentToken },
          { value: { answer: "yes" } },
        )
      ).status,
    ).toBe(200);
    expect(await ordinary).toEqual({
      outcome: "submitted",
      value: { answer: "yes" },
    });
  });

  it("still refuses remote-machine GPU approvals even when no human-click key is configured", async () => {
    harness = await createTestAppHarness();
    const { thread } = seedThreadFixture(harness);
    const origin = `http://127.0.0.1:${harness.config.serverPort}`;
    const pending = harness.deps.pendingInteractions.requestPluginInteraction({
      pluginId: "gpu",
      rendererId: "gpu-approval",
      threadId: thread.id,
      title: "Use a GPU?",
      payload: { max_credits: 320_000 },
      timeoutMs: 60_000,
    });
    const [interaction] =
      harness.deps.pendingInteractions.listPendingThreadInteractions(thread.id);
    const path = `/api/v1/threads/${thread.id}/interactions/${interaction!.id}/respond`;
    const respond = (headers: Record<string, string>) =>
      harness!.app.request(path, {
        method: "POST",
        headers: { "content-type": "application/json", ...headers },
        body: JSON.stringify({ value: { approve: true } }),
      });

    expect(
      (await respond({ "x-bb-gate-auth": "machine", origin })).status,
    ).toBe(403);
    expect((await respond({})).status).toBe(403);
    expect((await respond({ origin })).status).toBe(200);
    expect(await pending).toEqual({
      outcome: "submitted",
      value: { approve: true },
    });
  });
});
