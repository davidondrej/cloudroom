import type { ProviderUsage } from "@cloudroom/host-daemon-contract";
import { afterEach, describe, expect, it, vi } from "vitest";
import { cloudClaudeUsage } from "../../src/services/system/usage-limits.js";
import { registerHostRpcResponder } from "../helpers/host-rpc.js";
import { readJson } from "../helpers/json.js";
import { seedHostSession, seedPrimaryHost } from "../helpers/seed.js";
import { withTestHarness } from "../helpers/test-app.js";

const cloud = vi.hoisted(() => ({
  env: [] as { name: string; value: string }[],
}));
vi.mock("../../src/services/cloudroom/sandboxes.js", async (original) => ({
  ...(await original<object>()),
  cloudClaudeEnvironment: () =>
    cloud.env.map((entry) => ({
      ...entry,
      source: { core: "machine-environment" },
      reason: "Cloud Claude login",
    })),
}));

const tokenLogin = [
  { name: "CLAUDE_CODE_OAUTH_TOKEN", value: "sk-ant-oat01-test" },
  { name: "CLAUDE_CODE_SUBSCRIPTION_TYPE", value: "max" },
];

function stubAnthropic(status: number, headers: Record<string, string>) {
  const fetch = vi.fn(async () => new Response(null, { status, headers }));
  vi.stubGlobal("fetch", fetch);
  return fetch;
}

afterEach(() => {
  cloud.env = [];
  vi.unstubAllGlobals();
});

describe("cloudClaudeUsage", () => {
  it("reads the limits from a rate-limited reply's headers", async () => {
    const fetch = stubAnthropic(429, {
      "anthropic-ratelimit-unified-5h-utilization": "0.25",
      "anthropic-ratelimit-unified-5h-reset": "1791666000",
      "anthropic-ratelimit-unified-7d-utilization": "0.6",
    });

    const usage = await cloudClaudeUsage(
      tokenLogin.map((entry) => ({
        ...entry,
        source: { core: "machine-environment" as const },
        reason: "Cloud Claude login",
      })),
    );

    expect(usage).toEqual({
      status: "ok",
      accountEmail: null,
      planLabel: "Max",
      credits: null,
      windows: [
        {
          label: "Current session",
          kind: "five-hour",
          usedPercent: 25,
          resetsAt: new Date(1791666000 * 1000).toISOString(),
        },
        {
          label: "Weekly limit",
          kind: "weekly",
          usedPercent: 60,
          resetsAt: null,
        },
      ],
    });
    expect(fetch).toHaveBeenCalledWith(
      "https://api.anthropic.com/v1/messages",
      expect.objectContaining({
        headers: expect.objectContaining({
          authorization: "Bearer sk-ant-oat01-test",
        }),
      }),
    );
  });

  it("asks for a new sign-in when Anthropic rejects the token", async () => {
    stubAnthropic(401, {});

    expect(
      await cloudClaudeUsage([
        {
          name: "CLAUDE_CODE_OAUTH_TOKEN",
          value: "sk-ant-oat01-test",
          source: { core: "machine-environment" },
          reason: "Cloud Claude login",
        },
      ]),
    ).toEqual({ status: "expired" });
  });
});

describe("GET /api/v1/system/usage-limits with a cloud Claude login", () => {
  it("shows the cloud login's usage instead of a sign-in hint", async () => {
    await withTestHarness(async (harness) => {
      cloud.env = tokenLogin;
      stubAnthropic(200, {
        "anthropic-ratelimit-unified-5h-utilization": "0.1",
      });
      const primary = seedHostSession(harness.deps, { id: "host-primary" });
      seedPrimaryHost(harness.deps, primary.host.id);
      const signedOut: ProviderUsage = { status: "unauthenticated" };
      registerHostRpcResponder(harness, {
        hostId: primary.host.id,
        sessionId: primary.session.id,
        handle: (request) => {
          if (request.command.type !== "provider.usage")
            throw new Error(`Unexpected command ${request.command.type}`);
          return {
            ok: true as const,
            result: { supported: true as const, usage: signedOut },
          };
        },
      });

      const response = await harness.app.request(
        "/api/v1/system/usage-limits?providerId=claude-code",
      );

      expect(response.status).toBe(200);
      expect(await readJson(response)).toEqual({
        "claude-code": {
          status: "ok",
          accountEmail: null,
          planLabel: "Max",
          credits: null,
          windows: [
            {
              label: "Current session",
              kind: "five-hour",
              usedPercent: 10,
              resetsAt: null,
            },
          ],
        },
      });
    });
  });
});
