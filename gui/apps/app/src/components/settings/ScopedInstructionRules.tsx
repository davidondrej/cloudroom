import { useState } from "react";
import { Link } from "react-router";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Button } from "@cloudroom/shared-ui/button";
import { Icon } from "@cloudroom/shared-ui/icon";
import { ModelReasoningPicker } from "@/components/pickers/ModelReasoningPicker";
import type { ModelPickerOption } from "@/components/pickers/model-picker-option";
import { getProviderIconInfo } from "@/lib/provider-icon";
import { resolveModelCatalogSelection } from "@/hooks/thread-creation-options/model-catalog-selection";
import { formatModelLabel } from "@/hooks/useThreadCreationOptions";
import { Textarea } from "@cloudroom/shared-ui/textarea";
import { ProviderIcon } from "@/components/plugin/ProviderIcon";
import { SettingsSection } from "@/components/ui/settings-section";
import {
  useSystemExecutionOptions,
  useSystemProviders,
} from "@/hooks/queries/system-queries";
import {
  cloudroomConnectionQuery,
  cloudHarness,
  cloudHarnessOption,
} from "@/hooks/queries/cloudroom-queries";
import { usePluginSettingsView } from "@/hooks/queries/plugin-settings-queries";
import { getSettingsRoutePath } from "@/lib/route-paths";
import { callPluginRpc } from "@/lib/plugin-sdk-hooks";
import {
  lengthError,
  type InstructionRule,
  type RuleChange,
} from "../../../../../plugins/custom-instructions/rules";

const pluginId = "custom-instructions";
const rulesKey = ["plugin", pluginId, "rules"] as const;
const allModels = "";
type Draft = {
  providerId: string;
  model: string;
  text: string;
  original: InstructionRule | null;
};
const blank: Draft = {
  providerId: "",
  model: allModels,
  text: "",
  original: null,
};

function chooseRule(rule: InstructionRule): Draft {
  return {
    providerId: rule.providerId,
    model: rule.model ?? allModels,
    text: rule.text,
    original: rule,
  };
}

