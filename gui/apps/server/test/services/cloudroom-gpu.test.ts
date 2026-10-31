import { expect, it, vi } from "vitest";
import { GpuApprovals } from "../../src/services/cloudroom/gpu.js";
import type { PluginInteractionResult } from "../../src/services/interactions/pending-interactions.js";

// The GPU approval card (docs/scopes/gpus.md). A Cloud agent controls its sandbox, so Core's `gpu_request` record may
// say anything: only its session ID counts, and the card and the limit the user approves come from the website.
const id = "6f1c2d3e-4a5b-4c6d-8e7f-0a1b2c3d4e5f";
const card = (max_credits: number, session = id) => ({
  id: session, title: "Use a GPU?",
  payload: { gpu: "4x H100 80 GB", name: "H100", count: 4, cpu: 32, memory: 192, disk: 100, hours: 8, purpose: "Train", credits_per_hour: 40_000, max_credits, credits_left: 400_000 },
});
const record = (data: unknown) => ({ sequence: 7, session_id: "cr_session", kind: "gpu_request", data: data as never, timestamp_ms: Date.now() });

function harness(website: (body: Record<string, unknown>) => Promise<unknown>, answer: PluginInteractionResult = { outcome: "submitted", value: { approve: true } }) {
  const shown: unknown[] = [], calls: Record<string, unknown>[] = [];
  const pendingInteractions = { requestPluginInteraction: async (args: { payload: unknown }) => { shown.push(args.payload); return answer; } };
  const approvals = new GpuApprovals({ pendingInteractions: pendingInteractions as never }, async body => { calls.push(body); return website(body); });
  return { approvals, shown, calls };
}

it("shows a Cloud thread's card from the website, not from Core's record, and approves the website's limit", async () => {
  const { approvals, shown, calls } = harness(async body => body.card ? { approval: card(320_000) } : { status: "starting" });
  approvals.follow("thr_cloud", record({ ...card(500), payload: { ...card(500).payload, gpu: "1x RTX 4000 20 GB", count: 1 } }));
  await vi.waitFor(() => expect(calls).toHaveLength(2));
  expect(calls[0]).toEqual({ card: id });
  expect(shown).toEqual([card(320_000).payload]);
  expect(calls[1]).toEqual({ decide: { id, approve: true, max_credits: 320_000 } });
});

it("shows nothing without the website's card for that session", async () => {
  for (const reply of [{}, { approval: card(320_000, "0b1c2d3e-4a5b-4c6d-8e7f-0a1b2c3d4e5f") }]) {
    const { approvals, shown, calls } = harness(async () => reply);
    approvals.follow("thr_cloud", record({ id }));
    await vi.waitFor(() => expect(calls).toHaveLength(1));
    await new Promise(resolve => setTimeout(resolve, 10));
    expect(shown).toEqual([]);
    expect(calls).toEqual([{ card: id }]);
  }
  const { approvals, calls } = harness(async () => ({ approval: card(320_000) }));
  approvals.follow("thr_cloud", record({ id: "not-a-session" }));
  await new Promise(resolve => setTimeout(resolve, 10));
  expect(calls).toEqual([]);
});

it("asks the website once per session at a time, and again after a failed call", async () => {
  let fail = true;
  const { approvals, shown, calls } = harness(async body => {
    if (!body.card) return { status: "starting" };
    if (fail) throw new Error("offline");
    return { approval: card(320_000) };
  });
  approvals.follow("thr_cloud", record({ id }));
  approvals.follow("thr_cloud", record({ id }));
  await vi.waitFor(() => expect(calls).toHaveLength(1));
  await new Promise(resolve => setTimeout(resolve, 10));
  expect(shown).toEqual([]);
  fail = false;
  approvals.follow("thr_cloud", record({ id }));
  await vi.waitFor(() => expect(calls).toHaveLength(3));
  expect(shown).toHaveLength(1);
});

it("answers a Local thread's card with that card's limit, and a dismissal denies", async () => {
  const approved = harness(async () => ({ status: "starting" }));
  approved.approvals.show("thr_local", card(9_000));
  await vi.waitFor(() => expect(approved.calls).toEqual([{ decide: { id, approve: true, max_credits: 9_000 } }]));
  const dismissed = harness(async () => ({ status: "stopped" }), { outcome: "cancelled", reason: "user" });
  dismissed.approvals.show("thr_local", card(9_000));
  await vi.waitFor(() => expect(dismissed.calls).toEqual([{ decide: { id, approve: false, max_credits: 9_000 } }]));
  expect(dismissed.shown).toEqual([card(9_000).payload]);
});
