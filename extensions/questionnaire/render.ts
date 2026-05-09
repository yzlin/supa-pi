import type { Editor } from "@earendil-works/pi-tui";
import { truncateToWidth, visibleWidth } from "@earendil-works/pi-tui";

import { isAllAnswered, type QuestionnaireRuntimeState } from "./state";
import { wrapQuestionnaireText } from "./text";
import type { Question, RenderOption } from "./types";

const PREVIEW_OPENING_CODE_FENCE_REGEX = /^```[\w-]*\s*$/;
const PREVIEW_CLOSING_CODE_FENCE_REGEX = /^```\s*$/;

interface QuestionnaireTheme {
  fg(color: string, text: string): string;
  bg(color: string, text: string): string;
  bold(text: string): string;
}

export function renderQuestionnaireRuntime(args: {
  width: number;
  theme: QuestionnaireTheme;
  questions: Question[];
  state: QuestionnaireRuntimeState;
  options: RenderOption[];
  editor: Editor;
  previewEnabled?: boolean;
}): string[] {
  const { width, theme, questions, state, options, editor, previewEnabled } =
    args;
  const lines: string[] = [];
  const question = questions[state.currentTab];
  const isMulti = questions.length > 1;

  const add = (text: string) => lines.push(truncateToWidth(text, width));
  const addWrapped = (text: string, indent: string, color: string) => {
    const contentWidth = Math.max(1, width - indent.length);
    for (const line of wrapQuestionnaireText(text, contentWidth)) {
      add(`${indent}${theme.fg(color, line)}`);
    }
  };

  add(theme.fg("accent", "─".repeat(width)));

  if (isMulti) {
    renderTabs({ add, theme, questions, state });
    lines.push("");
  }

  const selectedOption = options[state.optionIndex];
  const previewText =
    selectedOption?.isOther === true
      ? "Custom answer preview will appear after you type it."
      : selectedOption?.preview;

  const renderPreviewPane = (paneWidth = width) => {
    add(theme.fg("muted", " Preview"));
    const contentWidth = Math.max(1, paneWidth - 1);
    if (previewText) {
      for (const line of wrapPreviewText(previewText, contentWidth)) {
        add(` ${theme.fg("text", line)}`);
      }
    } else {
      add(theme.fg("dim", " No preview available."));
    }
    const note = question ? state.noteDrafts.get(question.id)?.trim() : "";
    if (note) {
      add(theme.fg("muted", " Note"));
      for (const line of wrapQuestionnaireText(note, contentWidth)) {
        add(` ${theme.fg("text", line)}`);
      }
    }
  };

  const formatOptionLine = (option: RenderOption, index: number) => {
    const selected = index === state.optionIndex;
    const prefix = selected ? theme.fg("accent", "> ") : "  ";
    const color = selected ? "accent" : "text";
    if (question?.multiSelect === true) {
      const checked = state.multiSelections.get(question.id)?.has(option.value);
      let marker = "☐ ";
      if (option.isNext === true) {
        marker = "  ";
      } else if (checked) {
        marker = "☑ ";
      }
      return prefix + theme.fg(color, `${marker}${option.label}`);
    }
    if (option.isOther === true && state.inputMode) {
      return prefix + theme.fg("accent", `${index + 1}. ${option.label} ✎`);
    }
    return prefix + theme.fg(color, `${index + 1}. ${option.label}`);
  };

  const renderOptions = () => {
    for (let index = 0; index < options.length; index++) {
      const option = options[index];
      add(formatOptionLine(option, index));
      if (option.description) {
        addWrapped(option.description, "     ", "muted");
      }
    }
  };

  if (state.notesMode && question) {
    addWrapped(question.prompt, " ", "text");
    lines.push("");
    renderOptions();
    lines.push("");
    add(theme.fg("muted", " Preview note:"));
    for (const line of editor.render(width - 2)) {
      add(` ${line}`);
    }
    lines.push("");
    add(theme.fg("dim", " Enter to save note • Esc to cancel"));
  } else if (state.inputMode && question) {
    addWrapped(question.prompt, " ", "text");
    lines.push("");
    renderOptions();
    lines.push("");
    add(theme.fg("muted", " Your answer:"));
    for (const line of editor.render(width - 2)) {
      add(` ${line}`);
    }
    lines.push("");
    add(theme.fg("dim", " Enter to submit • Esc to cancel"));
  } else if (state.currentTab === questions.length) {
    add(theme.fg("accent", theme.bold(" Review answers")));
    lines.push("");
    for (const item of questions) {
      const answer = state.answers.get(item.id);
      if (answer) {
        const prefix = answer.wasCustom ? "(wrote) " : "";
        const label =
          answer.kind === "multi" ? answer.label || "(none)" : answer.label;
        add(
          `${theme.fg("muted", ` ${item.label}: `)}${theme.fg("text", prefix + label)}`
        );
      }
    }
    lines.push("");
    const allAnswered = isAllAnswered(questions, state.answers);
    if (!allAnswered) {
      const missing = questions
        .filter((item) => !state.answers.has(item.id))
        .map((item) => item.label)
        .join(", ");
      add(theme.fg("warning", ` Unanswered: ${missing}`));
      lines.push("");
    }
    renderSubmitPicker({
      add,
      theme,
      selectedIndex: state.optionIndex,
      allAnswered,
    });
  } else if (question) {
    addWrapped(question.prompt, " ", "text");
    lines.push("");
    if (previewEnabled === true && question.multiSelect !== true) {
      if (width >= 96) {
        const leftWidth = Math.floor((width - 3) / 2);
        const rightWidth = width - leftWidth - 3;
        const leftLines = [theme.fg("muted", " Options")];
        for (let optionIndex = 0; optionIndex < options.length; optionIndex++) {
          const option = options[optionIndex];
          leftLines.push(formatOptionLine(option, optionIndex));
          if (option.description) {
            for (const line of wrapQuestionnaireText(
              option.description,
              Math.max(1, leftWidth - 5)
            )) {
              leftLines.push(`     ${theme.fg("muted", line)}`);
            }
          }
        }
        const rightLines = [theme.fg("muted", " Preview")];
        if (previewText) {
          rightLines.push(
            ...wrapPreviewText(previewText, rightWidth - 1).map((line) =>
              theme.fg("text", ` ${line}`)
            )
          );
        } else {
          rightLines.push(theme.fg("dim", " No preview available."));
        }
        const rowCount = Math.max(leftLines.length, rightLines.length);
        for (let index = 0; index < rowCount; index++) {
          const left = padToVisibleWidth(leftLines[index] ?? "", leftWidth);
          const right = truncateToWidth(rightLines[index] ?? "", rightWidth);
          add(`${left} │ ${right}`);
        }
      } else {
        renderOptions();
        lines.push("");
        renderPreviewPane(width);
      }
    } else {
      renderOptions();
    }
  }

  lines.push("");
  if (!state.inputMode) {
    let help = " ↑↓ navigate • Enter select • Esc cancel";
    if (question?.multiSelect === true) {
      help = " ↑↓ navigate • Space/Enter toggle • Next commits • Esc cancel";
    } else if (previewEnabled === true && question) {
      help = " ↑↓ navigate • Enter confirm • n notes • Esc cancel";
    } else if (isMulti) {
      help = " Tab/←→ navigate • ↑↓ select • Enter confirm • Esc cancel";
    }
    add(theme.fg("dim", help));
  }
  add(theme.fg("accent", "─".repeat(width)));

  return lines;
}

