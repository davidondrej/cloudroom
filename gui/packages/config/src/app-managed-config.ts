import { readFile } from "node:fs/promises";
import { join } from "node:path";
import {
  acpNativeReasoningSchema,
  acpReasoningCliSchema,
  providerNativeSkillRootsSchema,
} from "@cloudroom/domain";
import { z } from "zod";

const BUNDLED_PROVIDER_IDS = [
  "codex",
  "claude-code",
  "antigravity",
  "pi",
  "acp-cursor",
] as const;

const RESERVED_ACP_PROVIDER_IDS: ReadonlySet<string> = new Set(
  BUNDLED_PROVIDER_IDS,
);

const ROOM_APP_CONFIG_FILE_NAME = "config.json";
const ROOM_APP_ENV_FILE_NAME = "env.json";

export type RoomAppManagedConfigKey =
  | "BB_APP_URL"
  | "BB_INFERENCE"
  | "BB_INFERENCE_FALLBACK"
  | "BB_LOG_LEVEL"
  | "BB_TRANSCRIPTION";

export const ROOM_APP_MANAGED_CONFIG_KEYS: RoomAppManagedConfigKey[] = [
  "BB_APP_URL",
  "BB_INFERENCE",
  "BB_INFERENCE_FALLBACK",
  "BB_LOG_LEVEL",
  "BB_TRANSCRIPTION",
];

export const PORTABLE_ENV_NAME_PATTERN = /^[A-Za-z_][A-Za-z0-9_]*$/u;
const CUSTOM_ACP_AGENT_ID_PATTERN = /^[a-z0-9][a-z0-9-]*$/u;
const CUSTOM_ACP_AGENT_LOGO_PATTERN = /\.(?:svg|png|webp)$/iu;

interface RoomAppManagedConfigWarningLogger {
  warn(fields: Record<string, unknown>, message: string): void;
}

interface ParseRoomAppManagedConfigOptions {
  logger?: RoomAppManagedConfigWarningLogger;
}

const roomAppManagedConfigValuesSchema = z
  .object({
    BB_APP_URL: z.string().optional(),
    BB_INFERENCE: z.string().optional(),
    BB_INFERENCE_FALLBACK: z.string().optional(),
    BB_LOG_LEVEL: z.string().optional(),
    BB_TRANSCRIPTION: z.string().optional(),
  })
  .strict();

const ACP_PROVIDER_ID_PATTERN = /^acp-[a-z0-9][a-z0-9-]*$/u;

const customModelProviderIdSchema = z.union([
  z.enum(BUNDLED_PROVIDER_IDS),
  z.string().regex(ACP_PROVIDER_ID_PATTERN),
]);

export const customProviderModelSchema = z
  .object({
    providerId: customModelProviderIdSchema,
    model: z.string().min(1),
    displayName: z.string().min(1).optional(),
  })
  .strict();

const roomAppManagedEnvNameSchema = z.string().regex(PORTABLE_ENV_NAME_PATTERN);

const roomAppManagedEnvConfigSchema = z.record(
  roomAppManagedEnvNameSchema,
  z.string(),
);

export function formatCustomAcpAgentProviderId(id: string): string {
  return `acp-${id}`;
}

const customAcpAgentModelCliSchema = z
  .object({
    listArgs: z.array(z.string()).default([]),
    selectFlag: z.string().min(1).optional(),
    primaryModels: z.array(z.string()).default([]),
  })
  .strict()
  .transform((modelCli) =>
    modelCli.listArgs.length > 0 ? modelCli : undefined,
  );

const customAcpAgentSchema = z
  .object({
    id: z.string().regex(CUSTOM_ACP_AGENT_ID_PATTERN),
    displayName: z.string().min(1),
    command: z.string().min(1),
    logo: z
      .string()
      .min(1)
      .regex(
        CUSTOM_ACP_AGENT_LOGO_PATTERN,
        "Custom ACP agent logo must be an .svg, .png, or .webp file.",
      )
      .optional(),
    args: z.array(z.string()).default([]),
    env: z.record(roomAppManagedEnvNameSchema, z.string()).default({}),
    cwd: z.string().min(1).optional(),
    modelCli: customAcpAgentModelCliSchema.optional(),
    reasoningCli: acpReasoningCliSchema.optional(),
    nativeReasoning: acpNativeReasoningSchema.optional(),
    nativeSkillRoots: providerNativeSkillRootsSchema.optional(),
    supportsManualCompaction: z.boolean().default(false),
  })
  .strict()
  .superRefine((agent, context) => {
    const providerId = formatCustomAcpAgentProviderId(agent.id);
    if (RESERVED_ACP_PROVIDER_IDS.has(providerId)) {
      context.addIssue({
        code: "custom",
        message: `Custom ACP agent id "${agent.id}" resolves to built-in provider "${providerId}".`,
        path: ["id"],
      });
    }
  })
  .transform(({ modelCli, ...agent }) => {
    return modelCli === undefined ? agent : { ...agent, modelCli };
  });

