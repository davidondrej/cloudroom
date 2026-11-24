import { useState, type ReactNode } from "react";
import { Button } from "@cloudroom/shared-ui/button";
import { Icon } from "@cloudroom/shared-ui/icon";
import { cn } from "@cloudroom/shared-ui/lib/utils";
import { Textarea } from "@cloudroom/shared-ui/textarea";

// Jev loops (docs/scopes/loops.md, Jev loops): a Cloud loop that runs no agent. Its script prints items, Jev (TypeSafe's
// decision model) answers the loop's questions for each one, and its action script acts on the answers.

/** The provider ID the website gives a Jev loop's agent (web/lib/automations.ts, JEV_AGENT). */
export const JEV_PROVIDER_ID = "jev";

/** TypeSafe's mark, in TypeSafe's pink (their brand color on typesafe.ai), wherever Jev shows. */
export function TypeSafeLogo({ className }: { className?: string }) {
  return (
    <svg
      viewBox="0 0 16.487 24"
      fill="#F386A1"
      className={className}
      aria-hidden
    >
      <path d="M 12.756 2.928 L 12.756 7.067 L 16.486 9.487 L 16.487 18.652 L 8.244 24 L 3.732 21.073 L 3.732 16.82 L 0 14.399 L 0 5.35 L 0.355 5.118 L 8.244 0 Z M 5.94 20.65 L 8.242 22.144 L 14.275 18.227 L 11.975 16.735 Z M 9.022 10.332 L 9.022 14.4 L 5.29 16.822 L 5.29 19.216 L 11.197 15.383 L 11.197 8.921 Z M 12.756 15.384 L 14.928 16.794 L 14.928 10.332 L 12.756 8.922 Z M 2.21 13.976 L 4.511 15.47 L 6.812 13.976 L 4.512 12.485 Z M 1.559 6.193 L 1.559 12.544 L 3.731 11.134 L 3.731 7.066 L 7.464 4.643 L 7.464 2.36 L 1.56 6.193 Z M 5.291 11.132 L 7.463 12.542 L 7.463 10.332 L 5.292 8.921 L 5.292 11.132 Z M 5.94 7.487 L 8.244 8.981 L 10.544 7.488 L 8.244 5.994 Z M 9.024 4.643 L 11.196 6.054 L 11.196 3.774 L 9.024 2.359 Z" />
    </svg>
  );
}

/** A Jev loop's agent, wherever a loop's agent shows. */
export function JevLabel({ note }: { note?: string }) {
  return (
    <span className="flex min-w-0 items-center gap-1.5">
      <TypeSafeLogo className="size-3.5 shrink-0" />
      <span className="shrink-0">Jev</span>
      {note ? (
        <span className="min-w-0 truncate text-muted-foreground">{note}</span>
      ) : null}
    </span>
  );
}

export type JevLoopFields = {
  /** Jev's questions, as JSON: the loop's prompt. */
  questions: string;
  /** Prints the items, one per line. */
  script: string;
  /** Gets Jev's answers as a JSON file, its first argument. */
  action: string;
};

const QUESTIONS_HINT = `{
  "is_video_idea": {
    "type": "noul",
    "instructions": "Is \`title\` an idea for a video, not a task?"
  }
}`;
const SCRIPT_HINT = `# Print one item per line, as JSON. Only items not handled yet.
# Print nothing to skip the run.
echo '{"id": "1", "title": "..."}'`;
const ACTION_HINT = `# $1 is a JSON file: [{"item": {...}, "answers": {"is_video_idea": {"noul": 0.94}}}]
# Act on it in code. Each line printed is saved as something the run did.
jq -r '.[] | select(.answers.is_video_idea.noul > 0.8) | "Moved \\(.item.id)"' "$1"`;

function questionsError(text: string): string | null {
  try {
    const parsed: unknown = JSON.parse(text);
    return parsed !== null &&
      typeof parsed === "object" &&
      !Array.isArray(parsed)
      ? null
      : "The questions must be a JSON object";
  } catch {
    return "The questions are not valid JSON";
  }
}

function Part({
  label,
  hint,
  children,
}: {
  label: string;
  hint: string;
  children: ReactNode;
}) {
  return (
    <div className="flex min-h-0 flex-col md:flex-1">
      <div className="flex items-center gap-2 text-xs font-medium text-subtle-foreground">
        {label}
        <span className="min-w-0 truncate font-normal text-muted-foreground">
          {hint}
        </span>
        <span
          aria-hidden
          className="h-px min-w-4 flex-1 bg-foreground/[0.07]"
        />
      </div>
      {children}
    </div>
  );
}

