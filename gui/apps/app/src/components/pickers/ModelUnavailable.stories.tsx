import { useMemo } from "react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import type { ProviderCliStatus } from "@cloudroom/host-daemon-contract";
import { makeSystemConfig } from "../../test/fixtures/system-config";
import {
  hostProviderCliStatusQueryKey,
  systemConfigQueryKey,
} from "../../hooks/queries/query-keys";
import { StoryCard, StoryRow } from "../../../.ladle/story-card";
import { ModelUnavailable } from "./ModelUnavailable";

export default {
  title: "pickers/Model Unavailable",
};

const HOST_ID = "host_story_mac";

function codexStatus(executablePath: string | null): ProviderCliStatus {
  return {
    displayName: "Codex",
    executableName: "codex",
    executablePath,
    installed: false,
    installSource: "notInstalled",
    currentVersion: null,
    latestVersion: "0.167.0",
    minimumSupportedVersion: "0.136.0",
    npmPackageName: "@openai/codex",
    npmGlobalPackageVersion: null,
    installAction: {
      kind: "install",
      label: "Install",
      command: "npm install -g @openai/codex@latest",
    },
    needsUpdate: false,
    versionUnsupported: false,
  };
}

function MissingCodex({ executablePath }: { executablePath: string | null }) {
  const client = useMemo(() => {
    const queryClient = new QueryClient({
      defaultOptions: { queries: { staleTime: Infinity, retry: false } },
    });
    queryClient.setQueryData(
      systemConfigQueryKey(),
      makeSystemConfig({ primaryHostId: HOST_ID }),
    );
    queryClient.setQueryData(hostProviderCliStatusQueryKey(HOST_ID), {
      codex: codexStatus(executablePath),
    });
    return queryClient;
  }, [executablePath]);
  return (
    <QueryClientProvider client={client}>
      <div className="w-80 rounded-md border border-border bg-popover">
        <ModelUnavailable
          providerId="codex"
          providerLabel="Codex"
          routing={{ hostId: HOST_ID }}
          error={{ providerId: "codex", code: "missing_executable" }}
          failed
          installUrl="https://developers.openai.com/codex/cli"
        />
      </div>
    </QueryClientProvider>
  );
}

export function Overview() {
  return (
    <StoryCard>
      <StoryRow label="broken install">
        <MissingCodex executablePath="/Users/me/.local/bin/codex" />
      </StoryRow>
      <StoryRow label="not installed">
        <MissingCodex executablePath={null} />
      </StoryRow>
    </StoryCard>
  );
}
