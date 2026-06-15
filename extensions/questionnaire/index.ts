/**
 * Questionnaire Tool - Unified tool for asking single or multiple questions
 *
 * Single question: simple options list
 * Multiple questions: tab bar navigation between questions
 */

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import {
  Editor,
  type EditorTheme,
  Text,
  truncateToWidth,
} from "@earendil-works/pi-tui";
import type {
  ReplacementLeaseModule,
  ReplacementSurface,
} from "@yzlin/pieditor/replacement-surface-lease";
import { Type } from "typebox";

import { routeQuestionnaireKey } from "./keys";
import { renderQuestionnaireRuntime } from "./render";
import { createQuestionnaireEnvelope } from "./response";
import {
  createQuestionnaireRuntimeState,
  isAllAnswered,
  reduceQuestionnaireRuntime,
} from "./state";
import {
  CUSTOM_OPTION_LABEL,
  CUSTOM_OPTION_VALUE,
  NEXT_OPTION_LABEL,
  NEXT_OPTION_VALUE,
  QUESTIONNAIRE_RESERVED_LABELS,
  QUESTIONNAIRE_RESERVED_VALUES,
  type Question,
  type QuestionInput,
  type QuestionnaireParamsInput,
  type QuestionnaireResult,
  type QuestionnaireValidationErrorDetails,
  type QuestionnaireValidationIssue,
  type QuestionOption,
  type RenderOption,
} from "./types";

const CLARIFICATION_TRIGGER_REGEX =
  /\b(could you|can you|would you|do you want|would you prefer|do you prefer|which|what should|should i|any preference|please clarify|confirm)\b/i;

const FALLBACK_REPLACEMENT_LEASE_MODULE: ReplacementLeaseModule = {
  hasReplacementLeaseCompositor: () => false,
  withReplacementSurfaceLease: (_options, run) => run(),
};

let replacementLeaseModulePromise: Promise<ReplacementLeaseModule> | null =
  null;

function loadReplacementLeaseModule(): Promise<ReplacementLeaseModule> {
  replacementLeaseModulePromise ??= import(
    "@yzlin/pieditor/replacement-surface-lease"
  )
    .then((module) => module as ReplacementLeaseModule)
    .catch(() => FALLBACK_REPLACEMENT_LEASE_MODULE);

  return replacementLeaseModulePromise;
}

const QUESTIONNAIRE_REPLACEMENT_OWNER = "questionnaire";
const QUESTIONNAIRE_REPLACEMENT_SURFACE_ID = "custom-ui";
const QUESTIONNAIRE_REPLACEMENT_SURFACE: ReplacementSurface = {
  render: () => [],
};

export type {
  Answer,
  Question,
  QuestionInput,
  QuestionnaireParamsInput,
  QuestionnaireResult,
  QuestionnaireValidationErrorDetails,
  QuestionnaireValidationIssue,
  QuestionOption,
  RenderOption,
} from "./types";
export {
  CUSTOM_OPTION_LABEL,
  CUSTOM_OPTION_VALUE,
  NEXT_OPTION_LABEL,
  NEXT_OPTION_VALUE,
  QUESTIONNAIRE_RESERVED_LABELS,
  QUESTIONNAIRE_RESERVED_VALUES,
} from "./types";

interface AssistantTextBlock {
  type: string;
  text?: string;
}

function getAssistantText(content: AssistantTextBlock[]): string {
  return content
    .filter((block) => block.type === "text" && typeof block.text === "string")
    .map((block) => block.text)
    .join("\n")
    .trim();
}

function hasToolCall(content: { type: string }[]): boolean {
  return content.some((block) => block.type === "toolCall");
}

const QUESTIONNAIRE_REDIRECT_MESSAGE_TYPE = "questionnaire-auto-redirect";
const QUESTIONNAIRE_MISS_LOG_TYPE = "questionnaire-plain-text-miss";

export function getQuestionnaireRedirectCorrectionMessage(): string {
  return "Extension correction: you asked the user a plain-text clarification in an interactive session. Re-ask only the necessary clarification using the questionnaire tool instead of plain text. Ask at most 1-3 focused questions. After receiving the answer, continue the original task immediately and provide the pending result instead of stopping after a brief acknowledgment. Only stop early if materially new information is still required.";
}