/** The left side of a Jev loop's dialog: its questions and two scripts, saved together. `saved` is null while an
 *  agent's loop is being turned into a Jev loop; `onBack` then returns to its agent. */
export function JevDocument({
  saved,
  script,
  saveKey,
  onSave,
  onBack,
}: {
  saved: JevLoopFields | null;
  /** The loop's script so far, kept when an agent's loop becomes a Jev loop. */
  script: string;
  saveKey: string;
  onSave: (fields: JevLoopFields) => Promise<boolean>;
  onBack?: () => void;
}) {
  const base: JevLoopFields = saved ?? { questions: "", script, action: "" };
  const [draft, setDraft] = useState(base);
  const [seen, setSeen] = useState(JSON.stringify(base));
  if (seen !== JSON.stringify(base)) {
    setSeen(JSON.stringify(base));
    setDraft(base);
  }
  const [saving, setSaving] = useState(false);
  const fields: JevLoopFields = {
    questions: draft.questions.trim(),
    script: draft.script.trim(),
    action: draft.action.trim(),
  };
  const dirty =
    saved === null ||
    fields.questions !== saved.questions.trim() ||
    fields.script !== saved.script.trim() ||
    fields.action !== saved.action.trim();
  const error = !fields.questions
    ? "Add Jev's questions"
    : (questionsError(fields.questions) ??
      (!fields.script
        ? "Add the script that prints the items"
        : !fields.action
          ? "Add the action script"
          : null));
  const save = async () => {
    if (!dirty || error || saving) return;
    setSaving(true);
    await onSave(fields);
    setSaving(false);
  };
  const area = (
    key: keyof JevLoopFields,
    label: string,
    placeholder: string,
  ) => (
    <Textarea
      value={draft[key]}
      onChange={(event) => setDraft({ ...draft, [key]: event.target.value })}
      aria-label={label}
      placeholder={placeholder}
      spellCheck={false}
      disabled={saving}
      className="mt-2 h-32 resize-none rounded-none border-0 bg-transparent px-0 py-0 font-mono text-[12.5px] leading-[1.6] text-foreground/90 shadow-none placeholder:text-muted-foreground/40 focus-visible:ring-0 disabled:opacity-100 md:h-auto md:min-h-16 md:flex-1 dark:bg-transparent"
    />
  );
  return (
    <div
      className="mt-6 flex min-h-0 flex-col gap-4 md:flex-1"
      onKeyDown={(event) => {
        if (
          (event.metaKey || event.ctrlKey) &&
          event.key.toLowerCase() === "s"
        ) {
          event.preventDefault();
          event.stopPropagation();
          void save();
        }
      }}
    >
      <Part label="Script" hint="prints the items, one per line">
        {area("script", "Loop script", SCRIPT_HINT)}
      </Part>
      <Part label="Questions" hint="Jev answers them for each item">
        {area("questions", "Jev questions", QUESTIONS_HINT)}
      </Part>
      <Part label="Action script" hint="gets Jev's answers and acts">
        {area("action", "Action script", ACTION_HINT)}
      </Part>
      <div className="flex h-12 shrink-0 items-center gap-2 border-t border-foreground/[0.07] text-xs text-subtle-foreground">
        {dirty || saving ? (
          <>
            <span
              className={cn("min-w-0 truncate", !error && "text-foreground")}
            >
              {saving ? "Saving…" : (error ?? "Unsaved changes")}
            </span>
            <span className="flex-1" />
            <Button
              type="button"
              variant="ghost"
              size="sm"
              disabled={saving}
              onClick={() => (saved === null ? onBack?.() : setDraft(base))}
            >
              {saved === null ? "Back to agent" : "Discard"}
            </Button>
            <Button
              type="button"
              size="sm"
              disabled={saving || error !== null}
              onClick={() => void save()}
            >
              Save
              <span className="text-primary-foreground/60">{saveKey}</span>
            </Button>
          </>
        ) : (
          <>
            <Icon name="Check" className="size-3.5" aria-hidden />
            <span className="text-muted-foreground">Saved</span>
            <span aria-hidden className="text-muted-foreground/40">
              ·
            </span>
            <span className="truncate">
              No agent runs: Jev decides, the action script acts
            </span>
          </>
        )}
      </div>
    </div>
  );
}
