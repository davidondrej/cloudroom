import { z } from "zod";
import type { AppDeps } from "../../types.js";
import { CloudroomError, type SessionRecord } from "./client.js";

// GPU approval cards (ADR 0331, 0333). This server alone shows them and sends the user's answer to the website, for
// Local threads (the website's reply to `room-cli gpu`, via routes.ts) and Cloud threads (Core's `gpu_request`
// record). The agent controls its sandbox and so that record: it only names the session, and the card comes from the
// website. The answer carries the spending limit the card showed, and the website starts nothing that costs more. No
// HTTP route takes an answer from an agent, and the card only accepts one from the app window (APP_ONLY_PLUGINS in
// routes/threads/interactions.ts).
export const GPU_PLUGIN_ID = "gpu";
const RENDERER_ID = "gpu-approval"; // APPROVAL_RENDERER_ID in plugins/gpu/contract.ts
const CARD_MS = 60 * 60_000;
/** While a card is open, how often to ask whether its request still waits (docs/scopes/gpus.md). */
const RECHECK_MS = 60_000;

const approvalSchema = z.object({ id: z.string().uuid(), title: z.string().max(200), payload: z.object({ max_credits: z.number() }).passthrough() });
type Approval = z.infer<typeof approvalSchema>;

type Deps = Partial<Pick<AppDeps, "pendingInteractions" | "logger">>;

export class GpuApprovals {
  private readonly open = new Map<string, { threadId: string; controller: AbortController }>();
  private timer: ReturnType<typeof setInterval> | null = null;
  private checking = false;
  /** `website` posts to /api/desktop/gpu as this app's account. */
  constructor(private readonly deps: Deps, private readonly website: (body: Record<string, unknown>) => Promise<unknown>) {}

  /** Only new records: a replayed request is answered already, or shown again by the agent's next `wait`. */
  follow(threadId: string, record: SessionRecord): void {
    if (record.timestamp_ms && Date.now() - record.timestamp_ms > CARD_MS) return;
    const named = z.object({ id: z.string().uuid() }).safeParse(record.data);
    if (named.success) this.ask(threadId, named.data.id, async () => z.object({ approval: approvalSchema.optional() }).parse(await this.website({ card: named.data.id })).approval);
  }

  /** A card from the website's reply to this server's own call (Local threads). */
  show(threadId: string, approval: unknown): void {
    const parsed = approvalSchema.safeParse(approval);
    if (parsed.success) this.ask(threadId, parsed.data.id, async () => parsed.data);
  }

  private ask(threadId: string, id: string, card: () => Promise<Approval | undefined>): void {
    const interactions = this.deps.pendingInteractions;
    if (!interactions || this.open.has(id)) return;
    const controller = new AbortController();
    this.open.set(id, { threadId, controller });
    this.watch();
    void (async () => {
      try {
        // No card: the session is no longer pending, or isn't this account's.
        const approval = await card();
        if (approval?.id !== id) return;
        const { title, payload } = approval;
        const decide = (approve: boolean) => this.website({ decide: { id, approve, max_credits: payload.max_credits } });
        const result = await interactions.requestPluginInteraction({ pluginId: GPU_PLUGIN_ID, rendererId: RENDERER_ID, threadId, title, payload: payload as never, timeoutMs: CARD_MS, signal: controller.signal });
        if (result.outcome === "submitted") await decide(z.object({ approve: z.boolean() }).parse(result.value).approve);
        else if (result.reason === "user") await decide(false);
      } catch (error) {
        // The session stays pending: the agent's next `room-cli gpu wait` shows the card again.
        this.deps.logger?.warn({ threadId, err: error }, "GPU approval could not be sent");
      } finally {
        this.open.delete(id);
        this.watch();
      }
    })();
  }

  /**
   * Closes open cards whose request no longer waits: the agent cancelled it, another computer answered it, or it
   * expired. Closing is never a Deny. Runs every minute while a card is open (Cloud threads' `room-cli gpu stop` goes
   * from the sandbox to the website, past this server) and at once after a Local thread's stop (routes.ts).
   */
  async recheck(threadId?: string): Promise<void> {
    if (this.checking) return;
    this.checking = true;
    try {
      for (const [id, card] of this.open) {
        if (threadId && card.threadId !== threadId) continue;
        // Websites before the check answer with the card itself, which they send only while it waits.
        const waiting = await this.website({ card: id, check: true }).then(
          (reply) => { const r = reply as { pending?: unknown; approval?: unknown }; return typeof r.pending === "boolean" ? r.pending : Boolean(r.approval); },
          // Gone or not this account's: close it. Any other error keeps the card, so an outage never hides one.
          (error: unknown) => !(error instanceof CloudroomError && error.status === 404));
        if (!waiting) card.controller.abort();
      }
    } finally {
      this.checking = false;
    }
  }

  private watch(): void {
    if (this.open.size === 0) {
      if (this.timer) clearInterval(this.timer);
      this.timer = null;
      return;
    }
    this.timer ??= setInterval(() => void this.recheck(), RECHECK_MS);
    this.timer.unref?.();
  }
}
