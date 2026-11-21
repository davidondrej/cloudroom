import { defineRpcContract } from "@get-bb/plugin-sdk";
import { experimental_nativeRootsHostContract } from "@get-bb/plugin-sdk/host";
import { experimental_acpAgentProbeSchema } from "@get-bb/plugin-sdk/provider-bridge/acp";
import { z } from "zod";

/** Antigravity's Google sign-in on one machine, run as `agy acp --login`. */
export const antigravityLoginInput = z
  .object({
    action: z
      .enum(["status", "login", "cancel", "complete", "logout"])
      .default("status"),
    requestId: z
      .string()
      .regex(/^[a-zA-Z0-9_-]{1,64}$/u)
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
export type AntigravityLoginInput = z.infer<typeof antigravityLoginInput>;
export type AntigravityLoginStatus = z.infer<typeof antigravityLoginStatus>;

/** The app's Sign in with Google: runs on the given machine, or the primary one. */
export const antigravityLoginRpcContract = defineRpcContract({
  antigravityAccount: {
    input: antigravityLoginInput.extend({
      hostId: z.string().min(1).optional(),
    }),
    // The machine Antigravity signs in on.
    output: antigravityLoginStatus.extend({ host_id: z.string() }),
  },
});

export const acpHostContract = defineRpcContract({
  antigravityLogin: {
    input: antigravityLoginInput,
    output: antigravityLoginStatus,
  },
  probeAgent: {
    input: z
      .object({
        command: z.string().min(1),
        args: z.array(z.string()),
        env: z.record(z.string(), z.string()),
      })
      .strict(),
    output: experimental_acpAgentProbeSchema,
  },
  ...experimental_nativeRootsHostContract,
});
