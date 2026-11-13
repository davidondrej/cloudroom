import { rejectMultipleWorkspaceSelectors } from "./shared.js";
import { z } from "zod";
import {
  appSettingsSchema,
  appDefaultKeybindingsSchema,
  appKeybindingOverridesSchema,
  appKeybindingsSchema,
  appThemeSchema,
  availableModelSchema,
  experimentsSchema,
  featureFlagsSchema,
  jsonValueSchema,
  permissionModeSchema,
  pluginThemeMetaSchema,
  providerInfoSchema,
} from "@cloudroom/domain";
import { providerHealthSchema as providerHealthSchema } from "@cloudroom/provider-bridge-protocol/provider-maintenance";
import { hostPlatformSchema } from "@cloudroom/host-daemon-contract/local";
import { machineEnvironmentSetSchema } from "./machine-environment.js";

const machineEnvironmentReplacementVariableSchema =
  machineEnvironmentSetSchema.extend({
    value: machineEnvironmentSetSchema.shape.value.nullable(),
  });

export const machineEnvironmentReplaceSchema = z
  .object({
    variables: z.array(machineEnvironmentReplacementVariableSchema),
  })
  .strict()
  .superRefine(({ variables }, context) => {
    const names = new Set<string>();
    for (const [index, variable] of variables.entries()) {
      if (names.has(variable.name)) {
        context.addIssue({
          code: "custom",
          path: ["variables", index, "name"],
          message: "Machine environment variable names must be unique",
        });
      }
      names.add(variable.name);
    }
  });
export type MachineEnvironmentReplace = z.infer<
  typeof machineEnvironmentReplaceSchema
>;

export const systemExecutionOptionsModelLoadErrorCodeSchema = z.enum([
  "provider_unavailable",
  "missing_executable",
  "auth_required",
  "timeout",
  "failed",
]);
export type SystemExecutionOptionsModelLoadErrorCode = z.infer<
  typeof systemExecutionOptionsModelLoadErrorCodeSchema
>;

export const systemExecutionOptionsModelLoadErrorSchema = z.object({
  providerId: z.string().min(1),
  code: systemExecutionOptionsModelLoadErrorCodeSchema,
  canRestart: z.boolean().optional(),
});
export type SystemExecutionOptionsModelLoadError = z.infer<
  typeof systemExecutionOptionsModelLoadErrorSchema
>;

export const systemExecutionOptionsResponseSchema = z.object({
  providers: z.array(providerInfoSchema),
  permissionCeiling: permissionModeSchema,
  models: z.array(availableModelSchema),
  selectedOnlyModels: z.array(availableModelSchema),
  modelLoadError: systemExecutionOptionsModelLoadErrorSchema.nullable(),
});
export type SystemExecutionOptionsResponse = z.infer<
  typeof systemExecutionOptionsResponseSchema
>;

const systemProviderHostQueryFields = {
  hostId: z.string().min(1),
  environmentId: z.string().min(1),
} as const;

export const systemProvidersQuerySchema = z
  .object({
    ...systemProviderHostQueryFields,
    capability: z.enum(["usage"]),
  })
  .partial()
  .superRefine(rejectMultipleWorkspaceSelectors);
export type SystemProvidersQuery = z.infer<typeof systemProvidersQuerySchema>;

// `providerId` checks just that provider, never waiting on the others.
export const systemProviderStatesQuerySchema = z
  .object({
    ...systemProviderHostQueryFields,
    providerId: z.string().min(1),
  })
  .partial()
  .superRefine(rejectMultipleWorkspaceSelectors);
export type SystemProviderStatesQuery = z.infer<
  typeof systemProviderStatesQuerySchema
>;

export const systemInstallableProvidersQuerySchema = z
  .object(systemProviderHostQueryFields)
  .partial()
  .superRefine(rejectMultipleWorkspaceSelectors);
export type SystemInstallableProvidersQuery = z.infer<
  typeof systemInstallableProvidersQuerySchema
>;

export const systemExecutionOptionsQuerySchema = z
  .object({
    ...systemProviderHostQueryFields,
    providerId: z.string().min(1),
  })
  .partial()
  .superRefine(rejectMultipleWorkspaceSelectors);
export type SystemExecutionOptionsQuery = z.infer<
  typeof systemExecutionOptionsQuerySchema
>;

