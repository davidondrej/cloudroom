import { describe, expect, it } from "vitest";
import { threadScope, turnScope } from "@cloudroom/domain";
import {
  isRepeatedChildReport,
  rememberChildReport,
  type ChildTurnReport,
} from "../../../src/services/threads/child-thread-notifications.js";
import { seedHostSession, seedProjectWithSource, seedStoredEvent, seedThread } from "../../helpers/seed.js";
import { withTestHarness } from "../../helpers/test-app.js";

// #1395: a child's reply that repeats the one its parent last got is not reported again.
describe("repeated child reports", () => {
  it("drops only a repeat of what the parent last got", async () => {
    await withTestHarness(async (harness) => {
      const { host } = seedHostSession(harness.deps, { id: "host-1395" });
      const { project } = seedProjectWithSource(harness.deps, { hostId: host.id });
      const parent = seedThread(harness.deps, { projectId: project.id, title: "Parent" });
      const child = seedThread(harness.deps, { projectId: project.id, title: "Child", parentThreadId: parent.id });
      const db = harness.deps.db;
      let seq = 100;
      let turns = 0;
      const event = (type: "turn/started" | "client/turn/requested", data: Record<string, unknown>, turnId?: string) =>
        seedStoredEvent(harness.deps, {
          createdAt: Date.now(), threadId: child.id, sequence: ++seq, type, data,
          scope: turnId ? turnScope(turnId) : threadScope(),
        });
      // A turn ends with `reply`: returns whether its parent would hear of it, and records it if so.
      const turn = (reply: string | null, extra: Partial<ChildTurnReport> = {}) => {
        const turnId = `t${++turns}`;
        event("turn/started", {}, turnId);
        const report = { childThreadId: child.id, parentThreadId: parent.id, reply, turnId, turnStatus: "completed", ...extra };
        if (isRepeatedChildReport(db, report)) return false;
        rememberChildReport(db, report);
        return true;
      };
      const message = (senderThreadId: string | null) => event("client/turn/requested", { senderThreadId });

      expect(turn("No change.")).toBe(true);
      expect(turn(" No   change.\n")).toBe(false);
      message(null); // the user's or a loop's message
      expect(turn("No change.")).toBe(false);
      message(parent.id);
      expect(turn("No change.")).toBe(true);
      expect(turn("Shipped.")).toBe(true);
      expect(turn("Shipped.", { waiting: true })).toBe(true); // work still runs
      expect(turn("Shipped.")).toBe(true); // the final reply after it
      expect(turn("Shipped.")).toBe(false);
      expect(turn(null, { turnStatus: "failed" })).toBe(true);
      expect(turn("Shipped.")).toBe(true);
      expect(turn("Shipped.", { turnId: undefined })).toBe(true); // no turn: never judged
      expect(turn("Shipped.", { parentThreadId: "thr_new_parent" })).toBe(true);
    });
  });
});
