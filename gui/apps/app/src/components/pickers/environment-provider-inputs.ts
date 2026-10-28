import type { SystemEnvironmentProvider } from "@cloudroom/server-contract";

export function providerInputsControlRequired(
  provider: SystemEnvironmentProvider,
): boolean {
  return provider.inputs !== null && !provider.acceptsEmptyInputs;
}