export function ScopedInstructionRules() {
  const client = useQueryClient();
  const [draft, setDraft] = useState<Draft | null>(null);
  const [confirmRemove, setConfirmRemove] = useState(false);
  const [notice, setNotice] = useState("");
  const rulesQuery = useQuery({
    queryKey: rulesKey,
    queryFn: async () =>
      (await callPluginRpc(
        fetch,
        pluginId,
        "listRules",
        null,
      )) as InstructionRule[],
  });
  const global = usePluginSettingsView(pluginId, { enabled: true }).data?.values
    .instructions;
  const providers = useSystemProviders();
  const cloud = useQuery({ ...cloudroomConnectionQuery, staleTime: 60_000 });
  const cloudHarnesses = (cloud.data?.harnesses ?? []).flatMap(
    (h) => cloudHarnessOption(h.id) ?? [],
  );
  const harnesses = new Map<string, string>();
  for (const p of providers.data ?? []) {
    if (p.available || cloudHarnesses.some((h) => h.id === p.id))
      harnesses.set(p.id, p.displayName);
  }
  for (const h of cloudHarnesses) {
    if (!harnesses.has(h.id)) harnesses.set(h.id, h.label);
  }
  const providerOptions = [...harnesses].map(([value, label]) => {
    const info = providers.data?.find((p) => p.id === value);
    return {
      value,
      label,
      icon: getProviderIconInfo("agent", value, info).icon,
      brandPrefix: info?.strings?.brandPrefix,
    };
  });
  const selected = draft?.providerId ?? "";
  const pickerProvider = selected || providerOptions[0]?.value || "";
  const local = useSystemExecutionOptions({
    providerId: pickerProvider,
    enabled: Boolean(
      draft &&
      !draft.original &&
      pickerProvider &&
      providers.data?.some((p) => p.id === pickerProvider && p.available),
    ),
  });
  const catalog = resolveModelCatalogSelection({
    models: local.data?.models ?? [],
    selectedOnlyModels: local.data?.selectedOnlyModels ?? [],
    selectedModel: draft?.model ?? "",
    provider: providers.data?.find((p) => p.id === pickerProvider),
    catalogIsVerified:
      local.isSuccess && !local.isPlaceholderData && !local.data.modelLoadError,
    formatModelLabel,
  });
  function scopeOptions(
    providerId: string,
    models: readonly ModelPickerOption[],
    moreModels: readonly ModelPickerOption[],
  ) {
    const known = new Set([...models, ...moreModels].map((m) => m.value));
    const profile = cloudHarness(cloud.data, providerId);
    const options = [{ value: allModels, label: "All models" }, ...models];
    for (const m of profile?.models ?? []) {
      const value =
        profile?.provider && !m.model.includes("/")
          ? profile.provider + "/" + m.model
          : m.model;
      if (!known.has(value))
        options.push({ value, label: formatModelLabel(m.model) });
    }
    return options;
  }
  const rules = rulesQuery.data ?? [];
  const existing =
    draft &&
    rules.find(
      (r) =>
        r.providerId === draft.providerId &&
        (r.model ?? allModels) === draft.model,
    );
  const duplicate = !draft?.original && existing;
  const validation =
    draft?.text.trim() &&
    selected &&
    !duplicate &&
    !confirmRemove &&
    typeof global === "string"
      ? lengthError(global, [
          ...rules.filter((rule) => rule !== existing),
          {
            providerId: selected,
            model: draft.model || null,
            text: draft.text.trim(),
          },
        ])
      : null;
  const mutate = useMutation({
    mutationFn: async (input: RuleChange) =>
      (await callPluginRpc(
        fetch,
        pluginId,
        "changeRule",
        input,
      )) as InstructionRule[],
    onSuccess: (next, change) => {
      client.setQueryData(rulesKey, next);
      setDraft(null);
      setConfirmRemove(false);
      setNotice(
        change.text === null ? "Instructions removed." : "Instructions saved.",
      );
    },
    onError: () => {
      void rulesQuery.refetch();
    },
  });
  function open(next: Draft | null) {
    mutate.reset();
    setNotice("");
    setConfirmRemove(false);
    setDraft(next);
  }
  function change(next: Partial<Draft>) {
    if (draft) setDraft({ ...draft, ...next });
    mutate.reset();
  }
  function save(remove = false) {
    if (!draft) return;
    const label =
      draft.original?.modelLabel ??
      scopeOptions(
        selected,
        catalog.modelOptions,
        catalog.moreModelOptions,
      ).find((m) => m.value === draft.model)?.label;
    mutate.mutate({
      providerId: draft.providerId,
      model: draft.model || null,
      expected: draft.original?.text ?? null,
      text: remove ? null : draft.text.trim(),
      ...(draft.model && label ? { modelLabel: label } : {}),
    });
  }
  const labelFor = (id: string) =>
    harnesses.get(id) ??
    providers.data?.find((p) => p.id === id)?.displayName ??
    id;
  const sorted = [...rules].sort(
    (a, b) =>
      labelFor(a.providerId).localeCompare(labelFor(b.providerId)) ||
      (a.model ?? "").localeCompare(b.model ?? ""),
  );
  const catalogPending = providers.isPending || cloud.isPending;
  const pending = mutate.isPending;
  const card = "space-y-3 rounded-lg bg-surface-recessed p-4";
  const retry = (
    <Button
      size="sm"
      variant="outline"
      onClick={() => void rulesQuery.refetch()}
    >
      Retry
    </Button>
  );
  const conflict =
    draft?.original &&
    rulesQuery.isSuccess &&
    draft.original.text !== (existing?.text ?? null);
  return (
    <SettingsSection
      title="Model specific instructions"
      description="Matching instructions are appended in order, harness first, then model."
      plain
      action={
        !draft && (
          <Button
            size="sm"
            variant="outline"
            disabled={!rulesQuery.isSuccess || !harnesses.size}
            onClick={() => open(blank)}
          >
            <Icon name="Plus" />
            Add
          </Button>
        )
      }
    >
      <div className="space-y-3">
        {!rulesQuery.data &&
          (rulesQuery.isError ? (
            <div role="alert" className={card}>
              Couldn’t load instructions. {retry}
            </div>
          ) : (
            <p role="status" className="text-xs text-subtle-foreground">
              Loading instructions…
            </p>
          ))}
        {draft && (
          <div className={card}>
            <div className="flex items-center justify-between gap-3">
              <h3 className="text-sm font-medium">
                {confirmRemove
                  ? `Remove instructions for ${draft.original?.modelLabel ?? (draft.model || labelFor(selected))}?`
                  : draft.original
                    ? "Edit instructions"
                    : "Add instructions"}
              </h3>
              {draft.original && !confirmRemove && (
                <Button
                  variant="ghost"
                  size="sm"
                  disabled={pending}
                  onClick={() => setConfirmRemove(true)}
                >
                  <Icon name="Trash2" />
                  Remove
                </Button>
              )}
            </div>
            {confirmRemove ? (
              <p className="text-xs text-subtle-foreground">
                Other saved instructions still apply.
              </p>
            ) : (
              <>
                <div className="space-y-1">
                  <p className="text-xs">Applies to</p>
                  {draft.original ? (
                    <div className="flex items-center gap-2 text-sm">
                      <ProviderIcon
                        providerKind="agent"
                        provider={{ id: selected }}
                        className="size-4"
                      />
                      {labelFor(selected)} ·{" "}
                      {draft.original.modelLabel ??
                        (draft.model || "All models")}
                    </div>
                  ) : (
                    <ModelReasoningPicker
                      providerOptions={providerOptions}
                      selectedProviderId={pickerProvider}
                      hasMultipleProviders={providerOptions.length > 1}
                      modelValue={selected ? draft.model : null}
                      modelOptions={catalog.modelOptions}
                      moreModelOptions={catalog.moreModelOptions}
                      extendModelOptions={scopeOptions}
                      formatModelLabel={formatModelLabel}
                      onSelectModel={({ providerId, model }) =>
                        change({ providerId, model })
                      }
                      onModelChange={(model) =>
                        change({ providerId: pickerProvider, model })
                      }
                      reasoningValue="medium"
                      reasoningOptions={[]}
                      onReasoningChange={() => {}}
                      serviceTier={undefined}
                      onServiceTierChange={() => {}}
                      showServiceTiers={false}
                      commandShortcutsEnabled={false}
                      disabled={pending}
                    />
                  )}
                </div>
                {duplicate ? (
                  <div className="flex items-center gap-3 text-sm">
                    This target already has instructions.
                    <Button
                      size="sm"
                      variant="outline"
                      onClick={() => open(chooseRule(duplicate))}
                    >
                      Edit existing
                    </Button>
                  </div>
                ) : (
                  <label className="block space-y-1 text-xs">
                    Instructions
                    <Textarea
                      aria-label="Model specific instructions"
                      aria-invalid={Boolean(validation)}
                      value={draft.text}
                      disabled={pending}
                      onChange={(e) => change({ text: e.target.value })}
                      placeholder="Write instructions for this target…"
                      className="min-h-24 resize-y font-mono text-sm"
                    />
                  </label>
                )}
                {!duplicate && selected && (
                  <p className="text-xs text-subtle-foreground">
                    {draft.model
                      ? `Appended after the global and ${labelFor(selected)} instructions.`
                      : `Appended after the global default for every ${labelFor(selected)} model.`}
                  </p>
                )}
              </>
            )}
            {validation && (
              <p role="alert" className="text-xs text-destructive">
                {validation}
              </p>
            )}
            {mutate.isError && (
              <p role="alert" className="text-xs text-destructive">
                {mutate.error.message}
              </p>
            )}
            {conflict && (
              <div role="alert" className="text-xs">
                This rule changed elsewhere.{" "}
                <Button
                  size="sm"
                  variant="outline"
                  onClick={() => open(existing ? chooseRule(existing) : blank)}
                >
                  Load saved version
                </Button>
              </div>
            )}
            <div className="flex justify-end gap-2">
              <Button
                size="sm"
                variant="ghost"
                disabled={pending}
                onClick={() =>
                  confirmRemove ? setConfirmRemove(false) : open(null)
                }
              >
                Cancel
              </Button>
              <Button
                size="sm"
                variant={confirmRemove ? "destructive" : "default"}
                onClick={() => save(confirmRemove)}
                disabled={
                  pending ||
                  Boolean(conflict) ||
                  Boolean(validation) ||
                  (!confirmRemove &&
                    (!selected ||
                      !draft.text.trim() ||
                      Boolean(duplicate) ||
                      draft.text.trim() === draft.original?.text))
                }
              >
                {pending ? (
                  "Saving…"
                ) : confirmRemove ? (
                  "Remove instructions"
                ) : mutate.isError ? (
                  "Retry save"
                ) : draft.original ? (
                  "Save changes"
                ) : (
                  <>
                    <Icon name="Plus" />
                    Add
                  </>
                )}
              </Button>
            </div>
          </div>
        )}
        {rules.length > 0 && (
          <div className="divide-y divide-border rounded-lg bg-surface-recessed px-4">
            {sorted.map((rule) => (
              <div
                key={JSON.stringify([rule.providerId, rule.model])}
                className="flex min-h-14 items-center gap-3 py-3"
              >
                {rule.model ? (
                  <Icon name="Cpu" className="size-5 shrink-0" />
                ) : (
                  <ProviderIcon
                    providerKind="agent"
                    provider={{ id: rule.providerId }}
                    className="size-5 shrink-0"
                  />
                )}
                <div className="min-w-0 flex-1">
                  <p className="text-sm font-medium">
                    {rule.modelLabel ?? rule.model ?? labelFor(rule.providerId)}{" "}
                    <span className="font-normal text-subtle-foreground">
                      ·{" "}
                      {rule.model
                        ? labelFor(rule.providerId) + " only"
                        : "All models"}
                    </span>
                  </p>
                  <p className="truncate text-xs text-subtle-foreground">
                    {rule.text}
                  </p>
                </div>
                <Button
                  size="icon"
                  variant="ghost"
                  aria-label={"Edit " + (rule.model ?? rule.providerId)}
                  disabled={draft !== null}
                  onClick={() => open(chooseRule(rule))}
                >
                  <Icon name="Edit" />
                </Button>
              </div>
            ))}
          </div>
        )}
        {rulesQuery.isSuccess && !rules.length && !draft && (
          <div className={card}>
            <p className="text-sm">No model specific instructions yet.</p>
          </div>
        )}
        {rulesQuery.isSuccess &&
          !harnesses.size &&
          !catalogPending &&
          !draft && (
            <p className="text-xs text-subtle-foreground">
              Connect a harness to add instructions.{" "}
              <Link
                className="underline"
                to={getSettingsRoutePath("providers")}
              >
                Open agent settings
              </Link>
            </p>
          )}
        {notice && (
          <p className="text-xs text-subtle-foreground" role="status">
            {notice}
          </p>
        )}
      </div>
    </SettingsSection>
  );
}