function stripOuterCodeFence(text: string): string {
  const lines = text.split("\n");
  if (
    lines.length >= 2 &&
    PREVIEW_OPENING_CODE_FENCE_REGEX.test(lines[0].trim()) &&
    PREVIEW_CLOSING_CODE_FENCE_REGEX.test(lines.at(-1)?.trim() ?? "")
  ) {
    return lines.slice(1, -1).join("\n");
  }
  return text;
}

function wrapPreviewText(text: string, width: number): string[] {
  return wrapQuestionnaireText(stripOuterCodeFence(text), width);
}

function padToVisibleWidth(text: string, width: number): string {
  const truncated = truncateToWidth(text, width);
  return `${truncated}${" ".repeat(Math.max(0, width - visibleWidth(truncated)))}`;
}

function renderSubmitPicker(args: {
  add(text: string): void;
  theme: QuestionnaireTheme;
  selectedIndex: number;
  allAnswered: boolean;
}) {
  const { add, theme, selectedIndex, allAnswered } = args;
  const items = [
    {
      label: allAnswered ? "Submit" : "Submit (answer all questions first)",
      color: allAnswered ? "success" : "dim",
    },
    { label: "Cancel", color: "warning" },
  ];

  for (let index = 0; index < items.length; index++) {
    const item = items[index];
    const selected = index === selectedIndex;
    const prefix = selected ? theme.fg("accent", "> ") : "  ";
    const color = selected ? "accent" : item.color;
    add(prefix + theme.fg(color, item.label));
  }
}

function renderTabs(args: {
  add(text: string): void;
  theme: QuestionnaireTheme;
  questions: Question[];
  state: QuestionnaireRuntimeState;
}) {
  const { add, theme, questions, state } = args;
  const tabs: string[] = ["← "];
  for (let index = 0; index < questions.length; index++) {
    const active = index === state.currentTab;
    const answered = state.answers.has(questions[index].id);
    const label = questions[index].label;
    const box = answered ? "■" : "□";
    const color = answered ? "success" : "muted";
    const text = ` ${box} ${label} `;
    const styled = active
      ? theme.bg("selectedBg", theme.fg("text", text))
      : theme.fg(color, text);
    tabs.push(`${styled} `);
  }
  const canSubmit = isAllAnswered(questions, state.answers);
  const submitActive = state.currentTab === questions.length;
  const submitText = " ✓ Submit ";
  const submitStyled = submitActive
    ? theme.bg("selectedBg", theme.fg("text", submitText))
    : theme.fg(canSubmit ? "success" : "dim", submitText);
  tabs.push(`${submitStyled} →`);
  add(` ${tabs.join("")}`);
}
