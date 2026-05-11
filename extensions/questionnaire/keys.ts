import { Key, type KeyId, matchesKey } from "@earendil-works/pi-tui";

import type {
  QuestionnaireRuntimeAction,
  QuestionnaireRuntimeState,
} from "./state";
import type { Question, RenderOption } from "./types";

function matchesNavigationKey(
  data: string,
  key: KeyId,
  vimKey: "h" | "j" | "k" | "l"
): boolean {
  return matchesKey(data, key) || data === vimKey;
}

export function routeQuestionnaireKey(args: {
  data: string;
  state: QuestionnaireRuntimeState;
  questions: Question[];
  options: RenderOption[];
  allAnswered: boolean;
  previewNotesEnabled?: boolean;
}): QuestionnaireRuntimeAction | { type: "editor" } | null {
  const { data, state, questions, options, allAnswered, previewNotesEnabled } =
    args;
  const optionCount = options.length;

  if (state.inputMode || state.notesMode) {
    if (matchesKey(data, Key.escape)) {
      return { type: "exitInput" };
    }
    return { type: "editor" };
  }

  const totalTabs = questions.length + 1;
  const isMulti = questions.length > 1;

  if (isMulti) {
    if (
      matchesKey(data, Key.tab) ||
      matchesNavigationKey(data, Key.right, "l")
    ) {
      return { type: "moveTab", delta: 1, totalTabs };
    }
    if (
      matchesKey(data, Key.shift("tab")) ||
      matchesNavigationKey(data, Key.left, "h")
    ) {
      return { type: "moveTab", delta: -1, totalTabs };
    }
  }

  if (state.currentTab === questions.length) {
    if (matchesNavigationKey(data, Key.up, "k")) {
      return { type: "moveOption", delta: -1, optionCount: 2 };
    }
    if (matchesNavigationKey(data, Key.down, "j")) {
      return { type: "moveOption", delta: 1, optionCount: 2 };
    }
    if (matchesKey(data, Key.enter)) {
      return state.optionIndex === 1
        ? { type: "cancel" }
        : { type: "submitIfReady", ready: allAnswered };
    }
    if (matchesKey(data, Key.escape)) {
      return { type: "cancel" };
    }
    return null;
  }

  if (data === "n" && previewNotesEnabled === true) {
    const question = questions[state.currentTab];
    return question ? { type: "startNote", questionId: question.id } : null;
  }

  if (matchesNavigationKey(data, Key.up, "k")) {
    return { type: "moveOption", delta: -1, optionCount };
  }
  if (matchesNavigationKey(data, Key.down, "j")) {
    return { type: "moveOption", delta: 1, optionCount };
  }
  if (matchesKey(data, Key.enter) || data === " ") {
    const question = questions[state.currentTab];
    if (!question) {
      return null;
    }
    const option = options[state.optionIndex];
    if (!option) {
      return null;
    }
    return {
      type: "selectOption",
      question,
      option,
      optionIndex: state.optionIndex,
    };
  }
  if (matchesKey(data, Key.escape)) {
    return { type: "cancel" };
  }

  return null;
}
