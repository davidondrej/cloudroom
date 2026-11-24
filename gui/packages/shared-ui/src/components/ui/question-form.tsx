import type {
  Question,
  QuestionOption,
  QuestionAnswer,
} from "@cloudroom/shared-ui/question-form-state";
import {
  useQuestionFormHost,
  type QuestionShortcut,
} from "@cloudroom/shared-ui/question-form-host";
import {
  useCallback,
  useEffect,
  useEffectEvent,
  useLayoutEffect,
  useRef,
  useState,
  type KeyboardEvent,
  type ReactNode,
  type RefObject,
} from "react";
import { Button } from "@cloudroom/shared-ui/button";
import { Icon } from "@cloudroom/shared-ui/icon";
import { usePointerCoarse } from "@cloudroom/shared-ui/hooks/use-pointer-coarse";
import { cn } from "@cloudroom/shared-ui/lib/utils";
import {
  answerStateFor,
  buildQuestionAnswers,
  createInitialFormState,
  isQuestionAnswered,
  resolveQuestionShortcutChoice,
  type QuestionAnswerState,
  type QuestionFormState,
} from "@cloudroom/shared-ui/question-form-state";

const OTHER_OPTION_LABEL = "Other…";
const FREE_TEXT_MIN_HEIGHT = 84;
const FREE_TEXT_MAX_HEIGHT = 158;
const PREVIEW_MAX_HEIGHT = 220;

interface QuestionOptionRowProps {
  checked: boolean;
  label: string;
  description?: string;
  onSelect: () => void;
  shortcut?: QuestionShortcut;
}

function useAutoGrow(
  ref: RefObject<HTMLTextAreaElement | null>,
  { minHeight, maxHeight }: { minHeight: number; maxHeight: number },
) {
  return useCallback(
    (textarea?: HTMLTextAreaElement | null) => {
      const element = textarea ?? ref.current;
      if (!element) return;
      element.style.height = "auto";
      element.style.height = `${Math.min(
        Math.max(element.scrollHeight, minHeight),
        maxHeight,
      )}px`;
    },
    [maxHeight, minHeight, ref],
  );
}

function QuestionOptionRow({
  checked,
  label,
  description,
  onSelect,
  shortcut,
}: QuestionOptionRowProps) {
  return (
    <button
      type="button"
      aria-pressed={checked}
      aria-keyshortcuts={shortcut?.ariaKeyshortcuts}
      onClick={onSelect}
      className={cn(
        "flex w-full items-start gap-3 rounded-md px-2 py-2 text-left transition-colors",
        checked ? "bg-surface-selected" : "hover:bg-state-hover",
      )}
    >
      {/* The key cap doubles as the radio or checkbox. */}
      <kbd
        aria-hidden="true"
        className={cn(
          "flex size-5 shrink-0 items-center justify-center rounded-md border font-sans text-xs font-medium",
          checked
            ? "border-primary bg-primary/10 text-primary-text"
            : "border-foreground/15 text-muted-foreground",
        )}
      >
        {shortcut ? (
          shortcut.label
        ) : checked ? (
          <Icon name="Check" className="size-3" />
        ) : null}
      </kbd>
      <span className="min-w-0 flex-1">
        <span className="block text-sm font-medium text-foreground">
          {label}
        </span>
        {description ? (
          <span className="mt-0.5 block text-xs leading-snug text-muted-foreground">
            {description}
          </span>
        ) : null}
      </span>
    </button>
  );
}

function QuestionOptionPreview({ preview }: { preview: string }) {
  return (
    <pre
      className="mx-2.5 mb-1 mt-1 overflow-auto whitespace-pre-wrap break-words rounded-md border border-border bg-surface-raised px-2.5 py-2 font-mono text-xs leading-relaxed text-foreground"
      style={{ maxHeight: `${PREVIEW_MAX_HEIGHT}px` }}
    >
      {preview}
    </pre>
  );
}

interface QuestionTabsProps {
  currentIndex: number;
  formState: QuestionFormState;
  onSelect: (index: number) => void;
  questions: readonly Question[];
  trailing: ReactNode;
}

function QuestionTabs({
  currentIndex,
  formState,
  onSelect,
  questions,
  trailing,
}: QuestionTabsProps) {
  return (
    <div className="mb-3 flex shrink-0 items-center gap-3">
      <div className="flex min-w-0 flex-1 items-center gap-4 overflow-x-auto">
        {questions.map((question, index) => {
          const answered = isQuestionAnswered(
            question,
            answerStateFor(formState, question),
          );
          const isActive = index === currentIndex;
          return (
            <button
              key={question.id}
              type="button"
              onClick={() => onSelect(index)}
              aria-pressed={isActive}
              title={question.prompt}
              className={cn(
                "flex shrink-0 items-center gap-1 rounded-sm text-xs font-medium transition-colors focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring",
                isActive
                  ? "text-foreground"
                  : "text-subtle-foreground hover:text-foreground",
              )}
            >
              {answered ? (
                <Icon
                  name="Check"
                  className="size-3 text-primary-text"
                  aria-hidden
                />
              ) : null}
              <span className="truncate" style={{ maxWidth: "180px" }}>
                {question.shortLabel}
              </span>
            </button>
          );
        })}
      </div>
      {trailing}
    </div>
  );
}

