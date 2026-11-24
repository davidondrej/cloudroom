import type { Thread } from "@cloudroom/domain";
import { makeThread as makeThreadFixture } from "@cloudroom/test-helpers/domain-fixtures";
import { describe, expect, it } from "vitest";
import {
  buildForkThreadRequest,
  isThreadForkable,
} from "../src/prompt/fork-thread-request.js";

function makeThread(overrides: Partial<Thread> = {}): Thread {
  return makeThreadFixture({
    createdAt: 1,
    environmentId: "env_source",
    id: "thr_source",
    lastReadAt: null,
    latestAttentionAt: 1,
    title: "Investigate flaky test",
    titleFallback: null,
    updatedAt: 1,
    ...overrides,
  });
}

describe("buildForkThreadRequest", () => {
  it("preserves plugin submission data in a fork dispatch request", () => {
    const request = buildForkThreadRequest({
      environment: { type: "reuse", environmentId: "env_source" },
      environmentId: "env_source",
      executionTarget: undefined,
      input: [{ type: "text", text: "Continue from here", mentions: [] }],
      model: "gpt-5",
      permissionMode: "accept-edits",
      pluginSubmission: {
        pluginId: "drafts",
        data: { kind: "draft" },
      },
      projectId: "proj_test",
      providerId: "codex",
      reasoningLevel: "high",
      serviceTier: "fast",
      sourceSeqEnd: 42,
      sourceThreadId: "thr_source",
      sourceThreadTitle: "Investigate flaky test",
    });

    expect(request).toEqual({
      environment: { type: "reuse", environmentId: "env_source" },
      executionTarget: "local",
      input: [{ type: "text", text: "Continue from here", mentions: [] }],
      model: "gpt-5",
      originKind: "fork",
      permissionMode: "accept-edits",
      pluginSubmission: {
        pluginId: "drafts",
        data: { kind: "draft" },
      },
      projectId: "proj_test",
      providerId: "codex",
      reasoningLevel: "high",
      serviceTier: "fast",
      sourceSeqEnd: 42,
      sourceThreadId: "thr_source",
      startedOnBehalfOf: null,
    });
  });

  it("omits unsupported service tier", () => {
    const request = buildForkThreadRequest({
      environment: { type: "reuse", environmentId: "env_source" },
      environmentId: "env_source",
      executionTarget: undefined,
      input: [{ type: "text", text: "Continue from here", mentions: [] }],
      model: "gpt-5",
      permissionMode: "auto",
      pluginSubmission: undefined,
      projectId: "proj_test",
      providerId: "codex",
      reasoningLevel: "medium",
      serviceTier: undefined,
      sourceSeqEnd: undefined,
      sourceThreadId: "thr_source",
      sourceThreadTitle: "Investigate flaky test",
    });

    expect(request).not.toHaveProperty("serviceTier");
    expect(request).not.toHaveProperty("pluginSubmission");
  });

  it("builds a fork request for a generic ACP provider", () => {
    expect(
      buildForkThreadRequest({
        environment: { type: "reuse", environmentId: "env_source" },
        environmentId: "env_source",
        executionTarget: undefined,
        input: [{ type: "text", text: "Continue from here", mentions: [] }],
        model: "gpt-5",
        permissionMode: "auto",
        pluginSubmission: undefined,
        projectId: "proj_test",
        providerId: "acp-amp",
        reasoningLevel: "medium",
        serviceTier: undefined,
        sourceSeqEnd: undefined,
        sourceThreadId: "thr_source",
        sourceThreadTitle: "Investigate flaky test",
      }),
    ).toMatchObject({
      originKind: "fork",
      providerId: "acp-amp",
      sourceThreadId: "thr_source",
    });
  });
});

describe("isThreadForkable", () => {
  it("rejects an archived source and permits it after unarchiving", () => {
    const source = makeThread({ archivedAt: 123 });

    expect(isThreadForkable(source)).toBe(false);
    expect(isThreadForkable({ ...source, archivedAt: null })).toBe(true);
  });

  it("is true for any harness with an environment, or any Cloud thread", () => {
    expect(isThreadForkable(makeThread({ environmentId: "env_source" }))).toBe(true);
    expect(isThreadForkable(makeThread({ providerId: "acp-antigravity" }))).toBe(true);
    expect(isThreadForkable(makeThread({ environmentId: null }))).toBe(false);
    expect(isThreadForkable(makeThread({ environmentId: null, executionTarget: "cloud" }))).toBe(true);
    expect(isThreadForkable(null)).toBe(false);
  });
});
