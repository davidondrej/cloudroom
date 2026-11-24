import { describe, expect, it } from "vitest";
import type {
  OwnershipChangeOperationAction,
  SystemThreadInterruptedReason,
  SystemThreadProvisioningStatus,
  ThreadEvent,
  ThreadEventRow,
} from "@cloudroom/domain";
import {
  finalizeOperationRow,
  interruptOperationRow,
  parseOperationEvent,
  type ProvisioningState,
} from "../src/messages.js";
import type { TimelineSystemRow } from "@cloudroom/server-contract";
import {
  createTimelineEventFactory,
  decodeThreadEventRow,
} from "./timeline-test-harness.js";

const THREAD_ID = "thr_fixauth";
const THREAD_NAME = "Fix auth bug";

function factory() {
  return createTimelineEventFactory({ threadId: THREAD_ID });
}

function operationTitleFor(row: ThreadEventRow, threadName: string): string {
  const { event, meta } = decodeThreadEventRow(row);
  const parsed = parseOperationEvent(event, meta, { threadName });
  if (parsed === null || parsed.kind !== "operation") {
    throw new Error(`expected operation row, got ${parsed?.kind ?? null}`);
  }
  return parsed.row.title;
}

function provisioningTitle(
  status: SystemThreadProvisioningStatus,
  threadName: string,
): string {
  return operationTitleFor(
    factory().threadProvisioning({ status, entries: [] }),
    threadName,
  );
}

function interruptedTitle(
  reason: SystemThreadInterruptedReason,
  threadName: string,
  cause?: "host-connection-lost",
): string {
  return operationTitleFor(
    factory().systemThreadInterrupted({ reason, cause }),
    threadName,
  );
}

function ownershipTitle(
  action: OwnershipChangeOperationAction,
  parents: {
    nextParentThreadTitle: string | null;
    previousParentThreadTitle: string | null;
  },
  threadName: string,
): string {
  const row = factory().systemOperation({
    operation: "ownership_change",
    status: "completed",
    message: "",
    metadata: {
      action,
      nextParentThreadId: parents.nextParentThreadTitle ? "thr_parent" : null,
      nextParentThreadTitle: parents.nextParentThreadTitle,
      previousParentThreadId: parents.previousParentThreadTitle
        ? "thr_prev"
        : null,
      previousParentThreadTitle: parents.previousParentThreadTitle,
    },
  });
  return operationTitleFor(row, threadName);
}

