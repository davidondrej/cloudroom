import { defineRpcContract } from "@get-bb/plugin-sdk";
import { z } from "zod";

export const APPROVAL_RENDERER_ID = "computer-use-approval";

export const permissionsSchema = z
  .object({
    accessibility: z.boolean().nullable(),
    screenRecording: z.boolean().nullable(),
  })
  .strict();
export const hostStatusSchema = z
  .object({
    platform: z.string(),
    supported: z.boolean(),
    reason: z.string().nullable(),
    version: z.string(),
    installed: z.boolean(),
    running: z.boolean(),
    permissions: permissionsSchema,
    hint: z.string().nullish(),
  })
  .strict();
export type HostStatus = z.infer<typeof hostStatusSchema>;
export const appSchema = z
  .object({ key: z.string().min(1), name: z.string().min(1) })
  .strict();
export type AppIdentity = z.infer<typeof appSchema>;
export const permissionKindSchema = z.enum(["accessibility", "screenRecording"]);

export const hostContract = defineRpcContract({
  status: { input: z.object({}).strict(), output: hostStatusSchema },
  prepare: {
    input: z.object({}).strict(),
    output: hostStatusSchema.extend({ installMs: z.number().nullable() }),
  },
  call: {
    input: z
      .object({
        tool: z.string().min(1).max(80),
        args: z.record(z.string(), z.unknown()),
        session: z.string().min(1).max(64),
        shotsDir: z.string().min(1),
      })
      .strict(),
    output: z
      .object({
        exitCode: z.number().int(),
        stdout: z.string(),
        stderr: z.string(),
        driverExits: z.number().int(),
      })
      .strict(),
  },
  release: {
    input: z.object({ session: z.string().min(1).max(64) }).strict(),
    output: z.null(),
  },
  describe: {
    input: z.object({ tool: z.string().max(80).nullable() }).strict(),
    output: z.string(),
  },
  appForPid: {
    input: z.object({ pid: z.number().int().positive() }).strict(),
    output: appSchema.nullable(),
  },
  appForName: {
    input: z.object({ name: z.string().min(1).max(200) }).strict(),
    output: appSchema,
  },
  requestPermission: {
    input: z.object({ kind: permissionKindSchema }).strict(),
    output: hostStatusSchema,
  },
  restart: { input: z.object({}).strict(), output: hostStatusSchema },
});

export const approvalPayloadSchema = z
  .object({
    app: appSchema,
    tool: z.string(),
    purpose: z.string().nullable(),
    platform: z.string(),
    permissions: permissionsSchema,
  })
  .strict();
export type ApprovalPayload = z.infer<typeof approvalPayloadSchema>;
export const approvalResponseSchema = z
  .object({ decision: z.enum(["thread", "always", "deny"]) })
  .strict();

export const settingsSchema = z
  .object({
    hostId: z.string().nullable(),
    status: hostStatusSchema.nullable(),
    error: z.string().nullable(),
    alwaysAllowed: z.array(appSchema),
  })
  .strict();
export const rpcContract = defineRpcContract({
  getSettings: { input: z.null(), output: settingsSchema },
  removeAlwaysAllowed: {
    input: z.object({ key: z.string().min(1) }).strict(),
    output: settingsSchema,
  },
  requestPermission: {
    input: z.object({ kind: permissionKindSchema }).strict(),
    output: settingsSchema,
  },
  restart: { input: z.null(), output: settingsSchema },
});
