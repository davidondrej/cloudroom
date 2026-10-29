import { useMemo, useState } from "react";
import {
  definePluginApp,
  type PluginPendingInteractionProps,
} from "@get-bb/plugin-sdk/app";
import { Button } from "@cloudroom/shared-ui/button";
import { Input } from "@cloudroom/shared-ui/input";
import { Label } from "@cloudroom/shared-ui/label";
import {
  DashedLineCircleIcon,
  ViewIcon,
  ViewOffSlashIcon,
} from "@hugeicons/core-free-icons";
import { HugeiconsIcon } from "@hugeicons/react";
import {
  SECRET_REQUEST_RENDERER_ID,
  secretRequestPayloadSchema,
  secretRequestResponseSchema,
} from "@cloudroom/plugin-interaction-contracts";
import { reconcileDotenv } from "./src/dotenv.js";

// Pasted keys often carry spaces or zero-width characters at the edges.
// Strip only those; never change anything inside the value.
const EDGE_JUNK = /^[\s\u200B-\u200D\u2060\uFEFF]+|[\s\u200B-\u200D\u2060\uFEFF]+$/gu;

function SecretRequestInteraction({
  interaction,
  submit,
  cancel,
}: PluginPendingInteractionProps) {
  const parsed = useMemo(
    () => secretRequestPayloadSchema.safeParse(interaction.payload),
    [interaction.payload],
  );
  const [values, setValues] = useState<Record<string, string>>({});
  const [revealed, setRevealed] = useState<Record<string, boolean>>({});
  const [busy, setBusy] = useState(false);
  const [formError, setFormError] = useState<string | null>(null);

  if (!parsed.success) {
    return (
      <div className="space-y-3">
        <p className="text-sm text-muted-foreground">
          This secret request is invalid.
        </p>
        <Button
          variant="outline"
          onClick={() => void cancel().catch(() => undefined)}
        >
          Cancel
        </Button>
      </div>
    );
  }
  const payload = parsed.data;
  const submitValues = async () => {
    const trimmed = Object.fromEntries(
      Object.entries(values).map(([name, value]) => [
        name,
        value.replace(EDGE_JUNK, ""),
      ]),
    );
    const validated = secretRequestResponseSchema.safeParse({
      values: trimmed,
    });
    if (!validated.success) {
      setFormError(
        "Every secret must be a non-empty single-line value no larger than 16 KiB.",
      );
      return;
    }
    try {
      reconcileDotenv("", validated.data.values);
    } catch {
      setFormError(
        "One value cannot be represented safely in a dotenv assignment.",
      );
      return;
    }
    setFormError(null);
    setBusy(true);
    try {
      try {
        await submit({ values: validated.data.values });
        setValues({});
      } catch {}
    } finally {
      setBusy(false);
    }
  };
  const cancelRequest = async () => {
    try {
      await cancel();
    } catch {}
  };

  return (
    <form
      className="space-y-4"
      onSubmit={(event) => {
        event.preventDefault();
        void submitValues();
      }}
    >
      <div className="space-y-2 font-mono text-sm">
        {payload.purpose ? (
          <p className="text-pretty text-subtle-foreground">
            # {payload.purpose}
          </p>
        ) : null}
        {payload.fields.map((field) => {
          const inputId = `secret-${interaction.id}-${field.name}`;
          const isRevealed = revealed[field.name] ?? false;
          return (
            <div key={field.name} className="min-w-0 space-y-2">
              {field.description ? (
                <p className="text-pretty text-subtle-foreground">
                  # {field.description}
                </p>
              ) : null}
              <div className="flex flex-wrap items-center gap-x-2 gap-y-1.5">
                <span className="flex min-w-0 items-center gap-2">
                  <Label
                    htmlFor={inputId}
                    className="break-all font-mono font-normal leading-normal text-[color:light-dark(var(--foreground),var(--primary-text))]"
                    translate="no"
                  >
                    {field.name}
                  </Label>
                  <span aria-hidden="true" className="text-muted-foreground">
                    =
                  </span>
                </span>
                <div className="relative min-w-48 flex-1">
                  <Input
                    id={inputId}
                    name={field.name}
                    type={isRevealed ? "text" : "password"}
                    placeholder="paste value"
                    autoComplete="off"
                    autoCapitalize="none"
                    autoCorrect="off"
                    spellCheck={false}
                    required
                    value={values[field.name] ?? ""}
                    onChange={(event) =>
                      setValues((current) => ({
                        ...current,
                        [field.name]: event.target.value,
                      }))
                    }
                    disabled={busy}
                    className="h-9 border-border bg-[color:light-dark(var(--composer),black)] pr-10 font-mono text-sm placeholder:text-subtle-foreground"
                  />
                  <Button
                    type="button"
                    size="icon"
                    variant="ghost"
                    className="absolute right-1 top-1/2 size-7 -translate-y-1/2 text-muted-foreground"
                    aria-label={`${isRevealed ? "Hide" : "Show"} ${field.name}`}
                    aria-pressed={isRevealed}
                    onClick={() =>
                      setRevealed((current) => ({
                        ...current,
                        [field.name]: !current[field.name],
                      }))
                    }
                    disabled={busy}
                  >
                    <HugeiconsIcon
                      icon={isRevealed ? ViewOffSlashIcon : ViewIcon}
                      className="size-4"
                      aria-hidden="true"
                    />
                  </Button>
                </div>
              </div>
            </div>
          );
        })}
      </div>

      {formError ? (
        <p
          className="rounded-md border border-surface-destructive-border bg-surface-destructive px-2 py-1 text-xs text-destructive-text"
          aria-live="polite"
        >
          {formError}
        </p>
      ) : null}

      <div className="flex flex-wrap items-center justify-between gap-2 border-t border-border/70 pt-3">
        <p className="text-xs text-subtle-foreground">Never shown in chat.</p>
        <div className="flex gap-2">
          <Button
            type="button"
            variant="ghost"
            size="sm"
            disabled={busy}
            onClick={() => void cancelRequest()}
          >
            Cancel
          </Button>
          <Button type="submit" size="sm" disabled={busy}>
            {busy ? (
              <HugeiconsIcon
                icon={DashedLineCircleIcon}
                className="size-3 animate-spin"
                aria-hidden="true"
              />
            ) : null}
            Save
          </Button>
        </div>
      </div>
    </form>
  );
}

export default definePluginApp((app) => {
  app.slots.pendingInteraction({
    id: SECRET_REQUEST_RENDERER_ID,
    component: SecretRequestInteraction,
  });
});
