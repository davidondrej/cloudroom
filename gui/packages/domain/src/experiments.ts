import { z } from "zod";

export const experimentKeys = [
  "changelogPreview",
  "hideLaptopHints",
  "mobileApp",
  "multiMachinePicker",
  "sidebarProgressiveDisclosure",
  "timelineWindowing",
] as const;
export const experimentKeySchema = z.enum(experimentKeys);
export type ExperimentKey = z.infer<typeof experimentKeySchema>;
export type Experiments = Record<ExperimentKey, boolean>;

export const defaultExperiments: Experiments = {
  changelogPreview: false,
  hideLaptopHints: false,
  mobileApp: false,
  multiMachinePicker: false,
  sidebarProgressiveDisclosure: false,
  timelineWindowing: false,
};

export const experimentChangesSchema = z
  .record(z.string(), z.boolean())
  .transform((value): Partial<Experiments> => Object.fromEntries(experimentKeys.filter((key) => key in value).map((key) => [key, value[key]])));
export const experimentsSchema = experimentChangesSchema.transform((value): Experiments => ({ ...defaultExperiments, ...value }));
