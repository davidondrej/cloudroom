import { Command } from "commander";
import type { AvailableModel } from "@cloudroom/domain";
import type { SystemProviderInfo } from "@cloudroom/server-contract";
import { action } from "../action.js";
import { createCliBbSdk } from "../client.js";
import { columnWidths, printBorderlessTable } from "../table.js";
import { outputJson } from "./helpers.js";
import { resolveMachineEnvironmentRouting } from "./machine.js";

interface ProviderListCommandOptions {
  environment?: string;
  host?: string;
  installable?: boolean;
  json?: boolean;
  machine?: string;
}

interface ProviderModelsCommandOptions {
  environment?: string;
  host?: string;
  json?: boolean;
  machine?: string;
  selectedModel?: string;
  restart?: boolean;
}

interface IncludeSelectedOnlyModelArgs {
  models: AvailableModel[];
  selectedOnlyModels: AvailableModel[];
  selectedModel?: string;
}

function addProviderRoutingOptions(command: Command): Command {
  return command
    .option("--machine <id-or-name>", "Machine whose providers should be used")
    .option("--host <id-or-name>", "Alias for --machine")
    .option(
      "--environment <id>",
      "Environment whose machine providers should be used",
    );
}

export function registerProviderCommands(
  program: Command,
  getUrl: () => string,
): void {
  const provider = program
    .command("provider")
    .description("Inspect available providers and models");

  addProviderRoutingOptions(provider.command("list"))
    .description("List available providers")
    .option(
      "--installable",
      "List providers that can be installed on the machine instead",
    )
    .option("--json", "Print machine-readable JSON output")
    .action(
      action(async (opts: ProviderListCommandOptions) => {
        const serverUrl = getUrl();
        const sdk = createCliBbSdk(serverUrl);
        const routing = await resolveMachineEnvironmentRouting(opts, serverUrl);
        const providers = opts.installable
          ? await sdk.providers.installable(routing)
          : await sdk.providers.list(routing);
        if (outputJson(opts, providers)) return;
        if (providers.length === 0) {
          console.log(
            opts.installable
              ? "No providers to install"
              : "No providers available",
          );
          return;
        }
        printProviderTable(providers);
      }),
    );

  addProviderRoutingOptions(provider.command("models [providerId]"))
    .description("List available models for a provider")
    .option("--json", "Print machine-readable JSON output")
    .option(
      "--restart",
      "Restart this provider's model discovery without stopping threads",
    )
    .option(
      "--selected-model <model>",
      "Include a selected-only model if it matches",
    )
    .action(
      action(
        async (
          providerId: string | undefined,
          opts: ProviderModelsCommandOptions,
        ) => {
          const serverUrl = getUrl();
          const sdk = createCliBbSdk(serverUrl);
          if (opts.restart && !providerId)
            throw new Error("--restart requires a provider ID");
          const routing = await resolveMachineEnvironmentRouting(
            opts,
            serverUrl,
          );
          const executionOptions =
            opts.restart && providerId
              ? await sdk.providers.restartModelDiscovery({
                  ...routing,
                  providerId,
                })
              : await sdk.providers.models({
                  ...routing,
                  ...(providerId ? { providerId } : {}),
                });
          // The server falls back to the first provider for an unknown ID,
          // which printed Codex's models for a typo (feedback #479).
          if (
            providerId &&
            executionOptions.providers.length > 0 &&
            !executionOptions.providers.some((entry) => entry.id === providerId)
          ) {
            throw new Error(
              `Unknown provider "${providerId}". Use one of: ${executionOptions.providers.map((entry) => entry.id).join(", ")}.`,
            );
          }
          if (opts.restart && executionOptions.modelLoadError) {
            throw new Error(
              `Model discovery still failed for ${providerId}: ${executionOptions.modelLoadError.code}`,
            );
          }
          const models = includeSelectedOnlyModel({
            models: executionOptions.models,
            selectedOnlyModels: executionOptions.selectedOnlyModels,
            selectedModel: opts.selectedModel,
          });
          if (outputJson(opts, models)) return;
          if (models.length === 0) {
            console.log("No models available");
            return;
          }
          printModelTable(models, providerId);
        },
      ),
    );
}

function includeSelectedOnlyModel(
  args: IncludeSelectedOnlyModelArgs,
): AvailableModel[] {
  if (!args.selectedModel) {
    return args.models;
  }
  if (args.models.some((model) => model.model === args.selectedModel)) {
    return args.models;
  }
  const selectedOnlyModel = args.selectedOnlyModels.find(
    (model) => model.model === args.selectedModel,
  );
  return selectedOnlyModel ? [selectedOnlyModel, ...args.models] : args.models;
}

function printProviderTable(providers: SystemProviderInfo[]): void {
  const rows = providers.map((provider) => [provider.id, provider.displayName]);
  printBorderlessTable(
    {
      head: ["ID", "Name"],
      colWidths: columnWidths(rows, [4, 4]),
    },
    rows,
  );
}

function printModelTable(models: AvailableModel[], providerId?: string): void {
  if (providerId) {
    console.log(`Models for ${providerId}:`);
  }

  const rows = models.map((model) => [
    model.model,
    model.displayName ?? model.model,
    model.isDefault ? "*" : "",
  ]);
  printBorderlessTable(
    {
      head: ["Model", "Name", "Default"],
      colWidths: columnWidths(rows, [5, 4, 7]),
      trimTrailingWhitespace: true,
    },
    rows,
  );
}
