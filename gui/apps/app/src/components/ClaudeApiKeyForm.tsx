import { useState } from "react";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { Button } from "@cloudroom/shared-ui/button";
import { sdk } from "@/lib/sdk";

/** Cloud only: the less prominent alternative to a Claude subscription. */
export function ClaudeApiKeyForm() {
  const [open, setOpen] = useState(false);
  const [apiKey, setApiKey] = useState("");
  const client = useQueryClient();
  const save = useMutation({
    mutationFn: async (key: string) => {
      const result = await sdk.cloudroom.claudeAuth({
        action: "key",
        requestId: crypto.randomUUID(),
        apiKey: key,
      });
      if (result.state !== "connected")
        throw new Error(result.message ?? "Could not connect this API key.");
      return result;
    },
    onSettled: () =>
      client.invalidateQueries({ queryKey: ["claude-connection"] }),
  });
  if (!open)
    return (
      <Button
        variant="ghost"
        size="sm"
        className="h-7 w-full text-xs text-muted-foreground"
        onClick={() => setOpen(true)}
      >
        Use an API key instead
      </Button>
    );
  return (
    <form
      className="space-y-1.5"
      onSubmit={(event) => {
        event.preventDefault();
        const key = apiKey.trim();
        setApiKey("");
        save.mutate(key);
      }}
    >
      {save.error && (
        <p role="alert" className="text-destructive">
          {save.error.message}
        </p>
      )}
      <div className="flex gap-1.5">
        <input
          type="password"
          maxLength={1024}
          autoComplete="off"
          spellCheck={false}
          placeholder="sk-ant-…"
          aria-label="Anthropic API key"
          value={apiKey}
          onChange={(event) => setApiKey(event.target.value)}
          className="min-w-0 flex-1 rounded-md border border-input bg-background px-2 py-1"
        />
        <Button
          type="submit"
          size="sm"
          className="h-7 text-xs"
          disabled={!apiKey.trim() || save.isPending}
        >
          {save.isPending ? "Checking…" : "Connect"}
        </Button>
      </div>
      <p className="text-muted-foreground">
        Anthropic bills this key per use. It replaces any Claude subscription on
        your VM.
      </p>
    </form>
  );
}