interface QuestionInputBlockProps {
  disabled: boolean;
  question: Question;
  state: QuestionAnswerState;
  onToggleOption: (optionValue: string) => void;
  onSelectOther: () => void;
  onFreeTextChange: (value: string) => void;
  onShortcutSubmit: () => void;
  shortcuts: ReadonlyMap<string, QuestionShortcut>;
  trailing: ReactNode;
}

function QuestionInputBlock({
  disabled,
  question,
  state,
  onToggleOption,
  onSelectOther,
  onFreeTextChange,
  onShortcutSubmit,
  shortcuts,
  trailing,
}: QuestionInputBlockProps) {
  const freeTextRef = useRef<HTMLTextAreaElement>(null);
  const isPointerCoarse = usePointerCoarse();
  const resizeFreeTextArea = useAutoGrow(freeTextRef, {
    minHeight: FREE_TEXT_MIN_HEIGHT,
    maxHeight: FREE_TEXT_MAX_HEIGHT,
  });
  const options = question.options;
  // A note after the question itself reads lighter: "Pick one? It changes X."
  const noteStart = question.prompt.indexOf("? ") + 1;
  const freeTextLabel = `${question.shortLabel} answer`;

  useLayoutEffect(() => {
    if (!state.otherSelected) return;
    resizeFreeTextArea();
  }, [question.id, resizeFreeTextArea, state.otherSelected, state.otherText]);

  const handleFreeTextKeyDown = (
    event: KeyboardEvent<HTMLTextAreaElement>,
  ): void => {
    if (
      event.nativeEvent.isComposing ||
      event.key !== "Enter" ||
      (!event.metaKey && !event.ctrlKey)
    ) {
      return;
    }
    event.preventDefault();
    onShortcutSubmit();
  };

  return (
    <fieldset disabled={disabled} className="min-w-0">
      <legend className="sr-only">{question.prompt}</legend>
      <div className="flex items-start gap-3">
        <div className="min-w-0 flex-1 text-base font-semibold leading-snug text-foreground">
          {noteStart > 0
            ? question.prompt.slice(0, noteStart)
            : question.prompt}
          {noteStart > 0 ? (
            <span className="font-normal text-muted-foreground">
              {question.prompt.slice(noteStart)}
            </span>
          ) : null}
        </div>
        {trailing}
      </div>
      <div className="mt-2.5 -mx-2 space-y-0.5">
        {options.map((option: QuestionOption, index) => {
          const checked = state.selected.includes(option.value);
          return (
            <div key={option.value}>
              <QuestionOptionRow
                checked={checked}
                label={option.label}
                description={option.description}
                onSelect={() => onToggleOption(option.value)}
                shortcut={shortcuts.get(String(index))}
              />
              {checked && option.preview ? (
                <QuestionOptionPreview preview={option.preview} />
              ) : null}
            </div>
          );
        })}
        {question.allowFreeText && options.length > 0 ? (
          <QuestionOptionRow
            checked={state.otherSelected}
            label={OTHER_OPTION_LABEL}
            onSelect={onSelectOther}
            shortcut={shortcuts.get(String(options.length))}
          />
        ) : null}
      </div>
      {state.otherSelected ? (
        <textarea
          ref={freeTextRef}
          aria-label={freeTextLabel}
          value={state.otherText}
          rows={1}
          autoFocus={!isPointerCoarse}
          autoComplete="off"
          onChange={(event) => {
            onFreeTextChange(event.target.value);
            resizeFreeTextArea(event.target);
          }}
          onKeyDown={handleFreeTextKeyDown}
          placeholder="Type your own answer…"
          className="mt-2 w-full resize-none overflow-y-auto rounded-md border border-border bg-surface-raised px-3 py-2 text-sm leading-relaxed text-foreground placeholder:text-muted-foreground focus-visible:border-ring/50 focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring/40"
          style={{
            minHeight: `${FREE_TEXT_MIN_HEIGHT}px`,
            maxHeight: `${FREE_TEXT_MAX_HEIGHT}px`,
          }}
        />
      ) : null}
    </fieldset>
  );
}

export interface QuestionFormProps {
  questions: readonly Question[];
  disabled: boolean;
  cancelDisabled: boolean;
  onSubmit: (answers: Record<string, QuestionAnswer>) => void;
  onCancel: () => void;
}