describe("parseOperationEvent operation titles", () => {
  it.each(["storage_warning", "storage_pause", "storage_recovered"])(
    "hides the %s notice from the chat; the composer card shows it",
    (operation) => {
      const { event, meta } = decodeThreadEventRow(
        factory().systemOperation({
          operation,
          status: "completed",
          message: "Cloud storage notice.",
        }),
      );
      expect(
        parseOperationEvent(event, meta, { threadName: THREAD_NAME }),
      ).toBeNull();
    },
  );

  it("renders provider environment provenance without revealing masked values", () => {
    const event: ThreadEvent = {
      type: "provider.env-resolved",
      threadId: THREAD_ID,
      providerThreadId: "provider-thread-1",
      scope: { kind: "thread" },
      entries: [
        {
          name: "PLUGIN_TOKEN",
          source: { plugin: "auth-proxy" },
          value: { masked: true },
          reason: "Authenticate provider traffic",
        },
        // Stored before #1938: raw shell values in history.
        { name: "GH_TOKEN", source: "shell", value: "fake-stored-token" },
        { name: "PATH", source: "shell", value: "/usr/bin" },
      ],
    };
    const parsed = parseOperationEvent(
      event,
      { id: "event-provider-env", seq: 1, createdAt: 1 },
      { includeDiagnosticOperations: true, threadName: "" },
    );

    expect(
      parseOperationEvent(
        event,
        { id: "hidden", seq: 1, createdAt: 1 },
        { threadName: "" },
      ),
    ).toBeNull();
    expect(parsed).toMatchObject({
      kind: "operation",
      row: {
        title: "Provider environment resolved",
        detail: [
          "PLUGIN_TOKEN=•••••• (auth-proxy) — Authenticate provider traffic",
          "GH_TOKEN=•••••• (shell)",
          "PATH=/usr/bin (shell)",
        ].join("\n"),
      },
    });
  });

  describe("provider-unhandled", () => {
    it("uses the projected provider display name for dynamic providers", () => {
      const { event, meta } = decodeThreadEventRow(
        factory().providerUnhandled({ providerId: "acp-my-agent" }),
      );
      const parsed = parseOperationEvent(event, meta, {
        includeDiagnosticOperations: true,
        providerDisplayName: "My Agent",
        threadName: THREAD_NAME,
      });

      expect(parsed).toMatchObject({
        kind: "operation",
        row: { title: "Unhandled My Agent event" },
      });
    });

    it("falls back to the provider id when no display name is projected", () => {
      const { event, meta } = decodeThreadEventRow(
        factory().providerUnhandled({ providerId: "acp-my-agent" }),
      );
      const parsed = parseOperationEvent(event, meta, {
        includeDiagnosticOperations: true,
        threadName: THREAD_NAME,
      });

      expect(parsed).toMatchObject({
        kind: "operation",
        row: { title: "Unhandled acp-my-agent event" },
      });
    });
  });

  describe("thread-provisioning", () => {
    it("keeps self-scoped lifecycle titles free of the current thread name", () => {
      expect(provisioningTitle("active", THREAD_NAME)).toBe(
        "Provisioning thread",
      );
      expect(provisioningTitle("completed", THREAD_NAME)).toBe(
        "Provisioned thread",
      );
      expect(provisioningTitle("failed", THREAD_NAME)).toBe(
        "Provisioning thread failed",
      );
      expect(provisioningTitle("cancelled", THREAD_NAME)).toBe(
        "Provisioning thread interrupted",
      );
    });

    it("does not depend on whether the thread is named", () => {
      expect(provisioningTitle("active", "")).toBe("Provisioning thread");
      expect(provisioningTitle("completed", "")).toBe("Provisioned thread");
    });
  });

  describe("thread-interrupted", () => {
    it("does not name or link back to the current thread", () => {
      expect(interruptedTitle("manual-stop", THREAD_NAME)).toBe(
        "Stopped manually",
      );
      expect(interruptedTitle("host-daemon-restarted", THREAD_NAME)).toBe(
        "Stopped — host daemon restarted",
      );
      expect(
        interruptedTitle(
          "host-daemon-restarted",
          THREAD_NAME,
          "host-connection-lost",
        ),
      ).toBe("Stopped — connection to host was lost");
    });
  });

  it("renders a context clear as a concise completed boundary", () => {
    const { event, meta } = decodeThreadEventRow(
      factory().systemOperation({
        operation: "context_clear",
        status: "completed",
        message:
          "New prompts won’t include messages above. Thread history and workspace are unchanged.",
      }),
    );

    expect(
      parseOperationEvent(event, meta, { threadName: THREAD_NAME }),
    ).toMatchObject({
      kind: "operation",
      row: {
        title: "Context cleared",
        detail:
          "New prompts won’t include messages above. Thread history and workspace are unchanged.",
        status: "completed",
      },
    });
  });

  describe("ownership-change", () => {
    it("links the thread to its new/previous parent by action", () => {
      expect(
        ownershipTitle(
          "assign",
          { nextParentThreadTitle: "Release manager", previousParentThreadTitle: null },
          THREAD_NAME,
        ),
      ).toBe("Fix auth bug assigned to Release manager");
      expect(
        ownershipTitle(
          "release",
          { nextParentThreadTitle: null, previousParentThreadTitle: "Release manager" },
          THREAD_NAME,
        ),
      ).toBe("Fix auth bug released from Release manager");
      expect(
        ownershipTitle(
          "transfer",
          {
            nextParentThreadTitle: "Frontend parent",
            previousParentThreadTitle: "Release manager",
          },
          THREAD_NAME,
        ),
      ).toBe("Fix auth bug transferred to Frontend parent");
    });

    it("falls back to 'parent' when the parent thread title is null", () => {
      expect(
        ownershipTitle(
          "assign",
          { nextParentThreadTitle: null, previousParentThreadTitle: null },
          THREAD_NAME,
        ),
      ).toBe("Fix auth bug assigned to parent");
    });
  });

  describe("post-hoc overrides stay scoped to the current thread", () => {
    function pendingProvisioning(): {
      row: Extract<TimelineSystemRow, { systemKind: "operation" }>;
      provMap: Map<TimelineSystemRow, ProvisioningState>;
    } {
      const { event, meta } = decodeThreadEventRow(
        factory().threadProvisioning({ status: "active", entries: [] }),
      );
      const parsed = parseOperationEvent(event, meta, { threadName: THREAD_NAME });
      if (parsed === null || parsed.kind !== "operation") {
        throw new Error("expected operation");
      }
      const provMap = new Map<TimelineSystemRow, ProvisioningState>();
      if (parsed.provisioning) provMap.set(parsed.row, parsed.provisioning);
      return { row: parsed.row, provMap };
    }

    it("interruptOperationRow does not add the current thread name", () => {
      const { row, provMap } = pendingProvisioning();
      interruptOperationRow(row, provMap);
      expect(row.title).toBe("Provisioning thread interrupted");
    });

    it("finalizeOperationRow on error does not add the current thread name", () => {
      const { row, provMap } = pendingProvisioning();
      finalizeOperationRow(row, "error", provMap);
      expect(row.title).toBe("Provisioning thread failed");
    });
  });
});
