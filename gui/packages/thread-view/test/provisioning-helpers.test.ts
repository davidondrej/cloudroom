import { describe, expect, it } from "vitest";
import {
  mergeProvisioningState,
  type ProvisioningState,
} from "../src/messages.js";

describe("mergeProvisioningState", () => {
  it("coalesces repeated provisioning phases into one sequence", () => {
    const existing: ProvisioningState = {
      provisioningId: "provision_1",
      transcript: [
        {
          type: "step",
          key: "workspace-started",
          text: "Preparing workspace",
          status: "started",
        },
      ],
      rawDetails: [],
    };
    mergeProvisioningState(existing, {
      environmentId: "env_1",
      provisioningId: "provision_1",
      transcript: [
        {
          type: "step",
          key: "workspace-started",
          text: "Preparing workspace",
          status: "completed",
        },
        {
          type: "step",
          key: "provider-create",
          text: "Preparing worktree…",
          status: "started",
        },
      ],
      rawDetails: [],
    });

    expect(existing.transcript).toEqual([
      {
        type: "step",
        key: "workspace-started",
        text: "Preparing workspace",
        status: "completed",
      },
      {
        type: "step",
        key: "provider-create",
        text: "Preparing worktree…",
        status: "started",
      },
    ]);
  });
});
