import { z } from "zod";

// The website's answers to `room-cli gpu` (web/lib/gpu.ts) and the approval card's payload. The app's server shows the
// card (apps/server/src/services/cloudroom/gpu.ts) with this plugin's renderer.
export const APPROVAL_RENDERER_ID = "gpu-approval";

export const approvalPayloadSchema = z.object({
  gpu: z.string(),
  name: z.string().optional(),
  count: z.number().optional(),
  cpu: z.number(),
  memory: z.number(),
  disk: z.number(),
  hours: z.number(),
  purpose: z.string(),
  credits_per_hour: z.number(),
  max_credits: z.number(),
  credits_left: z.number().nullable(),
});
export type ApprovalPayload = z.infer<typeof approvalPayloadSchema>;
export const decisionSchema = z.object({ approve: z.boolean() });

const link = z.string().url().refine((url) => url.startsWith("https://"));
export const replySchema = z.object({
  output: z.string(),
  exit_code: z.number().int(),
  approval: z.object({ id: z.string().uuid(), title: z.string(), payload: approvalPayloadSchema }).optional(),
  upload: z.object({ url: link, path: z.string().min(1) }).optional(),
  download: z.object({ url: link, dir: z.string().min(1) }).optional(),
  next: z.object({ argv: z.array(z.string()), after_ms: z.number().int().min(0).max(60_000) }).optional(),
});
export type Reply = z.infer<typeof replySchema>;