function looksLikePlainTextClarification(text: string): boolean {
  if (!text.includes("?")) {
    return false;
  }

  return CLARIFICATION_TRIGGER_REGEX.test(text);
}

function hasAutoRedirectMessage(
  messages: Array<{ role: string; customType?: string }>
): boolean {
  return messages.some(
    (message) =>
      message.role === "custom" &&
      message.customType === QUESTIONNAIRE_REDIRECT_MESSAGE_TYPE
  );
}

interface QuestionnaireMissLog {
  source: "interactive" | "rpc" | "extension" | null;
  redirectedAlready: boolean;
  autoRedirected: boolean;
  text: string;
  timestamp: string;
}

function getQuestionnaireMissLogs(
  entries: Array<{ type: string; customType?: string; data?: unknown }>
): QuestionnaireMissLog[] {
  return entries
    .filter(
      (entry) =>
        entry.type === "custom" &&
        entry.customType === QUESTIONNAIRE_MISS_LOG_TYPE
    )
    .map((entry) => entry.data as QuestionnaireMissLog);
}

export { wrapQuestionnaireText } from "./text";

// Schema
const QuestionOptionSchema = Type.Object({
  value: Type.String({ description: "The value returned when selected" }),
  label: Type.String({ description: "Display label for the option" }),
  description: Type.Optional(
    Type.String({ description: "Optional description shown below label" })
  ),
  preview: Type.Optional(
    Type.String({ description: "Optional preview content for this option" })
  ),
});

const QuestionSchema = Type.Object({
  id: Type.String({ description: "Unique identifier for this question" }),
  label: Type.Optional(
    Type.String({
      description:
        "Short contextual label for tab bar, e.g. 'Scope', 'Priority' (defaults to Q1, Q2)",
    })
  ),
  prompt: Type.String({ description: "The full question text to display" }),
  options: Type.Array(QuestionOptionSchema, {
    description: "Available options to choose from",
    minItems: 2,
    maxItems: 5,
  }),
  multiSelect: Type.Optional(
    Type.Boolean({
      description:
        "Allow selecting multiple options before committing with Next. Multi-select questions do not include the custom input row.",
    })
  ),
});

const QuestionnaireParams = Type.Object({
  questions: Type.Array(QuestionSchema, {
    description: "Questions to ask the user",
    minItems: 1,
    maxItems: 3,
  }),
});

function addDuplicateIssue(
  issues: QuestionnaireValidationIssue[],
  seen: Set<string>,
  value: string,
  path: string,
  code: QuestionnaireValidationIssue["code"],
  label: string
): void {
  if (!seen.has(value)) {
    seen.add(value);
    return;
  }
  issues.push({
    path,
    code,
    message: `${label} must be unique; duplicates ${value}`,
  });
}

export function validateQuestionnaireParams(
  params: QuestionnaireParamsInput
):
  | QuestionnaireValidationErrorDetails
  | { valid: true; questions: QuestionInput[] } {
  const issues: QuestionnaireValidationIssue[] = [];
  const questions = params.questions ?? [];

  if (questions.length < 1 || questions.length > 3) {
    issues.push({
      path: "questions",
      code: "question_count",
      message: "Questionnaire requires 1-3 questions.",
    });
  }

  const questionIds = new Set<string>();
  questions.forEach((question, questionIndex) => {
    addDuplicateIssue(
      issues,
      questionIds,
      question.id,
      `questions[${questionIndex}].id`,
      "duplicate_question_id",
      "Question id"
    );

    if (
      question.multiSelect === true &&
      question.options.some((option) => option.preview !== undefined)
    ) {
      issues.push({
        path: `questions[${questionIndex}].options`,
        code: "preview_multi_select",
        message: "Multi-select questions cannot include option previews.",
      });
    }

    if (question.options.length < 2 || question.options.length > 5) {
      issues.push({
        path: `questions[${questionIndex}].options`,
        code: "option_count",
        message: "Each question requires 2-5 options.",
      });
    }

    const optionValues = new Set<string>();
    const optionLabels = new Set<string>();
    question.options.forEach((option, optionIndex) => {
      const valuePath = `questions[${questionIndex}].options[${optionIndex}].value`;
      const labelPath = `questions[${questionIndex}].options[${optionIndex}].label`;
      addDuplicateIssue(
        issues,
        optionValues,
        option.value,
        valuePath,
        "duplicate_option_value",
        "Option value"
      );
      addDuplicateIssue(
        issues,
        optionLabels,
        option.label,
        labelPath,
        "duplicate_option_label",
        "Option label"
      );
      if (QUESTIONNAIRE_RESERVED_VALUES.includes(option.value as never)) {
        issues.push({
          path: valuePath,
          code: "reserved_option_value",
          message: `Option value ${option.value} is reserved.`,
        });
      }
      if (QUESTIONNAIRE_RESERVED_LABELS.includes(option.label as never)) {
        issues.push({
          path: labelPath,
          code: "reserved_option_label",
          message: `Option label ${option.label} is reserved.`,
        });
      }
    });
  });

  if (issues.length > 0) {
    return { valid: false, issues };
  }

  return { valid: true, questions };
}