export const systemRestartModelDiscoveryRequestSchema = z
  .object({
    hostId: z.string().min(1).optional(),
    environmentId: z.string().min(1).optional(),
    providerId: z.string().min(1),
  })
  .strict()
  .superRefine(rejectMultipleWorkspaceSelectors);
export type SystemRestartModelDiscoveryRequest = z.infer<
  typeof systemRestartModelDiscoveryRequestSchema
>;

export const systemUsageLimitsQuerySchema = z.object({
  hostId: z.string().min(1).optional(),
  providerId: z.string().min(1).optional(),
});
export type SystemUsageLimitsQuery = z.infer<
  typeof systemUsageLimitsQuerySchema
>;

export interface SystemVoiceTranscriptionForm {
  [key: string]: string | Blob;
}

export { providerInfoSchema as systemProviderInfoSchema } from "@cloudroom/domain";
export type { ProviderInfo as SystemProviderInfo } from "@cloudroom/domain";

export const systemVoiceTranscriptionResponseSchema = z.object({
  text: z.string(),
});
export type SystemVoiceTranscriptionResponse = z.infer<
  typeof systemVoiceTranscriptionResponseSchema
>;

export const systemProviderStateSchema = providerHealthSchema.extend({
  providerId: z.string().min(1),
  displayName: z.string().min(1),
});
export type SystemProviderState = z.infer<typeof systemProviderStateSchema>;

export const systemProviderStatesResponseSchema = z.object({
  providers: z.array(systemProviderStateSchema),
});
export type SystemProviderStatesResponse = z.infer<
  typeof systemProviderStatesResponseSchema
>;

export const systemAiServiceSchema = z.object({
  id: z.string().min(1),
  displayName: z.string().min(1),
  kinds: z.array(z.enum(["inference", "voice"])),
  pluginId: z.string().min(1),
});

export const systemAiServicesSchema = z.object({
  inference: z.string().min(1),
  inferenceFallback: z.string().min(1),
  transcription: z.string().min(1),
  services: z.array(systemAiServiceSchema),
});

export const serverAccessStatusSchema = z.object({
  providers: z.array(
    z.object({
      id: z.string(),
      displayName: z.string(),
      description: z.string(),
      pluginId: z.string().min(1).nullable(),
      availability: z
        .discriminatedUnion("status", [
          z.object({
            status: z.literal("available"),
            serverUrl: z.string().url().optional(),
          }),
          z.object({
            status: z.literal("setup-required"),
            message: z.string(),
          }),
          z.object({ status: z.literal("unavailable"), message: z.string() }),
        ])
        .nullable(),
    }),
  ),
  defaultProviderId: z.string(),
  effectiveUrl: z.string().nullable(),
  urlSource: z.enum(["setting", "BB_EXTERNAL_URL"]).nullable(),
});
export type ServerAccessStatus = z.infer<typeof serverAccessStatusSchema>;

export const systemConfigResponseSchema = z.object({
  serverAccess: serverAccessStatusSchema,
  generalSettings: appSettingsSchema.extend({
    showUnhandledProviderEvents: z.boolean().optional(),
  }),
  keybindings: appKeybindingsSchema,
  defaultKeybindings: appDefaultKeybindingsSchema,
  keybindingOverrides: appKeybindingOverridesSchema,
  experiments: experimentsSchema,
  appearance: appThemeSchema,
  customThemes: z.array(z.string()),
  pluginThemes: z.array(pluginThemeMetaSchema),
  featureFlags: featureFlagsSchema,
  hostDaemonPort: z.number().nullable(),
  localHelperPorts: z.array(z.number().int().min(1).max(65_535)),
  serverUrl: z.string().url(),
  primaryHostId: z.string().nullable(),
  primaryHostPlatform: hostPlatformSchema.nullable(),
  voiceTranscriptionEnabled: z.boolean(),
  aiServices: systemAiServicesSchema,
  dataDir: z.string(),
});
export type SystemConfigResponse = z.infer<typeof systemConfigResponseSchema>;

export const systemAttentionResponseSchema = z.object({
  hasAttention: z.boolean(),
});
export type SystemAttentionResponse = z.infer<
  typeof systemAttentionResponseSchema
>;

export const themeCatalogResponseSchema = z.object({
  dir: z.string(),
  custom: z.array(z.string()),
  plugins: z.array(pluginThemeMetaSchema),
  active: appThemeSchema,
});
export type ThemeCatalogResponse = z.infer<typeof themeCatalogResponseSchema>;

