import { defineRpcContract } from "@get-bb/plugin-sdk";
import { experimental_nativeRootsHostContract } from "@get-bb/plugin-sdk/host";
import { z } from "zod";

export const claudeLoginInput = z
  .object({
    action: z.enum(["status", "login", "cancel", "complete"]).default("status"),
    requestId: z
      .string()
      .regex(/^[a-zA-Z0-9_-]{1,64}$/)
      .optional(),
    code: z
      .string()
      .min(1)
      .max(2048)
      .refine(
        (value) => !value.startsWith("sk-ant-"),
        "Use a one-time sign-in code, not a token.",
      )
      .optional(),
    state: z.string().min(1).max(512).optional(),
  })
  .strict();
export const claudeLoginStatus = z.object({
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
  manual_url: z.string().nullable().optional(),
});
export const claudeLoginHostContract = defineRpcContract({
  ...experimental_nativeRootsHostContract,
  account: { input: claudeLoginInput, output: claudeLoginStatus },
});
export const claudeLoginRpcContract = defineRpcContract({
  claudeAccount: {
    input: claudeLoginInput.extend({
      hostId: z.string().min(1).optional(),
      environmentId: z.string().min(1).optional(),
    }),
    output: claudeLoginStatus,
  },
});
export type ClaudeLoginInput = z.infer<typeof claudeLoginInput>;
export type ClaudeLoginStatus = z.infer<typeof claudeLoginStatus>;
