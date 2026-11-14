import { defineRpcContract } from "@get-bb/plugin-sdk";
import { z } from "zod";

export const antigravityLoginInput = z
  .object({
    action: z
      .enum(["status", "login", "cancel", "complete", "logout"])
      .default("status"),
    requestId: z
      .string()
      .regex(/^[a-zA-Z0-9_-]{1,64}$/)
      .optional(),
    /** Google's one-time authorization code, or the full URL of the page the sign-in lands on. */
    code: z.string().min(1).max(4096).optional(),
  })
  .strict();
export const antigravityLoginStatus = z.object({
  state: z.enum([
    "missing",
    "waiting",
    "connected",
    "unavailable",
    "error",
    "expired",
  ]),
  message: z.string().nullable(),
  login_id: z.string().nullable(),
  verification_url: z.string().nullable(),
});
export const antigravityLoginHostContract = defineRpcContract({
  account: { input: antigravityLoginInput, output: antigravityLoginStatus },
});
export const antigravityLoginRpcContract = defineRpcContract({
  antigravityAccount: {
    input: antigravityLoginInput.extend({
      hostId: z.string().min(1).optional(),
      environmentId: z.string().min(1).optional(),
    }),
    // The machine Antigravity signs in on.
    output: antigravityLoginStatus.extend({ host_id: z.string() }),
  },
});
export type AntigravityLoginInput = z.infer<typeof antigravityLoginInput>;
export type AntigravityLoginStatus = z.infer<typeof antigravityLoginStatus>;
