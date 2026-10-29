import type { ExtensionUIContext } from "@earendil-works/pi-coding-agent";
import { Editor, type EditorTheme } from "@earendil-works/pi-tui";

import { routeAskKey } from "./keys";
import { renderAskRuntime } from "./render";
import {
  createAskRuntimeState,
  isAllAnswered,
  reduceAskRuntime,
} from "./state";
import {
  type AskResult,
  CUSTOM_OPTION_LABEL,
  CUSTOM_OPTION_VALUE,
  NEXT_OPTION_LABEL,
  NEXT_OPTION_VALUE,
  type Question,
  type QuestionOption,
  type RenderOption,
} from "./types";

export function getRenderOptions(question: {
  multiSelect?: boolean;
  custom?: boolean;
  options: QuestionOption[];
}): RenderOption[] {
  if (question.multiSelect === true) {
    return [
      ...question.options,
      {
        value: NEXT_OPTION_VALUE,
        label: NEXT_OPTION_LABEL,
        isNext: true,
      },
    ];
  }

  if (question.custom === false) {
    return [...question.options];
  }

  return [
    ...question.options,
    {
      value: CUSTOM_OPTION_VALUE,
      label: CUSTOM_OPTION_LABEL,
      isOther: true,
    },
  ];
}

// The ask picker. Resolves undefined when the host cannot show custom UI
// (e.g. RPC or subagent children); an aborted signal cancels it.
export function showAskDialog(
  ui: Pick<ExtensionUIContext, "custom">,
  questions: Question[],
  signal?: AbortSignal,
): Promise<AskResult | undefined> {
  if (signal?.aborted) {
    return Promise.resolve({ questions, answers: [], cancelled: true });
  }
  return ui.custom<AskResult>((tui, theme, _kb, done) => {
    let state = createAskRuntimeState();
    let cachedLines: string[] | undefined;
    let finished = false;

    const editorTheme: EditorTheme = {
      borderColor: (s) => theme.fg("accent", s),
      selectList: {
        selectedPrefix: (t) => theme.fg("accent", t),
        selectedText: (t) => theme.fg("accent", t),
        description: (t) => theme.fg("muted", t),
        scrollInfo: (t) => theme.fg("dim", t),
        noMatch: (t) => theme.fg("warning", t),
      },
    };
    const editor = new Editor(tui, editorTheme);

    function refresh() {
      cachedLines = undefined;
      tui.requestRender();
    }

    function submit(cancelled: boolean) {
      if (finished) {
        return;
      }
      finished = true;
      signal?.removeEventListener("abort", onAbort);
      done({
        questions,
        answers: Array.from(state.answers.values()),
        cancelled,
      });
    }

    function onAbort() {
      submit(true);
    }
    signal?.addEventListener("abort", onAbort, { once: true });

    function currentQuestion(): Question | undefined {
      return questions[state.currentTab];
    }

    function questionHasPreview(question: Question | undefined): boolean {
      return (
        question?.options.some((option) => option.preview !== undefined) ===
        true
      );
    }

    function canUsePreview(): boolean {
      return questionHasPreview(currentQuestion());
    }

    function canUsePreviewNotes(): boolean {
      const question = currentQuestion();
      return (
        question !== undefined &&
        question.multiSelect !== true &&
        questionHasPreview(question)
      );
    }

    function currentOptions(): RenderOption[] {
      const question = currentQuestion();
      return question ? getRenderOptions(question) : [];
    }

    function applyEffect(
      effect: ReturnType<typeof reduceAskRuntime>["effect"],
    ) {
      if (effect.type === "submit") {
        submit(effect.cancelled);
        return;
      }
      if (effect.type === "startInput" || effect.type === "clearInput") {
        editor.setText("");
      }
      if (effect.type === "startNote") {
        editor.setText(state.noteDrafts.get(effect.questionId) ?? "");
      }
      if (effect.type !== "none") {
        refresh();
      }
    }

    function dispatch(action: Parameters<typeof reduceAskRuntime>[1]) {
      const reduced = reduceAskRuntime(state, action, questions);
      state = reduced.state;
      applyEffect(reduced.effect);
    }

    editor.onSubmit = (value) => {
      if (state.notesMode && state.noteQuestionId) {
        dispatch({
          type: "saveNoteDraft",
          questionId: state.noteQuestionId,
          value,
        });
        return;
      }
      if (!state.inputQuestionId) {
        return;
      }
      dispatch({
        type: "saveCustomAnswer",
        questionId: state.inputQuestionId,
        value,
      });
    };

    function handleInput(data: string) {
      const action = routeAskKey({
        data,
        state,
        questions,
        options: currentOptions(),
        allAnswered: isAllAnswered(questions, state.answers),
        previewNotesEnabled: canUsePreviewNotes(),
      });

      if (!action) {
        return;
      }
      if (action.type === "editor") {
        editor.handleInput(data);
        refresh();
        return;
      }
      dispatch(action);
    }

    function render(width: number): string[] {
      if (cachedLines) {
        return cachedLines;
      }

      cachedLines = renderAskRuntime({
        width,
        theme,
        questions,
        state,
        options: currentOptions(),
        editor,
        previewEnabled: canUsePreview(),
      });
      return cachedLines;
    }

    return {
      render,
      invalidate: () => {
        cachedLines = undefined;
      },
      handleInput,
    };
  });
}
