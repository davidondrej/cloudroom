import { z } from "zod";
import { completedTurnDisplaySchema } from "./completed-turn-display.js";
import { isValidGitBranchName } from "./git-checkout.js";

export const MANAGED_BRANCH_PREFIX_MAX_LENGTH = 64;

export const DEFAULT_MANAGED_BRANCH_PREFIX = "room/";

export const managedBranchPrefixSchema = z
  .string()
  .max(MANAGED_BRANCH_PREFIX_MAX_LENGTH)
  .refine((prefix) => isValidGitBranchName(`${prefix}slug-thr_id`), {
    message: "Prefix must start a valid git branch name",
  });

export const appSettingsSchema = z
  .object({
    showKeyboardHints: z.boolean(),
    steerActiveThreadOnEnter: z.boolean(),
    showDiagnosticEvents: z.boolean(),
    providerOrder: z.array(z.string().min(1)),
    defaultProviderId: z.string().min(1).nullable(),
    providerCompletedTurnDisplay: z.record(
      z.string().min(1),
      completedTurnDisplaySchema,
    ),
    streamerMode: z.boolean(),
    telemetryEnabled: z.boolean(),
    commandGuardEnabled: z.boolean().default(true),
    systemPromptEnabled: z.boolean().default(true),
    bugReportsEnabled: z.boolean().default(true),
    agentQuestionsEnabled: z.boolean().default(true),
    stripAiCoAuthorsEnabled: z.boolean().default(true),
    providerAutoUpdate: z.array(z.string().min(1)).default([]),
    hiddenProviderIds: z.array(z.string().min(1)).default([]),
    managedBranchPrefix: managedBranchPrefixSchema,
    machineServerUrl: z
      .string()
      .url()
      .refine((value) => {
        const url = new URL(value);
        return (
          ["http:", "https:"].includes(url.protocol) &&
          !url.username &&
          !url.password
        );
      })
      .nullable(),
    machineGitCredentialsEnabled: z.boolean(),
    defaultMachineAccess: z.string().min(1).nullable(),
  })
  .strict();
export type AppSettings = z.infer<typeof appSettingsSchema>;

export const defaultAppSettings: AppSettings = {
  showKeyboardHints: true,
  steerActiveThreadOnEnter: false,
  showDiagnosticEvents: false,
  providerOrder: [],
  defaultProviderId: null,
  providerCompletedTurnDisplay: {},
  streamerMode: false,
  telemetryEnabled: true,
  commandGuardEnabled: true,
  systemPromptEnabled: true,
  bugReportsEnabled: true,
  agentQuestionsEnabled: true,
  stripAiCoAuthorsEnabled: true,
  providerAutoUpdate: [],
  hiddenProviderIds: [],
  managedBranchPrefix: DEFAULT_MANAGED_BRANCH_PREFIX,
  machineServerUrl: null,
  defaultMachineAccess: null,
  machineGitCredentialsEnabled: true,
};

export const appSettingsUpdateSchema = z.union([
  appSettingsSchema.extend({
    commandGuardEnabled: z.boolean().optional(),
    systemPromptEnabled: z.boolean().optional(),
    bugReportsEnabled: z.boolean().optional(),
    agentQuestionsEnabled: z.boolean().optional(),
    stripAiCoAuthorsEnabled: z.boolean().optional(),
    providerAutoUpdate: z.array(z.string().min(1)).optional(),
    hiddenProviderIds: z.array(z.string().min(1)).optional(),
    telemetryEnabled: z.boolean().optional(),
    showUnhandledProviderEvents: z.boolean().optional(),
  }),
  appSettingsSchema.omit({ showDiagnosticEvents: true }).extend({
    commandGuardEnabled: z.boolean().optional(),
    systemPromptEnabled: z.boolean().optional(),
    bugReportsEnabled: z.boolean().optional(),
    agentQuestionsEnabled: z.boolean().optional(),
    stripAiCoAuthorsEnabled: z.boolean().optional(),
    providerAutoUpdate: z.array(z.string().min(1)).optional(),
    hiddenProviderIds: z.array(z.string().min(1)).optional(),
    telemetryEnabled: z.boolean().optional(),
    showUnhandledProviderEvents: z.boolean(),
  }),
]);
export type AppSettingsUpdate = z.infer<typeof appSettingsUpdateSchema>;
