/**
 * Questionnaire Tool - Unified tool for asking single or multiple questions
 *
 * Single question: simple options list
 * Multiple questions: tab bar navigation between questions
 */

import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";
import {
  Editor,
  type EditorTheme,
  Key,
  matchesKey,
  Text,
  truncateToWidth,
  wrapTextWithAnsi,
} from "@mariozechner/pi-tui";
import { Type } from "@sinclair/typebox";

// Types
export interface QuestionOption {
  value: string;
  label: string;
  description?: string;
}

export type RenderOption = QuestionOption & { isOther?: boolean };

const CUSTOM_OPTION_VALUE = "__other__";
const CUSTOM_OPTION_LABEL = "Type something.";

interface Question {
  id: string;
  label: string;
  prompt: string;
  options: QuestionOption[];
}

interface Answer {
  id: string;
  value: string;
  label: string;
  wasCustom: boolean;
  index?: number;
}

interface QuestionnaireResult {
  questions: Question[];
  answers: Answer[];
  cancelled: boolean;
}

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

  return /\b(could you|can you|would you|do you want|would you prefer|do you prefer|which|what should|should i|any preference|please clarify|confirm)\b/i.test(
    text
  );
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

export function wrapQuestionnaireText(text: string, width: number): string[] {
  const clampedWidth = Math.max(1, width);
  const normalized = text.replace(/\t/g, "    ");

  if (!normalized) {
    return [""];
  }

  return normalized.split("\n").flatMap((line) => {
    if (!line) {
      return [""];
    }

    return wrapTextWithAnsi(line, clampedWidth).map((segment) =>
      truncateToWidth(segment, clampedWidth)
    );
  });
}

// Schema
const QuestionOptionSchema = Type.Object({
  value: Type.String({ description: "The value returned when selected" }),
  label: Type.String({ description: "Display label for the option" }),
  description: Type.Optional(
    Type.String({ description: "Optional description shown below label" })
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
  }),
});

const QuestionnaireParams = Type.Object({
  questions: Type.Array(QuestionSchema, {
    description: "Questions to ask the user",
  }),
});

function errorResult(
  message: string,
  questions: Question[] = []
): { content: { type: "text"; text: string }[]; details: QuestionnaireResult } {
  return {
    content: [{ type: "text", text: message }],
    details: { questions, answers: [], cancelled: true },
  };
}

export function getRenderOptions(question: {
  options: QuestionOption[];
}): RenderOption[] {
  return [
    ...question.options,
    {
      value: CUSTOM_OPTION_VALUE,
      label: CUSTOM_OPTION_LABEL,
      isOther: true,
    },
  ];
}