export { createQuestionnaireEnvelope } from "./response";

function normalizeQuestion(question: QuestionInput, index: number): Question {
  return {
    ...question,
    label: question.label || `Q${index + 1}`,
  };
}

function errorResult(
  message: string,
  questions: Question[] = [],
  validation?: QuestionnaireValidationErrorDetails
): {
  content: { type: "text"; text: string }[];
  details: QuestionnaireResult & {
    error?: QuestionnaireValidationErrorDetails;
  };
} {
  return {
    content: [{ type: "text", text: message }],
    details: { questions, answers: [], cancelled: true, error: validation },
  };
}

export function getRenderOptions(question: {
  multiSelect?: boolean;
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

  return [
    ...question.options,
    {
      value: CUSTOM_OPTION_VALUE,
      label: CUSTOM_OPTION_LABEL,
      isOther: true,
    },
  ];
}

export default function questionnaire(pi: ExtensionAPI): void {
  let lastInputSource: "interactive" | "rpc" | "extension" | null = null;

  pi.on("input", (event) => {
    lastInputSource = event.source;
    return;
  });

  pi.registerCommand("questionnaire-stats", {
    description: "Show questionnaire miss and redirect stats for this session",
    handler: (_args, ctx) => {
      const logs = getQuestionnaireMissLogs(ctx.sessionManager.getEntries());
      if (logs.length === 0) {
        ctx.ui.notify(
          "No questionnaire misses logged in this session.",
          "info"
        );
        return;
      }

      const sourceCounts = {
        interactive: 0,
        rpc: 0,
        extension: 0,
        unknown: 0,
      };
      let autoRedirected = 0;
      let redirectedAlready = 0;

      for (const log of logs) {
        if (log.source === "interactive") {
          sourceCounts.interactive++;
        } else if (log.source === "rpc") {
          sourceCounts.rpc++;
        } else if (log.source === "extension") {
          sourceCounts.extension++;
        } else {
          sourceCounts.unknown++;
        }

        if (log.autoRedirected) {
          autoRedirected++;
        }
        if (log.redirectedAlready) {
          redirectedAlready++;
        }
      }

      const recent = logs
        .slice(-5)
        .reverse()
        .map((log, index) => {
          const source = log.source ?? "unknown";
          const flags = [
            log.autoRedirected ? "redirected" : "not redirected",
            log.redirectedAlready ? "after redirect" : null,
          ]
            .filter(Boolean)
            .join(", ");
          const preview = truncateToWidth(log.text.replace(/\s+/g, " "), 90);
          return `${index + 1}. [${source}] ${flags} — ${preview}`;
        });

      pi.sendMessage({
        customType: "questionnaire-stats",
        content: `Questionnaire stats\n\nTotal misses: ${logs.length}\nAuto-redirected: ${autoRedirected}\nRepeated after redirect: ${redirectedAlready}\n\nBy source:\n- interactive: ${sourceCounts.interactive}\n- rpc: ${sourceCounts.rpc}\n- extension: ${sourceCounts.extension}\n- unknown: ${sourceCounts.unknown}\n\nRecent misses:\n${recent.join("\n")}`,
        display: true,
      });
    },
  });

  pi.registerTool({
    name: "questionnaire",
    label: "Questionnaire",
    description:
      "Ask the user one or more questions. Use for clarifying requirements, getting preferences, or confirming decisions. Single-select questions include a final custom input option. Multi-select questions use checkboxes and a Next row instead of custom input. For multiple questions, shows a tab-based interface.",
    promptSnippet:
      "Ask the user structured clarifying questions in the interactive main session",
    promptGuidelines: [
      "When you need user input in the interactive main session, prefer questionnaire over asking plain-text questions.",
      "Use a single question with options for simple clarifications; use multiple questions only when several answers are needed together.",
      "Keep questions short, decision-oriented, and limited to what is needed to proceed.",
      "Single-select questions include a custom input row. Multi-select questions use checkboxes and a Next row, with no custom input row.",
      "Do not use questionnaire in background or non-interactive contexts.",
    ],
    parameters: QuestionnaireParams,

    async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
      if (!ctx.hasUI) {
        return errorResult(
          "Error: UI not available (running in non-interactive mode)"
        );
      }
      const validation = validateQuestionnaireParams(params);
      if (!validation.valid) {
        return errorResult(
          `Error: Invalid questionnaire: ${validation.issues.map((issue) => issue.message).join(" ")}`,
          [],
          validation
        );
      }

      const questions = validation.questions.map(normalizeQuestion);
      const replacementLeaseModule = await loadReplacementLeaseModule();
      const shouldUseFixedReplacement =
        replacementLeaseModule.hasReplacementLeaseCompositor();
      let replacementComponent: {
        render(width: number): string[];
        invalidate(): void;
        handleInput?(data: string): void;
        dispose?(): void;
      } | null = null;
      const replacementSurface: ReplacementSurface = {
        render: (width) => replacementComponent?.render(width) ?? [],
      };

      const result = await replacementLeaseModule.withReplacementSurfaceLease(
        {
          owner: QUESTIONNAIRE_REPLACEMENT_OWNER,
          id: QUESTIONNAIRE_REPLACEMENT_SURFACE_ID,
          target: shouldUseFixedReplacement
            ? replacementSurface
            : QUESTIONNAIRE_REPLACEMENT_SURFACE,
        },
        () =>
          ctx.ui.custom<QuestionnaireResult>((tui, theme, _kb, done) => {
            let state = createQuestionnaireRuntimeState();
            let cachedLines: string[] | undefined;

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
              done({
                questions,
                answers: Array.from(state.answers.values()),
                cancelled,
              });
            }

            function currentQuestion(): Question | undefined {
              return questions[state.currentTab];
            }

            function canUsePreviewNotes(): boolean {
              const question = currentQuestion();
              return (
                question !== undefined &&
                question.multiSelect !== true &&
                question.options.some((option) => option.preview !== undefined)
              );
            }

            function currentOptions(): RenderOption[] {
              const question = currentQuestion();
              return question ? getRenderOptions(question) : [];
            }

            function applyEffect(
              effect: ReturnType<typeof reduceQuestionnaireRuntime>["effect"]
            ) {
              if (effect.type === "submit") {
                submit(effect.cancelled);
                return;
              }
              if (
                effect.type === "startInput" ||
                effect.type === "clearInput"
              ) {
                editor.setText("");
              }
              if (effect.type === "startNote") {
                editor.setText(state.noteDrafts.get(effect.questionId) ?? "");
              }
              if (effect.type !== "none") {
                refresh();
              }
            }

            function dispatch(
              action: Parameters<typeof reduceQuestionnaireRuntime>[1]
            ) {
              const reduced = reduceQuestionnaireRuntime(
                state,
                action,
                questions
              );
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
              const action = routeQuestionnaireKey({
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

              cachedLines = renderQuestionnaireRuntime({
                width,
                theme,
                questions,
                state,
                options: currentOptions(),
                editor,
                previewEnabled: canUsePreviewNotes(),
              });
              return cachedLines;
            }

            const component = {
              render,
              invalidate: () => {
                cachedLines = undefined;
              },
              handleInput,
            };

            if (!shouldUseFixedReplacement) {
              return component;
            }

            replacementComponent = component;
            return {
              render: () => [],
              invalidate: component.invalidate,
              handleInput: component.handleInput,
              dispose: () => {
                replacementComponent = null;
              },
            };
          })
      );

      return createQuestionnaireEnvelope({ ...result, questions });
    },

    renderCall(args, theme) {
      const qs = (args.questions as Question[]) || [];
      const count = qs.length;
      const labels = qs.map((q) => q.label || q.id).join(", ");
      let text = theme.fg("toolTitle", theme.bold("questionnaire "));
      text += theme.fg("muted", `${count} question${count === 1 ? "" : "s"}`);
      if (labels) {
        text += theme.fg("dim", ` (${truncateToWidth(labels, 40)})`);
      }
      return new Text(text, 0, 0);
    },

    renderResult(result, _options, theme) {
      const details = result.details as QuestionnaireResult | undefined;
      if (!details) {
        const text = result.content[0];
        return new Text(text?.type === "text" ? text.text : "", 0, 0);
      }
      if (details.cancelled) {
        return new Text(theme.fg("warning", "Cancelled"), 0, 0);
      }
      const lines = details.answers.map((a) => {
        if (a.kind === "custom") {
          return `${theme.fg("success", "✓ ")}${theme.fg("accent", a.id)}: ${theme.fg("muted", "(wrote) ")}${a.label}`;
        }
        if (a.kind === "multi") {
          const display =
            a.selectedOptions
              .map((option) => `${option.index}. ${option.label}`)
              .join(", ") || "(none)";
          return `${theme.fg("success", "✓ ")}${theme.fg("accent", a.id)}: ${display}`;
        }
        const display = a.index ? `${a.index}. ${a.label}` : a.label;
        return `${theme.fg("success", "✓ ")}${theme.fg("accent", a.id)}: ${display}`;
      });
      return new Text(lines.join("\n"), 0, 0);
    },
  });

  pi.on("before_agent_start", (event, ctx) => {
    if (!ctx.hasUI) {
      return;
    }

    return {
      systemPrompt:
        event.systemPrompt +
        `

QUESTION-ASKING RULES:
- If you need clarification from the user and interactive UI is available, prefer the questionnaire tool over asking plain-text questions.
- Use questionnaire for preferences, confirmations, missing requirements, and tradeoff choices that materially affect the work.
- Ask at most 1-3 focused questions at a time.
- Do not use questionnaire in background, subagent, or non-interactive contexts.
`,
    };
  });

  pi.on("agent_end", (event, ctx) => {
    if (!ctx.hasUI) {
      return;
    }

    const usedQuestionnaire = event.messages.some(
      (message) =>
        message.role === "toolResult" && message.toolName === "questionnaire"
    );
    if (usedQuestionnaire) {
      return;
    }

    const assistantMessages = event.messages.filter(
      (message) => message.role === "assistant"
    );
    const lastAssistant = assistantMessages.at(-1);
    if (lastAssistant?.stopReason !== "stop") {
      return;
    }
    if (hasToolCall(lastAssistant.content)) {
      return;
    }

    const text = getAssistantText(lastAssistant.content);
    if (!looksLikePlainTextClarification(text)) {
      return;
    }

    const redirectedAlready = hasAutoRedirectMessage(event.messages);
    const shouldAutoRedirect =
      lastInputSource === "interactive" && !redirectedAlready;

    pi.appendEntry(QUESTIONNAIRE_MISS_LOG_TYPE, {
      source: lastInputSource,
      redirectedAlready,
      autoRedirected: shouldAutoRedirect,
      text,
      timestamp: new Date().toISOString(),
    });

    if (redirectedAlready) {
      ctx.ui.notify(
        "Assistant still asked a plain-text clarification after redirect. Prefer questionnaire manually.",
        "warning"
      );
      return;
    }

    if (!shouldAutoRedirect) {
      ctx.ui.notify(
        "Assistant asked a plain-text clarification. Logged for tuning; no auto-redirect outside interactive TUI.",
        "warning"
      );
      return;
    }

    ctx.ui.notify(
      "Assistant asked a plain-text clarification. Auto-redirecting it to questionnaire.",
      "warning"
    );

    pi.sendMessage(
      {
        customType: QUESTIONNAIRE_REDIRECT_MESSAGE_TYPE,
        content: getQuestionnaireRedirectCorrectionMessage(),
        display: false,
      },
      { triggerTurn: true }
    );
  });
}
