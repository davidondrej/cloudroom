// An agent or room-cli asked to install or update a plugin, or to install a
// skill from skills.sh. Only a click here runs it (ADR 0260): the server holds
// the request until a person answers, and it says what the request would do.
// This only prints that.
import { useEffect, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Button } from "@cloudroom/shared-ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@cloudroom/shared-ui/dialog";
import { appToast } from "@/components/ui/app-toast.js";
import { invalidatePluginList } from "@/hooks/cache-owners/plugin-cache-owner";
import { humanClickRequestsQueryKey } from "@/hooks/queries/query-keys";
import { FullTrustWarning } from "./management/plugin-ui";

interface ClickRequest {
  id: string;
  action: string;
  title: string;
  verb: "Install" | "Update";
  rows: { label: string; value: string }[];
  askedBy: string | null;
  response: { status: number; body: unknown } | null;
}

// A dialog that appears under the pointer mid-click must not take that click as a yes.
const ARM_DELAY_MS = 500;

const isSkill = (request: ClickRequest): boolean =>
  request.action === "skill-registry-install";

const text = (value: unknown): string | null =>
  typeof value === "string" && value.length > 0 ? value : null;

const record = (value: unknown): Record<string, unknown> =>
  typeof value === "object" && value !== null
    ? (value as Record<string, unknown>)
    : {};

async function call(path: string, method: "GET" | "POST"): Promise<unknown> {
  const response = await fetch(`/api/v1/human-clicks${path}`, {
    method,
    ...(method === "POST"
      ? { headers: { "content-type": "application/json" }, body: "{}" }
      : {}),
  });
  const body: unknown = await response.json().catch(() => null);
  if (!response.ok) {
    throw new Error(text(record(body).message) ?? `HTTP ${response.status}`);
  }
  return body;
}

export function HumanClickRequests() {
  const queryClient = useQueryClient();
  const requests = useQuery({
    queryKey: humanClickRequestsQueryKey(),
    queryFn: async () =>
      (record(await call("", "GET")).requests ?? []) as ClickRequest[],
    refetchOnWindowFocus: true,
    retry: false,
  });
  let request = requests.data?.[0];
  const refresh = () =>
    queryClient.invalidateQueries({ queryKey: humanClickRequestsQueryKey() });

  const answer = useMutation({
    meta: { showErrorToast: false },
    mutationFn: async (args: { request: ClickRequest; approve: boolean }) =>
      (await call(
        `/${args.request.id}/${args.approve ? "approve" : "decline"}`,
        "POST",
      )) as ClickRequest,
    onSuccess: (answered, args) => {
      if (!args.approve) return;
      const result = answered.response;
      const done = answered.verb === "Update" ? "updated" : "installed";
      const noun = isSkill(answered) ? "Skill" : "Plugin";
      if (result !== null && result.status < 400) {
        appToast.success(`${noun} ${done}`);
        if (!isSkill(answered)) void invalidatePluginList({ queryClient });
        return;
      }
      const failure = record(result?.body);
      appToast.error(`${noun} was not ${done}`, {
        description:
          text(failure.error) ?? text(failure.message) ?? "Unknown error",
      });
    },
    onError: (error) =>
      appToast.error("Could not answer the request", {
        description: error instanceof Error ? error.message : String(error),
      }),
    onSettled: refresh,
  });

  // Stays on screen while its install runs, though it has left the waiting list.
  if (answer.isPending && answer.variables) request = answer.variables.request;
  const shownId = request?.id;
  const [armedId, setArmedId] = useState<string | undefined>();
  useEffect(() => {
    if (shownId === undefined) return;
    const timer = setTimeout(() => setArmedId(shownId), ARM_DELAY_MS);
    return () => clearTimeout(timer);
  }, [shownId]);

  if (request === undefined) return null;
  const shown = request;
  return (
    <Dialog
      open
      onOpenChange={(open) => {
        if (!open && !answer.isPending) {
          answer.mutate({ request: shown, approve: false });
        }
      }}
    >
      <DialogContent className="sm:max-w-md" data-testid="human-click-request">
        <DialogHeader>
          <DialogTitle>{shown.title}</DialogTitle>
          <DialogDescription>
            {shown.askedBy === null
              ? "An agent or room-cli"
              : `The agent in "${shown.askedBy}"`}{" "}
            asked for this. Nothing happens until you click {shown.verb}.
          </DialogDescription>
        </DialogHeader>
        <dl className="space-y-1 rounded-md border border-border bg-muted/30 px-3 py-2">
          {shown.rows.map((row) => (
            <div key={row.label} className="flex gap-2">
              <dt className="w-28 shrink-0 text-2xs text-subtle-foreground">
                {row.label}
              </dt>
              <dd className="min-w-0 break-all font-mono text-2xs text-foreground">
                {row.value}
              </dd>
            </div>
          ))}
        </dl>
        {isSkill(shown) ? (
          <p className="text-2xs leading-snug text-subtle-foreground">
            Agents follow a skill's instructions in any thread. Only install
            from sources you trust.
          </p>
        ) : (
          <FullTrustWarning />
        )}
        <DialogFooter>
          <Button
            variant="outline"
            disabled={answer.isPending}
            onClick={() => answer.mutate({ request: shown, approve: false })}
          >
            Decline
          </Button>
          <Button
            disabled={answer.isPending || armedId !== shown.id}
            onClick={() => answer.mutate({ request: shown, approve: true })}
          >
            {answer.isPending && answer.variables?.approve
              ? `${shown.verb === "Update" ? "Updating" : "Installing"}…`
              : shown.verb}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
