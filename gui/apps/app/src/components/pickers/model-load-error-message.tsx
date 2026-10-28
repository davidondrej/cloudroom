import type { SystemExecutionOptionsModelLoadError } from "@cloudroom/server-contract";

interface FormatModelLoadErrorTextArgs {
  error: SystemExecutionOptionsModelLoadError;
  providerLabel: string;
}

export function formatModelLoadErrorText({
  error,
  providerLabel,
}: FormatModelLoadErrorTextArgs): string {
  if (error.code === "provider_unavailable") {
    return `${providerLabel} is unavailable because its provider plugin failed to load.`;
  }

  if (error.code === "timeout") {
    return `Timed out loading models for ${providerLabel}.`;
  }

  if (error.code === "missing_executable") {
    return `Could not load models for ${providerLabel}. Please make sure the ${providerLabel} CLI is installed.`;
  }

  if (error.code === "auth_required") {
    return `Could not load models for ${providerLabel}. Authentication is required.`;
  }

  return `Could not load models for ${providerLabel}.`;
}
