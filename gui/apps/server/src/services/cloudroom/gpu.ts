import { z } from "zod";
import type { AppDeps } from "../../types.js";
import type { SessionRecord } from "./client.js";

// GPU approval cards (ADR 0331, 0333). This server alone shows them and sends the user's answer to the website, for
// Local threads (the website's reply to `room-cli gpu`, via routes.ts) and Cloud threads (Core's `gpu_request`
// record). No HTTP route takes an answer from an agent, and the card only accepts one from the app window
// (APP_ONLY_PLUGINS in routes/threads/interactions.ts).
export const GPU_PLUGIN_ID = "gpu";
const RENDERER_ID = "gpu-approval"; // APPROVAL_RENDERER_ID in plugins/gpu/contract.ts
const CARD_MS = 60 * 60_000;

const approvalSchema = z.object({ id: z.string().uuid(), title: z.string().max(200), payload: z.record(z.string(), z.unknown()) });

type Deps = Partial<Pick<AppDeps, "pendingInteractions" | "logger">>;

export class GpuApprovals {
  private readonly open = new Set<string>();
  constructor(private readonly deps: Deps, private readonly decide: (id: string, approve: boolean) => Promise<unknown>) {}

  /** Only new records: a replayed request is answered already, or shown again by the agent's next `wait`. */
  follow(threadId: string, record: SessionRecord): void {
    if (record.timestamp_ms && Date.now() - record.timestamp_ms > CARD_MS) return;
    this.show(threadId, record.data);
  }

  show(threadId: string, approval: unknown): void {
    const parsed = approvalSchema.safeParse(approval);
    const interactions = this.deps.pendingInteractions;
    if (!parsed.success || !interactions || this.open.has(parsed.data.id)) return;
    const { id, title, payload } = parsed.data;
    this.open.add(id);
    void (async () => {
      try {
        const result = await interactions.requestPluginInteraction({ pluginId: GPU_PLUGIN_ID, rendererId: RENDERER_ID, threadId, title, payload: payload as never, timeoutMs: CARD_MS });
        if (result.outcome === "submitted") await this.decide(id, z.object({ approve: z.boolean() }).parse(result.value).approve);
        else if (result.reason === "user") await this.decide(id, false);
      } catch (error) {
        // The session stays pending: the agent's next `room-cli gpu wait` shows the card again.
        this.deps.logger?.warn({ threadId, err: error }, "GPU approval could not be sent");
      } finally {
        this.open.delete(id);
      }
    })();
  }
}
