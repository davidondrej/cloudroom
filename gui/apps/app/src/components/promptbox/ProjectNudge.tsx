import { useEffect, useRef, useState } from "react";
import { useAtomValue } from "jotai";
import { Icon } from "@cloudroom/shared-ui/icon";
import { sdk } from "@/lib/sdk";
import { createSyncedPreferenceAtom } from "@/lib/ui-preferences/synced-preference-atom";

export const projectNudgeEnabledAtom = createSyncedPreferenceAtom("projectNudge.enabled");
export const projectNudgeConfidenceAtom = createSyncedPreferenceAtom("projectNudge.confidence");

const MIN_WORDS = 5;
const PAUSE_MS = 500;

/** Another project the prompt looks like it belongs in (docs/scopes/jev-project-selection.md). It checks once typing pauses,
 *  never the same text twice, and keeps the last answer only while the text grows or shrinks from what it checked, so a
 *  paste that replaces the prompt hides a stale hint at once. */
export function useProjectNudge(text: string, projectId: string | null | undefined) {
  const enabled = useAtomValue(projectNudgeEnabledAtom);
  const answers = useRef(new Map<string, string | null>());
  const [last, setLast] = useState<{ projectId: string; prompt: string; pick: string | null } | null>(null);
  const [dismissed, setDismissed] = useState(false);
  const prompt = text.trim();
  const words = prompt ? prompt.split(/\s+/).length : 0;
  const key = projectId ? `${projectId}\n${prompt}` : "";
  const ready = enabled !== false && !!projectId && words >= MIN_WORDS;

  useEffect(() => {
    if (!prompt) setDismissed(false);
  }, [prompt]);

  useEffect(() => {
    if (!ready || !projectId) return;
    const known = answers.current.get(key);
    if (known !== undefined) {
      setLast({ projectId, prompt, pick: known });
      return;
    }
    const controller = new AbortController();
    const timer = setTimeout(() => {
      sdk.cloudroom
        .projectSuggestion({ prompt, projectId }, controller.signal)
        .then(({ projectId: pick }) => {
          answers.current.set(key, pick);
          setLast({ projectId, prompt, pick });
        })
        .catch(() => {});
    }, PAUSE_MS);
    return () => {
      clearTimeout(timer);
      controller.abort();
    };
  }, [ready, key, prompt, projectId]);

  const show =
    ready &&
    !dismissed &&
    last?.projectId === projectId &&
    (prompt.startsWith(last.prompt) || last.prompt.startsWith(prompt));
  return { projectId: show ? (last?.pick ?? null) : null, dismiss: () => setDismissed(true) };
}

export function ProjectNudgeHint({ name, onAccept }: { name: string; onAccept: () => void }) {
  return (
    <div className="mt-1 flex px-3.5 pl-[18px]">
      <button
        type="button"
        className="flex items-center gap-1.5 text-xs text-muted-foreground hover:text-foreground"
        onMouseDown={(event) => event.preventDefault()}
        onClick={onAccept}
      >
        <Icon name="CornerDownRight" className="size-3" />
        <span>
          Did you mean <span className="font-medium text-primary">{name}</span>?
        </span>
        <kbd className="inline-flex h-4 min-w-4 items-center justify-center rounded border border-border px-0.5">
          <Icon name="CornerDownLeft" className="size-2.5" />
        </kbd>
      </button>
    </div>
  );
}