export const systemVersionResponseSchema = z.object({
  currentVersion: z.string(),
  latestVersion: z.string().nullable(),
  source: z.literal("npm"),
  updateAvailable: z.boolean(),
  isDevelopment: z.boolean(),
  upgradeCommand: z.string(),
  desktopVersion: z.string().optional(),
});
export type SystemVersionResponse = z.infer<typeof systemVersionResponseSchema>;

export const systemVersionQuerySchema = z.object({
  force: z.enum(["true", "false"]).optional(),
});
export type SystemVersionQuery = z.infer<typeof systemVersionQuerySchema>;

export const systemConfigReloadResponseSchema = z.object({
  ok: z.literal(true),
});

export const cliSkillMachineStatusSchema = z.enum([
  "installed",
  "outdated",
  "missing",
  "unknown",
]);
export type CliSkillMachineStatus = z.infer<typeof cliSkillMachineStatusSchema>;

export const systemCliSkillsStatusQuerySchema = z.object({
  hostIds: z.string().optional(),
});
export type SystemCliSkillsStatusQuery = z.infer<
  typeof systemCliSkillsStatusQuerySchema
>;

export const systemCliSkillsStatusResponseSchema = z.object({
  machines: z.array(
    z.object({
      hostId: z.string(),
      hostName: z.string(),
      status: cliSkillMachineStatusSchema,
    }),
  ),
});
export type SystemCliSkillsStatusResponse = z.infer<
  typeof systemCliSkillsStatusResponseSchema
>;

export const systemInstallCliSkillsRequestSchema = z.object({
  hostIds: z.array(z.string().min(1)).min(1).max(64),
});
export type SystemInstallCliSkillsRequest = z.infer<
  typeof systemInstallCliSkillsRequestSchema
>;

export const systemInstallCliSkillsResponseSchema = z.object({
  results: z.array(
    z.discriminatedUnion("ok", [
      z.object({
        ok: z.literal(true),
        hostId: z.string(),
        hostName: z.string(),
        installations: z.array(
          z.object({
            name: z.string(),
            path: z.string(),
          }),
        ),
      }),
      z.object({
        ok: z.literal(false),
        hostId: z.string(),
        hostName: z.string(),
        errorMessage: z.string(),
      }),
    ]),
  ),
});
export type SystemInstallCliSkillsResponse = z.infer<
  typeof systemInstallCliSkillsResponseSchema
>;

export const SKILL_USAGE_RANGES = ["30", "90", "365"] as const;
export const systemSkillUsageQuerySchema = z.object({
  days: z.enum(SKILL_USAGE_RANGES).optional(),
  utcOffsetMinutes: z.string().regex(/^-?\d{1,4}$/).optional(),
});
export type SystemSkillUsageQuery = z.infer<typeof systemSkillUsageQuerySchema>;

/** Daily skill runs, oldest day first, most used skill first. */
export interface SystemSkillUsageResponse {
  startDate: string;
  days: number;
  skills: { name: string; total: number; daily: number[] }[];
}

export const USAGE_ANALYTICS_METRICS = ["agentHours", "models", "tokens", "prompts"] as const;
export const USAGE_ANALYTICS_RANGES = ["7", "30", "90", "365"] as const;
export const systemUsageAnalyticsQuerySchema = z.object({
  metric: z.enum(USAGE_ANALYTICS_METRICS),
  days: z.enum(USAGE_ANALYTICS_RANGES).optional(),
  utcOffsetMinutes: z.string().regex(/^-?\d{1,4}$/).optional(),
});
export type SystemUsageAnalyticsQuery = z.infer<typeof systemUsageAnalyticsQuerySchema>;

const dailySchema = z.array(z.number());
/**
 * Settings → Analytics. Only the asked metric is filled. Daily lists run
 * oldest day first, one entry per day from `startDate`.
 */
