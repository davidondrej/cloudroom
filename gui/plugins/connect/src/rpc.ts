import { z } from "zod";
import { defineRpcContract, type PluginRpcHandlers } from "@get-bb/plugin-sdk";
import { connectCredentialSchema } from "@cloudroom/connect-client";
import type { ConnectTunnel } from "./tunnel.js";
import type { PhoneRelay } from "./phone.js";
import type { ConnectStatus, ShareListing } from "./types.js";
import type { ShareHostResolver } from "./hosts.js";
import {
  setupJobInputSchema,
  setupJobStatusInputSchema,
  type Mac,
  type SetupJobs,
} from "./macs.js";

const portInputSchema = z
  .object({
    port: z.number().int().min(1).max(65535),
    hostId: z.string().min(1).optional(),
  })
  .strict();
const revokeMachineInputSchema = z.object({ machineId: z.string().min(1) });

const shareListingSchema: z.ZodType<ShareListing> = z
  .object({
    hostId: z.string(),
    hostName: z.string(),
    port: z.number().int(),
    createdAt: z.number(),
    url: z.string(),
    unavailableReason: z.string().optional(),
  })
  .strict();

const stateSchema = z.enum(["disconnected", "connected", "reconnecting"]);

const connectStatusSchema: z.ZodType<ConnectStatus> = z
  .object({
    state: stateSchema,
    paired: z.boolean(),
    handle: z.string().nullable(),
    url: z.string().nullable(),
    lastError: z.string().nullable(),
    nextRetryAt: z.number().nullable(),
    since: z.number(),
    remoteClients: z.number().int(),
    lastRemoteActivityAt: z.number().nullable(),
    shares: z.array(shareListingSchema),
    signedIn: z.boolean(),
  })
  .strict();

const macSchema: z.ZodType<Mac> = z
  .object({
    handle: z.string(),
    name: z.string(),
    online: z.boolean(),
    self: z.boolean(),
    hostId: z.string().nullable(),
    settingUp: z.boolean(),
  })
  .strict();

const remoteInstructionsSchema = z.object({ enabled: z.boolean() }).strict();
const remoteInstructionsInputSchema = z.object({ enabled: z.boolean().optional() }).strict();

export const connectRpcContract = defineRpcContract({
  status: { input: z.null(), output: connectStatusSchema },
  signOutPhones: {
    input: z.null(),
    output: z.object({ revoked: z.number().int() }).strict(),
  },
  expose: { input: portInputSchema, output: shareListingSchema },
  unexpose: {
    input: portInputSchema,
    output: z
      .object({
        removed: z.boolean(),
        hostId: z.string(),
        hostName: z.string(),
        port: z.number().int(),
      })
      .strict(),
  },
  listShares: { input: z.null(), output: z.array(shareListingSchema) },
  /** This Mac's cloudroom.run key. The desktop app keeps it to list and open your other Macs. */
  relayCredential: { input: z.null(), output: connectCredentialSchema.nullable() },
  /** Read the "Tell agents about remote access" setting, or set it when `enabled` is given. */
  remoteInstructions: { input: remoteInstructionsInputSchema, output: remoteInstructionsSchema },
  /** Removes a remote host's access to this Mac. The server calls it when you remove the machine. */
  revokeMachine: {
    input: revokeMachineInputSchema,
    output: z.object({ ok: z.literal(true) }).strict(),
  },
  /** Every Mac signed in to this Cloudroom account, and which ones this Mac runs threads on. */
  macs: { input: z.null(), output: z.object({ macs: z.array(macSchema) }).strict() },
  /** Another of your Macs installs Cloudroom's machine helper here, so it can run threads on this Mac. */
  runSetupJob: { input: setupJobInputSchema, output: z.object({ jobId: z.string() }).strict() },
  setupJobStatus: {
    input: setupJobStatusInputSchema,
    output: z.object({ output: z.string(), exitCode: z.number().int().nullable() }).strict(),
  },
});

type ConnectRpcHandlers = PluginRpcHandlers<typeof connectRpcContract>;

export function createRpcHandlers(args: {
  relay: ConnectTunnel;
  phone: PhoneRelay;
  status: () => ConnectStatus;
  hostResolver: ShareHostResolver;
  remoteInstructions: (enabled?: boolean) => Promise<boolean>;
  listMacs: () => Promise<Mac[]>;
  setupJobs: SetupJobs;
}): ConnectRpcHandlers {
  const { relay, phone, status, hostResolver, remoteInstructions, listMacs, setupJobs } = args;
  const tunnel = relay;
  return {
    async status() {
      return { ...status(), shares: await relay.listShares() };
    },
    async signOutPhones() {
      return phone.signOutPhones();
    },
    async expose(args) {
      const host =
        args.hostId === undefined
          ? await hostResolver.serverHost()
          : await hostResolver.byId(args.hostId);
      return tunnel.expose(args.port, host);
    },
    async unexpose(args) {
      return tunnel.unexpose(
        args.port,
        args.hostId ?? (await hostResolver.serverHostId()),
      );
    },
    async listShares() {
      return tunnel.listShares();
    },
    async relayCredential() {
      // Check first, so a sign-out since the last minute's check has already retired the key.
      await phone.check();
      return relay.getCredential();
    },
    async remoteInstructions(args) {
      return { enabled: await remoteInstructions(args.enabled) };
    },
    async revokeMachine(args) {
      await phone.call("/api/machines/revoke", { machineId: args.machineId });
      return { ok: true };
    },
    async macs() {
      await phone.check();
      return { macs: phone.signedIn ? await listMacs() : [] };
    },
    async runSetupJob(args) {
      return setupJobs.start(args.command, args.stdin);
    },
    async setupJobStatus(args) {
      return setupJobs.status(args.jobId, args.offset);
    },
  };
}
