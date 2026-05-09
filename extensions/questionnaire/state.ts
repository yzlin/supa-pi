import type { Answer, Question, RenderOption } from "./types";

export interface QuestionnaireRuntimeState {
  currentTab: number;
  optionIndex: number;
  inputMode: boolean;
  inputQuestionId: string | null;
  notesMode: boolean;
  noteQuestionId: string | null;
  noteDrafts: Map<string, string>;
  answers: Map<string, Answer>;
  multiSelections: Map<string, Set<string>>;
}

export type QuestionnaireRuntimeEffect =
  | { type: "none" }
  | { type: "refresh" }
  | { type: "submit"; cancelled: boolean }
  | { type: "startInput"; questionId: string }
  | { type: "startNote"; questionId: string }
  | { type: "clearInput" };

export type QuestionnaireRuntimeAction =
  | { type: "cancel" }
  | { type: "moveOption"; delta: -1 | 1; optionCount: number }
  | { type: "moveTab"; delta: -1 | 1; totalTabs: number }
  | { type: "submitIfReady"; ready: boolean }
  | {
      type: "selectOption";
      question: Question;
      option: RenderOption;
      optionIndex: number;
    }
  | { type: "saveCustomAnswer"; questionId: string; value: string }
  | { type: "startNote"; questionId: string }
  | { type: "saveNoteDraft"; questionId: string; value: string }
  | { type: "exitInput" };

export function createQuestionnaireRuntimeState(): QuestionnaireRuntimeState {
  return {
    currentTab: 0,
    optionIndex: 0,
    inputMode: false,
    inputQuestionId: null,
    notesMode: false,
    noteQuestionId: null,
    noteDrafts: new Map(),
    answers: new Map(),
    multiSelections: new Map(),
  };
}

export function isAllAnswered(
  questions: Question[],
  answers: Map<string, Answer>
): boolean {
  return questions.every((question) => answers.has(question.id));
}

export function advanceAfterAnswer(
  state: QuestionnaireRuntimeState,
  questions: Question[]
): QuestionnaireRuntimeState {
  if (questions.length <= 1) {
    return state;
  }

  return {
    ...state,
    currentTab:
      state.currentTab < questions.length - 1
        ? state.currentTab + 1
        : questions.length,
    optionIndex: 0,
  };
}

function withAnswer(
  state: QuestionnaireRuntimeState,
  answer: Answer,
  questions: Question[]
): QuestionnaireRuntimeState {
  const answers = new Map(state.answers);
  answers.set(answer.id, answer);
  return advanceAfterAnswer(
    {
      ...state,
      answers,
      inputMode: false,
      inputQuestionId: null,
    },
    questions
  );
}

export function reduceQuestionnaireRuntime(
  state: QuestionnaireRuntimeState,
  action: QuestionnaireRuntimeAction,
  questions: Question[]
): { state: QuestionnaireRuntimeState; effect: QuestionnaireRuntimeEffect } {
  switch (action.type) {
    case "cancel":
      return { state, effect: { type: "submit", cancelled: true } };
    case "moveOption":
      return {
        state: {
          ...state,
          optionIndex:
            action.optionCount <= 0
              ? 0
              : (state.optionIndex + action.delta + action.optionCount) %
                action.optionCount,
        },
        effect: { type: "refresh" },
      };
    case "moveTab":
      return {
        state: {
          ...state,
          currentTab:
            (state.currentTab + action.delta + action.totalTabs) %
            action.totalTabs,
          optionIndex: 0,
        },
        effect: { type: "refresh" },
      };
    case "submitIfReady":
      return {
        state,
        effect: action.ready
          ? { type: "submit", cancelled: false }
          : { type: "none" },
      };
    case "selectOption": {
      const { option, question } = action;
      if (question.multiSelect === true) {
        if (option.isNext === true) {
          const selectedValues =
            state.multiSelections.get(question.id) ?? new Set();
          const selectedOptions = question.options
            .map((item, index) => ({ ...item, index: index + 1 }))
            .filter((item) => selectedValues.has(item.value));
          const nextState = withAnswer(
            state,
            {
              kind: "multi",
              id: question.id,
              value: selectedOptions.map((item) => item.value),
              label: selectedOptions.map((item) => item.label).join(", "),
              wasCustom: false,
              multi: true,
              selectedOptions,
            },
            questions
          );
          return {
            state: nextState,
            effect:
              questions.length <= 1
                ? { type: "submit", cancelled: false }
                : { type: "refresh" },
          };
        }

        const multiSelections = new Map(state.multiSelections);
        const current = new Set(multiSelections.get(question.id) ?? []);
        if (current.has(option.value)) {
          current.delete(option.value);
        } else {
          current.add(option.value);
        }
        multiSelections.set(question.id, current);
        return {
          state: { ...state, multiSelections },
          effect: { type: "refresh" },
        };
      }

      if (option.isOther === true) {
        return {
          state: {
            ...state,
            inputMode: true,
            inputQuestionId: question.id,
          },
          effect: { type: "startInput", questionId: question.id },
        };
      }
      const note = state.noteDrafts.get(question.id)?.trim();
      const nextState = withAnswer(
        state,
        {
          kind: "option",
          id: question.id,
          value: option.value,
          label: option.label,
          wasCustom: false,
          index: action.optionIndex + 1,
          preview: option.preview,
          ...(note ? { note } : {}),
        },
        questions
      );
      return {
        state: nextState,
        effect:
          questions.length <= 1
            ? { type: "submit", cancelled: false }
            : { type: "refresh" },
      };
    }
    case "saveCustomAnswer": {
      const trimmed = action.value.trim();
      if (!trimmed) {
        return { state, effect: { type: "refresh" } };
      }
      const note = state.noteDrafts.get(action.questionId)?.trim();
      const nextState = withAnswer(
        state,
        {
          kind: "custom",
          id: action.questionId,
          value: trimmed,
          label: trimmed,
          wasCustom: true,
          ...(note ? { note } : {}),
        },
        questions
      );
      return {
        state: nextState,
        effect:
          questions.length <= 1
            ? { type: "submit", cancelled: false }
            : { type: "clearInput" },
      };
    }
    case "startNote":
      return {
        state: {
          ...state,
          notesMode: true,
          noteQuestionId: action.questionId,
        },
        effect: { type: "startNote", questionId: action.questionId },
      };
    case "saveNoteDraft": {
      const noteDrafts = new Map(state.noteDrafts);
      noteDrafts.set(action.questionId, action.value);
      return {
        state: {
          ...state,
          notesMode: false,
          noteQuestionId: null,
          noteDrafts,
        },
        effect: { type: "clearInput" },
      };
    }
    case "exitInput":
      return {
        state: {
          ...state,
          inputMode: false,
          inputQuestionId: null,
          notesMode: false,
          noteQuestionId: null,
        },
        effect: { type: "clearInput" },
      };
  }
}
