import { useEffect, useState, type ReactNode } from "react";
import { useRpc } from "@get-bb/plugin-sdk/app";
import { Checkbox } from "@cloudroom/shared-ui/checkbox";
import { Icon } from "@cloudroom/shared-ui/icon";
import { cn } from "@cloudroom/shared-ui/lib/utils";
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from "@cloudroom/shared-ui/popover";
import type { automationRpcContract } from "./src/rpc.js";

// Each Cloud loop gets only the API keys and .env files picked for it (ADR 0342). Null means all of them.
const ENV_FILES = ".env";

const sameSet = (a: string[], b: string[]) =>
  a.length === b.length && a.every((item) => b.includes(item));

function useCloudKeys(): string[] | null {
  const rpc = useRpc<typeof automationRpcContract>();
  const [names, setNames] = useState<string[] | null>(null);
  useEffect(() => {
    let live = true;
    rpc.call("cloud_keys", null).then(
      (result) => live && setNames(result.names),
      () => live && setNames([]),
    );
    return () => {
      live = false;
    };
  }, [rpc]);
  return names;
}

function summary(picked: string[] | null, total: number | null): string {
  if (picked === null) return "All keys";
  if (picked.length === 0) return "None";
  if (picked.length === 1)
    return picked[0] === ENV_FILES ? ".env files" : picked[0]!;
  return total === null
    ? `${picked.length} picked`
    : `${picked.length} of ${total}`;
}

/** Picks a Cloud loop's secrets; saves once the list closes. */
export function SecretsPicker({
  picked,
  onChange,
  className,
}: {
  picked: string[] | null;
  onChange: (secrets: string[]) => void;
  className: string;
}) {
  const names = useCloudKeys();
  const [draft, setDraft] = useState<string[] | null>(null);
  const shown = draft ?? picked;
  const all = names === null ? null : [...names, ENV_FILES];
  const toggle = (name: string) => {
    if (!all) return;
    // Keys removed from Settings since they were picked drop out.
    const current = (shown ?? all).filter((item) => all.includes(item));
    setDraft(
      current.includes(name)
        ? current.filter((item) => item !== name)
        : [...current, name],
    );
  };
  const onOpenChange = (open: boolean) => {
    if (open || draft === null) return;
    if (picked === null || !sameSet(draft, picked)) onChange(draft);
    setDraft(null);
  };
  const row = (name: string, label: ReactNode) => (
    <label
      key={name}
      className="flex h-8 cursor-pointer items-center gap-2.5 rounded-md px-2 hover:bg-state-hover"
    >
      <Checkbox
        checked={shown === null || shown.includes(name)}
        disabled={!all}
        onCheckedChange={() => toggle(name)}
        aria-label={name === ENV_FILES ? ".env files" : name}
      />
      {label}
    </label>
  );
  return (
    <Popover onOpenChange={onOpenChange}>
      <PopoverTrigger asChild>
        <button
          type="button"
          aria-label="Secrets"
          className={cn(className, "flex items-center gap-1.5 text-sm")}
        >
          <Icon
            name="Lock"
            className="size-3.5 shrink-0 text-muted-foreground"
            aria-hidden
          />
          <span
            className={cn(
              "truncate",
              shown?.length === 0 ? "text-muted-foreground" : "text-foreground",
            )}
          >
            {summary(shown, all?.length ?? null)}
          </span>
          <Icon
            name="ChevronDown"
            className="size-3.5 shrink-0 opacity-40"
            aria-hidden
          />
        </button>
      </PopoverTrigger>
      <PopoverContent align="start" className="w-72 p-1.5">
        <div className="px-2 pb-1 pt-1.5 text-xs text-subtle-foreground">
          API keys this loop gets
        </div>
        {(names ?? []).map((name) =>
          row(
            name,
            <code className="min-w-0 flex-1 truncate font-mono text-xs text-foreground">
              {name}
            </code>,
          ),
        )}
        {names?.length === 0 ? (
          <p className="px-2 py-1.5 text-xs text-muted-foreground">
            No API keys saved yet.
          </p>
        ) : null}
        <div className="mx-2 my-1 h-px bg-foreground/[0.07]" />
        {row(
          ENV_FILES,
          <span className="min-w-0 flex-1 truncate text-xs text-foreground">
            Project <code className="font-mono">.env</code> files
          </span>,
        )}
        <p className="mx-2 mt-1 border-t border-foreground/[0.07] pb-1 pt-2 text-xs text-subtle-foreground">
          Runs only get what's ticked, from their next run. Add keys in
          Settings → Cloud environment.
        </p>
      </PopoverContent>
    </Popover>
  );
}