const roomAppManagedConfigBoundarySchema = z
  .object({
    config: roomAppManagedConfigValuesSchema.optional(),
    customAcpAgents: z.array(z.unknown()).optional(),
    customModels: z.array(z.unknown()).optional(),
    sharedSkillRoots: providerNativeSkillRootsSchema.optional(),
    serverHeaders: z.record(z.string(), z.string()).optional(),
    machineCredential: z.string().min(1).optional(),
    connectMachineId: z.string().min(1).optional(),
    serverUrl: z.string().min(1).optional(),
  })
  .strict();

export const roomAppManagedEnvFileSchema = z
  .object({
    env: roomAppManagedEnvConfigSchema.optional(),
  })
  .strict();

export type RoomAppManagedConfigValues = z.infer<
  typeof roomAppManagedConfigValuesSchema
>;
export type CustomAcpAgent = z.infer<typeof customAcpAgentSchema>;
export type CustomProviderModel = z.infer<typeof customProviderModelSchema>;
export type RoomAppManagedConfig = Omit<
  z.infer<typeof roomAppManagedConfigBoundarySchema>,
  "customAcpAgents" | "customModels"
> & {
  customAcpAgents?: CustomAcpAgent[];
  customModels?: CustomProviderModel[];
};
export type RoomAppManagedEnvConfig = z.infer<typeof roomAppManagedEnvConfigSchema>;
export type RoomAppManagedEnvFile = z.infer<typeof roomAppManagedEnvFileSchema>;

function warnInvalidCustomAcpAgent(
  logger: RoomAppManagedConfigWarningLogger | undefined,
  fields: Record<string, unknown>,
): void {
  logger?.warn(fields, "Ignoring invalid custom ACP agent config entry");
}

function parseCustomAcpAgents(
  entries: readonly unknown[] | undefined,
  options: ParseRoomAppManagedConfigOptions,
): CustomAcpAgent[] | undefined {
  if (entries === undefined) {
    return undefined;
  }

  const agents: CustomAcpAgent[] = [];
  const seenProviderIds = new Set<string>();
  for (const [index, entry] of entries.entries()) {
    const result = customAcpAgentSchema.safeParse(entry);
    if (!result.success) {
      warnInvalidCustomAcpAgent(options.logger, {
        error: result.error.message,
        index,
      });
      continue;
    }

    const providerId = formatCustomAcpAgentProviderId(result.data.id);
    if (seenProviderIds.has(providerId)) {
      warnInvalidCustomAcpAgent(options.logger, {
        error: `Duplicate custom ACP agent provider id "${providerId}".`,
        index,
        providerId,
      });
      continue;
    }

    seenProviderIds.add(providerId);
    agents.push(result.data);
  }

  return agents;
}

function parseCustomModels(
  entries: readonly unknown[] | undefined,
  options: ParseRoomAppManagedConfigOptions,
): CustomProviderModel[] | undefined {
  if (entries === undefined) {
    return undefined;
  }

  const customModels: CustomProviderModel[] = [];
  for (const [index, entry] of entries.entries()) {
    const result = customProviderModelSchema.safeParse(entry);
    if (!result.success) {
      options.logger?.warn(
        { error: result.error.message, index },
        "Ignoring invalid custom model config entry",
      );
      continue;
    }
    customModels.push(result.data);
  }

  return customModels;
}

export function parseRoomAppManagedConfig(
  rawConfig: unknown,
  options: ParseRoomAppManagedConfigOptions = {},
): RoomAppManagedConfig {
  const parsed = roomAppManagedConfigBoundarySchema.parse(rawConfig);
  const customAcpAgents = parseCustomAcpAgents(parsed.customAcpAgents, options);
  const customModels = parseCustomModels(parsed.customModels, options);
  const config: RoomAppManagedConfig = {};
  if (parsed.config !== undefined) {
    config.config = parsed.config;
  }
  if (customAcpAgents !== undefined) {
    config.customAcpAgents = customAcpAgents;
  }
  if (customModels !== undefined) {
    config.customModels = customModels;
  }
  if (parsed.sharedSkillRoots !== undefined) {
    config.sharedSkillRoots = parsed.sharedSkillRoots;
  }
  if (parsed.serverUrl !== undefined) {
    config.serverUrl = parsed.serverUrl;
  }
  if (parsed.serverHeaders !== undefined) {
    config.serverHeaders = parsed.serverHeaders;
  }
  if (parsed.machineCredential !== undefined) {
    config.machineCredential = parsed.machineCredential;
  }
  if (parsed.connectMachineId !== undefined) {
    config.connectMachineId = parsed.connectMachineId;
  }
  return config;
}

export function formatRoomAppConfigPath(dataDir: string): string {
  return join(dataDir, ROOM_APP_CONFIG_FILE_NAME);
}

export async function readRoomAppServerHeaders(
  dataDir: string,
): Promise<Record<string, string> | undefined> {
  let raw: string;
  try {
    raw = await readFile(formatRoomAppConfigPath(dataDir), "utf8");
  } catch (error) {
    if (error instanceof Error && "code" in error && error.code === "ENOENT") {
      return undefined;
    }
    throw error;
  }
  const config = parseRoomAppManagedConfig(JSON.parse(raw));
  return (
    config.serverHeaders ??
    (config.machineCredential === undefined
      ? undefined
      : { "x-bb-connect-machine": config.machineCredential })
  );
}

export function formatRoomAppEnvPath(dataDir: string): string {
  return join(dataDir, ROOM_APP_ENV_FILE_NAME);
}
