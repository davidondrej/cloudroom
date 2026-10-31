import { Fragment, useEffect, useState } from "react";
import {
  definePluginApp,
  experimental_ProviderIcon as ProviderIcon,
  useRpc,
} from "@get-bb/plugin-sdk/app";
import { Icon } from "@cloudroom/shared-ui/icon";
import { Switch } from "@cloudroom/shared-ui/switch";
import type { loopFallbackRpcContract } from "./server.js";

const MATCHING_MODELS = [
  ["Fable 5.1", "GPT-6 Astra"],
  ["Opus 5.5", "GPT-6.1 Sol"],
  ["Sonnet 5.5", "GPT-6.1 Terra"],
  ["Haiku 5.5", "GPT-6 Luna"],
] as const;

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function ModelName({ providerId, name }: { providerId: string; name: string }) {
  return (
    <span className="flex min-w-0 items-center gap-2 text-sm text-foreground">
      <ProviderIcon
        providerKind="agent"
        provider={{ id: providerId }}
        fallback="Bot"
        className="size-3.5 shrink-0"
        aria-hidden
      />
      <span className="truncate">{name}</span>
    </span>
  );
}

function LoopFallbackSettings() {
  const rpc = useRpc<typeof loopFallbackRpcContract>();
  const [fallback, setFallback] = useState<boolean | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let active = true;
    rpc.call("loopFallback", {}).then(
      (saved) => {
        if (active) setFallback(saved.fallback);
      },
      (loadError: unknown) => {
        if (active) setError(errorMessage(loadError));
      },
    );
    return () => {
      active = false;
    };
  }, [rpc]);

  function change(next: boolean): void {
    const previous = fallback;
    setFallback(next);
    setError(null);
    rpc.call("loopFallback", { fallback: next }).then(
      (saved) => setFallback(saved.fallback),
      (saveError: unknown) => {
        setFallback(previous);
        setError(errorMessage(saveError));
      },
    );
  }

  return (
    <div className="w-full overflow-hidden rounded-md border border-border/60">
      <div className="flex items-start justify-between gap-6 px-4 py-3">
        <div className="min-w-0">
          <h3 className="text-sm font-medium text-foreground">
            Switch provider at a limit
          </h3>
          <p className="mt-1 text-xs leading-relaxed text-muted-foreground">
            A loop that hits a subscription limit runs on the other provider
            right away, instead of failing or waiting for the reset.
          </p>
          {error === null ? null : (
            <p className="mt-1 text-xs text-destructive" role="alert">
              {error}
            </p>
          )}
        </div>
        <Switch
          checked={fallback ?? true}
          disabled={fallback === null}
          size="default"
          aria-label="Switch provider at a limit"
          onCheckedChange={change}
        />
      </div>
      <div className="border-t border-border/60 px-4 py-3">
        <h3 className="text-sm font-medium text-foreground">Matching models</h3>
        <p className="mt-1 text-xs leading-relaxed text-muted-foreground">
          Each loop gets the model of the same level, both ways.
        </p>
        <div className="mt-3 grid grid-cols-[1fr_auto_1fr] items-center gap-x-4 gap-y-2">
          {MATCHING_MODELS.map(([claude, codex]) => (
            <Fragment key={claude}>
              <ModelName providerId="claude-code" name={claude} />
              <Icon
                name="DataTransfer"
                className="size-3.5 text-muted-foreground"
                aria-hidden
              />
              <ModelName providerId="codex" name={codex} />
            </Fragment>
          ))}
        </div>
        <p className="mt-3 text-xs text-muted-foreground">
          Switching between your own accounts of one provider stays manual.
        </p>
      </div>
    </div>
  );
}

export default definePluginApp((app) => {
  app.slots.settingsSection({
    id: "loops",
    title: "Loops",
    component: LoopFallbackSettings,
  });
});
