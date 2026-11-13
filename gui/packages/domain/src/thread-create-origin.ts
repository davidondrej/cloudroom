import { z } from "zod";

// `setup`: the first agent, which Cloudroom starts by itself when first-run setup ends (ADR 20261111-220912).
export const threadCreateOriginValues = ["app", "cli", "sdk", "plugin", "setup"] as const;
export const threadCreateOriginSchema = z.enum(threadCreateOriginValues);
export type ThreadCreateOrigin = z.infer<typeof threadCreateOriginSchema>;
