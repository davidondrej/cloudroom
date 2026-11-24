import { useQuery, useQueryClient } from "@tanstack/react-query";
import { reasoningLevelSchema, type AvailableModel } from "@cloudroom/domain";
import { z } from "zod";
import { useCloudroomAccount } from "@/hooks/queries/cloudroom-queries";
import { fetchWithAppSurface } from "@/lib/app-surface";

const responseSchema = z.object({
  restart: z.boolean().optional(),
  refreshDue: z.boolean().optional(),
  connected: z.boolean().optional(),
  catalog: z.string().nullable().optional(),
  url: z.string().url().optional(),
  ticket: z.string().optional(),
  cancelled: z.boolean().optional(),
});
export async function antigravityLogin(
  input: Record<string, unknown>,
  signal?: AbortSignal,
) {
  const response = await fetchWithAppSurface(
    "/api/v1/cloudroom/account/antigravity",
    {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(input),
      signal,
    },
  );
  const data = await response.json();
  if (!response.ok)
    throw new Error(
      data.message ?? data.error ?? "Could not connect Antigravity.",
    );
  return responseSchema.parse(data);
}
export const agyLoginQueryKey = (account?: string) =>
  ["cloudroom-antigravity-login", account] as const;
export function useAntigravityCloud(enabled: boolean) {
  const account = useCloudroomAccount(enabled);
  const client = useQueryClient();
  const queryKey = agyLoginQueryKey(account.data?.account?.id);
  return useQuery({
    queryKey,
    enabled: enabled && !!account.data?.account,
    retry: false,
    staleTime: 60000,
    queryFn: async ({ signal }) => {
      const saved = await antigravityLogin({ action: "status" }, signal);
      if (!saved.refreshDue) return saved;
      client.setQueryData(queryKey, saved);
      return antigravityLogin({ action: "refresh" }, signal).catch(() => saved);
    },
  });
}

/** The login sandbox reads these choices from agy's ACP session, including the default after each model switch. */
export function antigravityCloudModels(catalog: string): AvailableModel[] {
  return catalog.split("\n").flatMap((line, index) => {
    const [model, displayName, levels, selected] = line.split("\t");
    const parsed = reasoningLevelSchema.safeParse(selected);
    if (!model || !displayName || !levels || !parsed.success) return [];
    return [
      {
        id: model,
        model,
        displayName,
        description: "",
        isDefault: index === 0,
        defaultReasoningEffort: levels.split(",").includes("high") ? "high" : parsed.data,
        supportedReasoningEfforts: levels.split(",").flatMap((level) => {
          const effort = reasoningLevelSchema.safeParse(level);
          return effort.success
            ? [{ reasoningEffort: effort.data, description: "" }]
            : [];
        }),
      },
    ];
  });
}
