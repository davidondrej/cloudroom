import { z } from "zod";
import type { AppDeps } from "../../types.js";
import type { CloudroomClient, SessionRecord } from "./client.js";

// A cloud agent's `room-cli secret request` reuses the Secrets plugin's form.
// Values go straight back to the core and never enter thread events.
const PLUGIN_ID = "secrets";
const RENDERER_ID = "secret-request"; // SECRET_REQUEST_RENDERER_ID in @cloudroom/plugin-interaction-contracts
const FORM_TIMEOUT_MS = 60 * 60_000;

const requestSchema = z.discriminatedUnion("state", [
  z.object({
    id: z.string(), state: z.literal("open"), purpose: z.string().nullable(), path: z.string(),
    fields: z.array(z.object({ name: z.string(), description: z.string().nullable() })),
  }),
  z.object({ id: z.string(), state: z.literal("closed") }),
]);
const answerSchema = z.object({ values: z.record(z.string(), z.string()) });

type Deps = Partial<Pick<AppDeps, "pendingInteractions" | "logger">>;

export class CloudSecrets {
  private readonly open = new Map<string, { id: string; controller: AbortController }>();
  constructor(private readonly deps: Deps) {}

  follow(client: CloudroomClient, threadId: string, record: SessionRecord): void {
    const parsed = requestSchema.safeParse(record.data);
    if (!parsed.success) return;
    const request = parsed.data;
    const current = this.open.get(threadId);
    // A newer request replaces an older one, which the core may still be waiting on.
    if (current && (request.state === "open" || current.id === request.id)) current.controller.abort();
    if (request.state === "closed") return;
    const controller = new AbortController();
    this.open.set(threadId, { id: request.id, controller });
    void (async () => {
      let values: Record<string, string> | null = null;
      let reason = "the app could not show the form";
      try {
        if (!this.deps.pendingInteractions) throw new Error("Interactions are unavailable");
        const result = await this.deps.pendingInteractions.requestPluginInteraction({
          pluginId: PLUGIN_ID, rendererId: RENDERER_ID, threadId, title: `Add secrets to ${request.path}`,
          payload: { purpose: request.purpose, destination: { kind: "dotenv", path: request.path }, fields: request.fields },
          timeoutMs: FORM_TIMEOUT_MS, signal: controller.signal,
        });
        if (result.outcome === "submitted") values = answerSchema.parse(result.value).values;
        else reason = result.reason === "request-aborted" ? "replaced by a newer request" : result.reason;
      } catch (error) {
        if (error instanceof Error) reason = `${reason}: ${error.message}`;
        this.deps.logger?.warn({ threadId, err: error }, "Cloud secret form could not open");
      } finally {
        if (this.open.get(threadId)?.controller === controller) this.open.delete(threadId);
      }
      // Answer even after an abort: a replaced request still waits in the core. Closed ones are already gone.
      await client.answerSecret(record.session_id, request.id, values, reason).catch(() => {});
    })();
  }
}