export const systemUsageAnalyticsResponseSchema = z.object({
  startDate: z.string(),
  days: z.number(),
  /** Hours per day: agents working, split Local and Cloud, and you in the app. */
  agentHours: z.object({ local: dailySchema, cloud: dailySchema, you: dailySchema }).optional(),
  /** Prompts per model, most used first with the rest as "Other", and how many ran Local and Cloud. */
  models: z.object({
    local: z.number(),
    cloud: z.number(),
    list: z.array(z.object({ name: z.string(), total: z.number(), daily: dailySchema })),
  }).optional(),
  /**
   * Tokens by kind. The three daily lists start one range early (`days` × 2 entries), so this range can be
   * compared with the one before. `models` and `top` cover this range only: models that used the most first with
   * the rest as "Other", and each day's heaviest threads.
   */
  tokens: z.object({
    written: dailySchema,
    read: dailySchema,
    cached: dailySchema,
    models: z.array(z.object({ name: z.string(), written: dailySchema, read: dailySchema, cached: dailySchema })),
    top: z.array(z.array(z.object({ name: z.string(), written: z.number(), read: z.number(), cached: z.number() }))),
  }).optional(),
  /** Your prompts per day, and per hour of the week (Monday 12 AM first, 168 entries). */
  prompts: z.object({ daily: dailySchema, hours: dailySchema }).optional(),
});
export type SystemUsageAnalyticsResponse = z.infer<typeof systemUsageAnalyticsResponseSchema>;

export interface SystemWorktreeStorageResponse {
  freeBytes: number | null;
  usedBytes: number | null;
  low: boolean;
}

export type SystemConfigReloadResponse = z.infer<
  typeof systemConfigReloadResponseSchema
>;

const systemEnvironmentProviderAvailabilitySchema = z.discriminatedUnion(
  "status",
  [
    z.object({ status: z.literal("available") }),
    z.object({
      status: z.literal("setup-required"),
      message: z.string().min(1),
    }),
    z.object({
      status: z.literal("unavailable"),
      message: z.string().min(1),
    }),
  ],
);

export const systemEnvironmentProviderSchema = z.object({
  environmentProviderId: z.string().min(1).optional(),
  machineProviderId: z.string().min(1).nullable(),
  id: z.string().min(1),
  displayName: z.string().min(1),
  description: z.string().min(1).nullable(),
  icon: z.string().min(1).nullable(),
  logoUrl: z.string().min(1).nullable(),
  pluginId: z.string().min(1),
  requires: z.object({
    projectCheckout: z.boolean(),
    gitCheckout: z.boolean(),
    gitRemote: z.boolean(),
    projectless: z.boolean(),
  }),
  inputs: jsonValueSchema.nullable(),
  acceptsEmptyInputs: z.boolean(),
  availability: systemEnvironmentProviderAvailabilitySchema.nullable(),
  machineAvailability: z.record(
    z.string().min(1),
    systemEnvironmentProviderAvailabilitySchema.nullable(),
  ),
  machineInputs: jsonValueSchema.nullable().optional(),
  machineAcceptsEmptyInputs: z.boolean().optional(),
  machineProviderPluginId: z.string().min(1).optional(),
});
export type SystemEnvironmentProvider = z.infer<
  typeof systemEnvironmentProviderSchema
>;

export const systemEnvironmentProvidersResponseSchema = z.object({
  providers: z.array(systemEnvironmentProviderSchema),
});
export type SystemEnvironmentProvidersResponse = z.infer<
  typeof systemEnvironmentProvidersResponseSchema
>;

export const systemEnvironmentProvidersQuerySchema = z
  .object({
    projectId: z.string().min(1).optional(),
    hostId: z.string().min(1).optional(),
  })
  .superRefine((query, context) => {
    if (query.hostId !== undefined && query.projectId === undefined) {
      context.addIssue({
        code: "custom",
        path: ["hostId"],
        message: "hostId requires projectId",
      });
    }
  });
export type SystemEnvironmentProvidersQuery = z.infer<
  typeof systemEnvironmentProvidersQuerySchema
>;

export const systemMachineProviderSchema = z.object({
  id: z.string().min(1),
  displayName: z.string().min(1),
  description: z.string().min(1),
  icon: z.string().min(1),
  logoUrl: z.string().min(1).nullable(),
  pluginId: z.string().min(1),
  inputs: jsonValueSchema.nullable(),
  acceptsEmptyInputs: z.boolean(),
  supportsSuspend: z.boolean(),
});
export type SystemMachineProvider = z.infer<typeof systemMachineProviderSchema>;

export const systemMachineProvidersResponseSchema = z.object({
  providers: z.array(systemMachineProviderSchema),
});
export type SystemMachineProvidersResponse = z.infer<
  typeof systemMachineProvidersResponseSchema
>;
