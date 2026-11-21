import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useCloudroomAccount } from "@/hooks/queries/cloudroom-queries";
import { sdk } from "@/lib/sdk";
import { openUrlInExternalBrowser } from "@/lib/url-open-routing";

export function useGitlabConnection(enabled = true) {
  const account = useCloudroomAccount().data;
  const key = ["cloudroom-gitlab", account?.account?.id];
  const client = useQueryClient();
  const status = useQuery({
    queryKey: key,
    enabled: enabled && Boolean(account?.account) && account?.ready === true,
    queryFn: ({ signal }) => sdk.cloudroom.gitlabConnection("status", signal),
    staleTime: 30_000,
    retry: false,
    refetchOnWindowFocus: "always",
    refetchInterval: (query) => (query.state.status !== "error" && query.state.data?.waiting ? 4_000 : false),
  });
  const change = useMutation({
    mutationFn: (action: "start" | "cancel" | "disconnect") =>
      sdk.cloudroom.gitlabConnection(action),
    onSuccess: (state, action) => {
      client.setQueryData(key, state);
      if (action === "start" && state.url) openUrlInExternalBrowser(state.url);
    },
    onError: () => {
      void client.invalidateQueries({ queryKey: key });
    },
  });
  return {
    accountId: account?.account?.id,
    ready: Boolean(account?.account && account.ready),
    state: status.data,
    busy: change.isPending,
    change: change.mutate,
    error: change.error?.message,
    open: () => {
      if (status.data?.url) openUrlInExternalBrowser(status.data.url);
    },
  };
}