export function QuestionForm({
  questions,
  disabled,
  cancelDisabled,
  onSubmit,
  onCancel,
}: QuestionFormProps) {
  const [formState, setFormState] = useState<QuestionFormState>(() =>
    createInitialFormState(questions),
  );
  const [currentIndex, setCurrentIndex] = useState(0);
  const { shortcuts, registerChoiceHandler } = useQuestionFormHost();

  const totalQuestions = questions.length;
  const currentQuestion = questions[currentIndex] ?? null;
  const isAnswered = (question: Question, state: QuestionFormState): boolean =>
    isQuestionAnswered(question, answerStateFor(state, question));
  const allAnswered =
    totalQuestions > 0 &&
    questions.every((question) => isAnswered(question, formState));

  // Submits once nothing is left, else moves to the next open question.
  const advance = (state: QuestionFormState): void => {
    if (disabled) return;
    const open = questions.flatMap((question, index) =>
      isAnswered(question, state) ? [] : [index],
    );
    if (open.length === 0) {
      onSubmit(buildQuestionAnswers(questions, state));
      return;
    }
    setCurrentIndex(
      open.find((index) => index > currentIndex) ?? open[0] ?? currentIndex,
    );
  };

  const pickOption = (question: Question, optionValue: string): void => {
    const state = answerStateFor(formState, question);
    const selected = !question.multiSelect
      ? [optionValue]
      : state.selected.includes(optionValue)
        ? state.selected.filter((value) => value !== optionValue)
        : [...state.selected, optionValue];
    const next = {
      ...formState,
      [question.id]: {
        ...state,
        selected,
        otherSelected: question.multiSelect && state.otherSelected,
      },
    };
    setFormState(next);
    // One key answers a plain single-select question. Anything the user may
    // still want to adjust (several picks, a preview) waits for the button.
    // A form that was already complete is only sent by the button.
    if (
      question.multiSelect ||
      question.options.some((option) => option.preview) ||
      allAnswered
    ) {
      return;
    }
    advance(next);
  };

  const selectOther = (question: Question): void => {
    const state = answerStateFor(formState, question);
    setFormState({
      ...formState,
      [question.id]: question.multiSelect
        ? { ...state, otherSelected: !state.otherSelected }
        : { ...state, selected: [], otherSelected: true },
    });
  };

  const onChoice = useEffectEvent((index: number): boolean => {
    if (currentQuestion === null) return false;
    const choice = resolveQuestionShortcutChoice(currentQuestion, index);
    if (!choice) return false;
    if (choice.kind === "option") pickOption(currentQuestion, choice.value);
    else selectOther(currentQuestion);
    return true;
  });
  useEffect(() => {
    if (disabled) return;
    return registerChoiceHandler((index) => onChoice(index));
  }, [disabled, registerChoiceHandler]);

  if (!currentQuestion) return null;

  const currentState = answerStateFor(formState, currentQuestion);
  const needsButton =
    allAnswered ||
    currentQuestion.multiSelect ||
    currentState.otherSelected ||
    currentQuestion.options.some((option) => option.preview);
  const isLastOpen = questions.every(
    (question, index) =>
      index === currentIndex || isAnswered(question, formState),
  );
  const confirm = (): void => {
    if (isAnswered(currentQuestion, formState)) advance(formState);
  };
  const cancelButton = (
    <Button
      type="button"
      size="sm"
      variant="ghost"
      disabled={cancelDisabled}
      onClick={onCancel}
      className="-my-1 -mr-2 h-6 shrink-0 px-2 font-normal text-subtle-foreground"
    >
      Cancel
    </Button>
  );

  return (
    <div className="flex max-h-[calc(100dvh-6rem)] min-h-0 flex-col text-xs text-muted-foreground">
      {totalQuestions > 1 ? (
        <QuestionTabs
          currentIndex={currentIndex}
          formState={formState}
          onSelect={setCurrentIndex}
          questions={questions}
          trailing={cancelButton}
        />
      ) : null}
      <div className="min-h-0 touch-pan-y overflow-y-auto overscroll-contain px-2 -mx-2">
        <QuestionInputBlock
          disabled={disabled}
          question={currentQuestion}
          state={currentState}
          onToggleOption={(optionValue) =>
            pickOption(currentQuestion, optionValue)
          }
          onSelectOther={() => selectOther(currentQuestion)}
          onFreeTextChange={(value) =>
            setFormState({
              ...formState,
              [currentQuestion.id]: { ...currentState, otherText: value },
            })
          }
          onShortcutSubmit={confirm}
          shortcuts={shortcuts}
          trailing={totalQuestions > 1 ? null : cancelButton}
        />
      </div>
      {needsButton ? (
        <div className="mt-3 flex shrink-0 items-center justify-between gap-2">
          <span>
            {currentQuestion.multiSelect ? "Pick any that apply" : null}
          </span>
          <Button
            type="button"
            size="sm"
            disabled={disabled || !isAnswered(currentQuestion, formState)}
            onClick={confirm}
          >
            {disabled ? (
              <Icon name="Spinner" className="size-3 animate-spin" />
            ) : null}
            {isLastOpen ? "Submit" : "Next"}
          </Button>
        </div>
      ) : null}
    </div>
  );
}
