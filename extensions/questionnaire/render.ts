import type { Editor } from "@earendil-works/pi-tui";
import { truncateToWidth, visibleWidth } from "@earendil-works/pi-tui";

import { isAllAnswered, type QuestionnaireRuntimeState } from "./state";
import { stripTerminalControlsUpTo, wrapQuestionnaireText } from "./text";
import type { Question, RenderOption } from "./types";

const PREVIEW_OPENING_CODE_FENCE_REGEX = /^```[\w-]*\s*$/;
const PREVIEW_CLOSING_CODE_FENCE_REGEX = /^```\s*$/;
const OPTION_TITLE_MIN_WIDTH = 24;
const OPTION_PREVIEW_MIN_WIDTH = 12;
const OPTION_COLUMN_GUTTER_WIDTH = 3;
const OPTION_TITLE_SPLIT = 0.45;
const OPTION_PREVIEW_MAX_LINES = 6;
const OPTION_LABEL_MAX_LINES = 6;
const NOTE_PREVIEW_MAX_LINES = 6;

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

  const notePreviewLinesByWidth = new Map<number, string[]>();
  const getNotePreviewLines = (paneWidth = width) => {
    const cachedPreviewLines = notePreviewLinesByWidth.get(paneWidth);
    if (cachedPreviewLines !== undefined) {
      return cachedPreviewLines;
    }

    const note = question ? state.noteDrafts.get(question.id) : undefined;
    const contentWidth = Math.max(1, paneWidth - 1);
    const wrappedNoteLines = note
      ? wrapCappedQuestionnaireText(note, contentWidth, NOTE_PREVIEW_MAX_LINES)
      : [];
    const previewLines = wrappedNoteLines.some((line) => line.trim().length > 0)
      ? wrappedNoteLines
      : [];
    notePreviewLinesByWidth.set(paneWidth, previewLines);
    return previewLines;
  };

  const renderNoteDraft = (paneWidth = width) => {
    const noteLines = getNotePreviewLines(paneWidth);
    if (noteLines.length === 0) {
      return;
    }
    add(theme.fg("muted", " Note"));
    for (const line of noteLines) {
      add(` ${theme.fg("text", line)}`);
    }
  };

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
    renderNoteDraft(paneWidth);
  };

  const formatOptionBlock = (option: RenderOption, index: number) =>
    formatOptionBlockForWidth(
      option,
      index,
      width,
      index === state.optionIndex,
      question,
      state,
      theme
    );

  const renderOptions = () => {
    for (let index = 0; index < options.length; index++) {
      for (const line of formatOptionBlock(options[index], index)) {
        add(line);
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
      const columnWidths = getOptionColumnWidths(width);
      if (columnWidths) {
        const { titleWidth, previewWidth } = columnWidths;
        const headerLeft = padToVisibleWidth(
          theme.fg("muted", " Options"),
          titleWidth
        );
        add(`${headerLeft} │ ${theme.fg("muted", " Preview")}`);
        for (let optionIndex = 0; optionIndex < options.length; optionIndex++) {
          const option = options[optionIndex];
          const selected = optionIndex === state.optionIndex;
          const leftLines = formatOptionBlockForWidth(
            option,
            optionIndex,
            titleWidth,
            selected,
            question,
            state,
            theme
          );
          const previewLines = getOptionPreviewLines(
            option,
            previewWidth,
            selected,
            theme
          );
          const rowCount = Math.max(leftLines.length, previewLines.length);
          for (let rowIndex = 0; rowIndex < rowCount; rowIndex++) {
            const left = padToVisibleWidth(
              leftLines[rowIndex] ?? "",
              titleWidth
            );
            const right = truncateToWidth(
              previewLines[rowIndex] ?? "",
              previewWidth
            );
            add(`${left} │ ${right}`);
          }
        }
        if (getNotePreviewLines(width).length > 0) {
          lines.push("");
          renderNoteDraft(width);
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

function prepareCappedPreviewText(
  text: string,
  maxChars: number
): { text: string; truncated: boolean } {
  const sanitized = stripTerminalControlsUpTo(text, maxChars + 1);
  const firstLineEnd = sanitized.text.indexOf("\n");
  const firstLine =
    firstLineEnd === -1
      ? sanitized.text
      : sanitized.text.slice(0, firstLineEnd);
  const startsWithCodeFence = PREVIEW_OPENING_CODE_FENCE_REGEX.test(
    firstLine.trim()
  );
  const suffixWindow = stripTerminalControlsUpTo(
    text.slice(-(maxChars + 1)),
    maxChars + 1
  ).text;
  const lastLineStart = suffixWindow.lastIndexOf("\n");
  const lastLine =
    lastLineStart === -1 ? suffixWindow : suffixWindow.slice(lastLineStart + 1);
  const hasOuterClosingFence =
    startsWithCodeFence &&
    PREVIEW_CLOSING_CODE_FENCE_REGEX.test(lastLine.trim());
  const previewText = hasOuterClosingFence
    ? sanitized.text.slice(firstLineEnd + 1)
    : sanitized.text;
  const strippedText = hasOuterClosingFence
    ? stripTrailingOuterClosingFence(previewText)
    : previewText;
  const truncated = sanitized.truncated || strippedText.length > maxChars;

  return {
    text: truncated ? `${strippedText.slice(0, maxChars)}…` : strippedText,
    truncated,
  };
}

function wrapPreviewText(
  text: string,
  width: number,
  options: { maxLines?: number } = {}
): string[] {
  if (!options.maxLines) {
    return wrapQuestionnaireText(stripOuterCodeFence(text), width);
  }

  const maxChars = Math.max(1, width) * options.maxLines;
  const cappedText = prepareCappedPreviewText(text, maxChars).text;
  return capWrappedLines(
    wrapQuestionnaireText(cappedText, width),
    width,
    options.maxLines
  );
}

function stripTrailingOuterClosingFence(text: string): string {
  const lines = text.split("\n");
  const lastLine = lines.at(-1);
  if (
    lastLine !== undefined &&
    PREVIEW_CLOSING_CODE_FENCE_REGEX.test(lastLine.trim())
  ) {
    return lines.slice(0, -1).join("\n");
  }
  return text;
}

function wrapCappedQuestionnaireText(
  text: string,
  width: number,
  maxLines: number
): string[] {
  const maxChars = Math.max(1, width) * maxLines;
  const sanitized = stripTerminalControlsUpTo(text, maxChars + 1);
  const truncated = sanitized.truncated || sanitized.text.length > maxChars;
  const cappedText = truncated
    ? `${sanitized.text.slice(0, maxChars)}…`
    : sanitized.text;
  return capWrappedLines(
    wrapQuestionnaireText(cappedText, width),
    width,
    maxLines
  );
}

function capWrappedLines(
  lines: string[],
  width: number,
  maxLines: number
): string[] {
  if (lines.length <= maxLines) {
    return lines;
  }

  const cappedLines = lines.slice(0, maxLines);
  cappedLines[cappedLines.length - 1] = truncateToWidth(
    `${cappedLines.at(-1)}…`,
    width
  );
  return cappedLines;
}

function getOptionColumnWidths(
  width: number
): { titleWidth: number; previewWidth: number } | null {
  const contentWidth = width - OPTION_COLUMN_GUTTER_WIDTH;
  if (contentWidth < 2) {
    return null;
  }

  if (contentWidth < OPTION_TITLE_MIN_WIDTH + 1) {
    return { titleWidth: contentWidth - 1, previewWidth: 1 };
  }

  if (contentWidth < OPTION_TITLE_MIN_WIDTH + OPTION_PREVIEW_MIN_WIDTH) {
    return {
      titleWidth: OPTION_TITLE_MIN_WIDTH,
      previewWidth: contentWidth - OPTION_TITLE_MIN_WIDTH,
    };
  }

  let titleWidth = Math.round(contentWidth * OPTION_TITLE_SPLIT);
  let previewWidth = contentWidth - titleWidth;
  if (titleWidth < OPTION_TITLE_MIN_WIDTH) {
    titleWidth = OPTION_TITLE_MIN_WIDTH;
    previewWidth = contentWidth - titleWidth;
  }
  if (previewWidth < OPTION_PREVIEW_MIN_WIDTH) {
    previewWidth = OPTION_PREVIEW_MIN_WIDTH;
    titleWidth = contentWidth - previewWidth;
  }

  return { titleWidth, previewWidth };
}

function formatOptionBlockForWidth(
  option: RenderOption,
  index: number,
  width: number,
  selected: boolean,
  question: Question | undefined,
  state: QuestionnaireRuntimeState,
  theme: QuestionnaireTheme
): string[] {
  const cursor = selected ? "> " : "  ";
  let marker = `${index + 1}. `;
  if (question?.multiSelect === true) {
    const checked = state.multiSelections.get(question.id)?.has(option.value);
    marker = checked ? "☑ " : "☐ ";
    if (option.isNext === true) {
      marker = "  ";
    }
  }
  const title =
    option.isOther === true && state.inputMode
      ? `${option.label} ✎`
      : option.label;
  const color = selected ? "accent" : "text";
  const contentWidth = Math.max(1, width - visibleWidth(cursor + marker));
  const continuation = " ".repeat(visibleWidth(cursor + marker));
  const block = wrapCappedQuestionnaireText(
    title,
    contentWidth,
    OPTION_LABEL_MAX_LINES
  ).map((line, lineIndex) => {
    const prefix = lineIndex === 0 ? cursor + marker : continuation;
    return prefix + theme.fg(color, line);
  });

  if (option.description) {
    for (const line of wrapQuestionnaireText(
      option.description,
      contentWidth
    )) {
      block.push(continuation + theme.fg(selected ? "accent" : "muted", line));
    }
  }
  return block;
}

function getOptionPreviewLines(
  option: RenderOption,
  width: number,
  selected: boolean,
  theme: QuestionnaireTheme
): string[] {
  const preview =
    option.isOther === true
      ? "Custom answer preview will appear after you type it."
      : option.preview;
  if (!preview) {
    return [theme.fg(selected ? "accent" : "dim", " No preview available.")];
  }
  return wrapPreviewText(preview, Math.max(1, width - 1), {
    maxLines: OPTION_PREVIEW_MAX_LINES,
  }).map((line) => theme.fg(selected ? "accent" : "text", ` ${line}`));
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