export default function questionnaire(pi: ExtensionAPI) {
  let lastInputSource: "interactive" | "rpc" | "extension" | null = null;

  pi.on("input", async (event) => {
    lastInputSource = event.source;
    return undefined;
  });

  pi.registerCommand("questionnaire-stats", {
    description: "Show questionnaire miss and redirect stats for this session",
    handler: async (_args, ctx) => {
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
        if (log.source === "interactive") sourceCounts.interactive++;
        else if (log.source === "rpc") sourceCounts.rpc++;
        else if (log.source === "extension") sourceCounts.extension++;
        else sourceCounts.unknown++;

        if (log.autoRedirected) autoRedirected++;
        if (log.redirectedAlready) redirectedAlready++;
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
      "Ask the user one or more questions. Use for clarifying requirements, getting preferences, or confirming decisions. Each question includes a final custom input option. For single questions, shows a simple option list. For multiple questions, shows a tab-based interface.",
    promptSnippet:
      "Ask the user structured clarifying questions in the interactive main session",
    promptGuidelines: [
      "When you need user input in the interactive main session, prefer questionnaire over asking plain-text questions.",
      "Use a single question with options for simple clarifications; use multiple questions only when several answers are needed together.",
      "Keep questions short, decision-oriented, and limited to what is needed to proceed.",
      "Do not use questionnaire in background or non-interactive contexts.",
    ],
    parameters: QuestionnaireParams,

    async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
      if (!ctx.hasUI) {
        return errorResult(
          "Error: UI not available (running in non-interactive mode)"
        );
      }
      if (params.questions.length === 0) {
        return errorResult("Error: No questions provided");
      }

      // Normalize questions with defaults
      const questions: Question[] = params.questions.map((q, i) => ({
        ...q,
        label: q.label || `Q${i + 1}`,
      }));

      const isMulti = questions.length > 1;
      const totalTabs = questions.length + 1; // questions + Submit

      const result = await ctx.ui.custom<QuestionnaireResult>(
        (tui, theme, _kb, done) => {
          // State
          let currentTab = 0;
          let optionIndex = 0;
          let inputMode = false;
          let inputQuestionId: string | null = null;
          let cachedLines: string[] | undefined;
          const answers = new Map<string, Answer>();

          // Editor for "Type something" option
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

          // Helpers
          function refresh() {
            cachedLines = undefined;
            tui.requestRender();
          }

          function submit(cancelled: boolean) {
            done({
              questions,
              answers: Array.from(answers.values()),
              cancelled,
            });
          }

          function currentQuestion(): Question | undefined {
            return questions[currentTab];
          }

          function currentOptions(): RenderOption[] {
            const q = currentQuestion();
            if (!q) return [];
            return getRenderOptions(q);
          }

          function allAnswered(): boolean {
            return questions.every((q) => answers.has(q.id));
          }

          function advanceAfterAnswer() {
            if (!isMulti) {
              submit(false);
              return;
            }
            if (currentTab < questions.length - 1) {
              currentTab++;
            } else {
              currentTab = questions.length; // Submit tab
            }
            optionIndex = 0;
            refresh();
          }

          function saveAnswer(
            questionId: string,
            value: string,
            label: string,
            wasCustom: boolean,
            index?: number
          ) {
            answers.set(questionId, {
              id: questionId,
              value,
              label,
              wasCustom,
              index,
            });
          }

          // Editor submit callback
          editor.onSubmit = (value) => {
            if (!inputQuestionId) return;
            const trimmed = value.trim() || "(no response)";
            saveAnswer(inputQuestionId, trimmed, trimmed, true);
            inputMode = false;
            inputQuestionId = null;
            editor.setText("");
            advanceAfterAnswer();
          };

          function handleInput(data: string) {
            // Input mode: route to editor
            if (inputMode) {
              if (matchesKey(data, Key.escape)) {
                inputMode = false;
                inputQuestionId = null;
                editor.setText("");
                refresh();
                return;
              }
              editor.handleInput(data);
              refresh();
              return;
            }

            const q = currentQuestion();
            const opts = currentOptions();

            // Tab navigation (multi-question only)
            if (isMulti) {
              if (matchesKey(data, Key.tab) || matchesKey(data, Key.right)) {
                currentTab = (currentTab + 1) % totalTabs;
                optionIndex = 0;
                refresh();
                return;
              }
              if (
                matchesKey(data, Key.shift("tab")) ||
                matchesKey(data, Key.left)
              ) {
                currentTab = (currentTab - 1 + totalTabs) % totalTabs;
                optionIndex = 0;
                refresh();
                return;
              }
            }

            // Submit tab
            if (currentTab === questions.length) {
              if (matchesKey(data, Key.enter) && allAnswered()) {
                submit(false);
              } else if (matchesKey(data, Key.escape)) {
                submit(true);
              }
              return;
            }

            // Option navigation
            if (matchesKey(data, Key.up)) {
              optionIndex = Math.max(0, optionIndex - 1);
              refresh();
              return;
            }
            if (matchesKey(data, Key.down)) {
              optionIndex = Math.min(opts.length - 1, optionIndex + 1);
              refresh();
              return;
            }

            // Select option
            if (matchesKey(data, Key.enter) && q) {
              const opt = opts[optionIndex];
              if (opt.isOther) {
                inputMode = true;
                inputQuestionId = q.id;
                editor.setText("");
                refresh();
                return;
              }
              saveAnswer(q.id, opt.value, opt.label, false, optionIndex + 1);
              advanceAfterAnswer();
              return;
            }

            // Cancel
            if (matchesKey(data, Key.escape)) {
              submit(true);
            }
          }

          function render(width: number): string[] {
            if (cachedLines) return cachedLines;

            const lines: string[] = [];
            const q = currentQuestion();
            const opts = currentOptions();

            // Helpers to add rendered lines
            const add = (s: string) => lines.push(truncateToWidth(s, width));
            const addWrapped = (
              text: string,
              indent: string,
              color: string
            ) => {
              const contentWidth = Math.max(1, width - indent.length);
              for (const line of wrapQuestionnaireText(text, contentWidth)) {
                add(`${indent}${theme.fg(color, line)}`);
              }
            };

            add(theme.fg("accent", "─".repeat(width)));

            // Tab bar (multi-question only)
            if (isMulti) {
              const tabs: string[] = ["← "];
              for (let i = 0; i < questions.length; i++) {
                const isActive = i === currentTab;
                const isAnswered = answers.has(questions[i].id);
                const lbl = questions[i].label;
                const box = isAnswered ? "■" : "□";
                const color = isAnswered ? "success" : "muted";
                const text = ` ${box} ${lbl} `;
                const styled = isActive
                  ? theme.bg("selectedBg", theme.fg("text", text))
                  : theme.fg(color, text);
                tabs.push(`${styled} `);
              }
              const canSubmit = allAnswered();
              const isSubmitTab = currentTab === questions.length;
              const submitText = " ✓ Submit ";
              const submitStyled = isSubmitTab
                ? theme.bg("selectedBg", theme.fg("text", submitText))
                : theme.fg(canSubmit ? "success" : "dim", submitText);
              tabs.push(`${submitStyled} →`);
              add(` ${tabs.join("")}`);
              lines.push("");
            }

            // Helper to render options list
            function renderOptions() {
              for (let i = 0; i < opts.length; i++) {
                const opt = opts[i];
                const selected = i === optionIndex;
                const isOther = opt.isOther === true;
                const prefix = selected ? theme.fg("accent", "> ") : "  ";
                const color = selected ? "accent" : "text";
                // Mark "Type something" differently when in input mode
                if (isOther && inputMode) {
                  add(prefix + theme.fg("accent", `${i + 1}. ${opt.label} ✎`));
                } else {
                  add(prefix + theme.fg(color, `${i + 1}. ${opt.label}`));
                }
                if (opt.description) {
                  addWrapped(opt.description, "     ", "muted");
                }
              }
            }

            // Content
            if (inputMode && q) {
              addWrapped(q.prompt, " ", "text");
              lines.push("");
              // Show options for reference
              renderOptions();
              lines.push("");
              add(theme.fg("muted", " Your answer:"));
              for (const line of editor.render(width - 2)) {
                add(` ${line}`);
              }
              lines.push("");
              add(theme.fg("dim", " Enter to submit • Esc to cancel"));
            } else if (currentTab === questions.length) {
              add(theme.fg("accent", theme.bold(" Ready to submit")));
              lines.push("");
              for (const question of questions) {
                const answer = answers.get(question.id);
                if (answer) {
                  const prefix = answer.wasCustom ? "(wrote) " : "";
                  add(
                    `${theme.fg("muted", ` ${question.label}: `)}${theme.fg("text", prefix + answer.label)}`
                  );
                }
              }
              lines.push("");
              if (allAnswered()) {
                add(theme.fg("success", " Press Enter to submit"));
              } else {
                const missing = questions
                  .filter((q) => !answers.has(q.id))
                  .map((q) => q.label)
                  .join(", ");
                add(theme.fg("warning", ` Unanswered: ${missing}`));
              }
            } else if (q) {
              addWrapped(q.prompt, " ", "text");
              lines.push("");
              renderOptions();
            }

            lines.push("");
            if (!inputMode) {
              const help = isMulti
                ? " Tab/←→ navigate • ↑↓ select • Enter confirm • Esc cancel"
                : " ↑↓ navigate • Enter select • Esc cancel";
              add(theme.fg("dim", help));
            }
            add(theme.fg("accent", "─".repeat(width)));

            cachedLines = lines;
            return lines;
          }

          return {
            render,
            invalidate: () => {
              cachedLines = undefined;
            },
            handleInput,
          };
        }
      );

      if (result.cancelled) {
        return {
          content: [{ type: "text", text: "User cancelled the questionnaire" }],
          details: result,
        };
      }

      const answerLines = result.answers.map((a) => {
        const qLabel = questions.find((q) => q.id === a.id)?.label || a.id;
        if (a.wasCustom) {
          return `${qLabel}: user wrote: ${a.label}`;
        }
        return `${qLabel}: user selected: ${a.index}. ${a.label}`;
      });

      return {
        content: [{ type: "text", text: answerLines.join("\n") }],
        details: result,
      };
    },

    renderCall(args, theme) {
      const qs = (args.questions as Question[]) || [];
      const count = qs.length;
      const labels = qs.map((q) => q.label || q.id).join(", ");
      let text = theme.fg("toolTitle", theme.bold("questionnaire "));
      text += theme.fg("muted", `${count} question${count !== 1 ? "s" : ""}`);
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
        if (a.wasCustom) {
          return `${theme.fg("success", "✓ ")}${theme.fg("accent", a.id)}: ${theme.fg("muted", "(wrote) ")}${a.label}`;
        }
        const display = a.index ? `${a.index}. ${a.label}` : a.label;
        return `${theme.fg("success", "✓ ")}${theme.fg("accent", a.id)}: ${display}`;
      });
      return new Text(lines.join("\n"), 0, 0);
    },
  });

  pi.on("before_agent_start", async (event, ctx) => {
    if (!ctx.hasUI) {
      return undefined;
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

  pi.on("agent_end", async (event, ctx) => {
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
    if (!lastAssistant || lastAssistant.stopReason !== "stop") {
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
