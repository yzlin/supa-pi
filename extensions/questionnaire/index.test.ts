import { beforeEach, describe, expect, it } from "bun:test";

import { visibleWidth } from "@earendil-works/pi-tui";

import {
  clearReplacementSurfaceLeases,
  getActiveReplacementLeaseDiagnostics,
} from "@yzlin/pieditor/replacement-surface-lease";
import questionnaire, {
  CUSTOM_OPTION_LABEL,
  CUSTOM_OPTION_VALUE,
  createQuestionnaireEnvelope,
  getQuestionnaireRedirectCorrectionMessage,
  getRenderOptions,
  NEXT_OPTION_LABEL,
  NEXT_OPTION_VALUE,
  validateQuestionnaireParams,
  wrapQuestionnaireText,
} from "./index";
import { routeQuestionnaireKey } from "./keys";
import { renderQuestionnaireRuntime } from "./render";
import {
  createQuestionnaireRuntimeState,
  reduceQuestionnaireRuntime,
} from "./state";

const PLAIN_THEME = {
  fg(_color: string, text: string): string {
    return text;
  },
  bg(_color: string, text: string): string {
    return text;
  },
  bold(text: string): string {
    return text;
  },
};

const ANSI_THEME = {
  fg(_color: string, text: string): string {
    return `\u001b[34m${text}\u001b[0m`;
  },
  bg(_color: string, text: string): string {
    return `\u001b[7m${text}\u001b[0m`;
  },
  bold(text: string): string {
    return `\u001b[1m${text}\u001b[0m`;
  },
};

const EMPTY_EDITOR = {
  render(): string[] {
    return [];
  },
};

const VALID_EXECUTE_PARAMS = {
  questions: [
    {
      id: "format",
      prompt: "Which format?",
      options: [
        { value: "json", label: "JSON" },
        { value: "text", label: "Text" },
      ],
    },
  ],
};

function registerQuestionnaireTool() {
  let registeredTool: {
    execute: (...args: unknown[]) => Promise<unknown>;
  } | null = null;
  questionnaire({
    registerTool(tool: { execute: (...args: unknown[]) => Promise<unknown> }) {
      registeredTool = tool;
    },
    registerCommand() {
      return undefined;
    },
    on() {
      return undefined;
    },
    appendEntry() {
      return undefined;
    },
    sendMessage() {
      return undefined;
    },
  } as never);

  if (!registeredTool) {
    throw new Error("questionnaire tool was not registered");
  }
  return registeredTool;
}

function executeQuestionnaireWithCustom(
  custom: (renderFactory: unknown) => unknown | Promise<unknown>
) {
  const tool = registerQuestionnaireTool();
  return tool.execute("tool-call", VALID_EXECUTE_PARAMS, undefined, undefined, {
    hasUI: true,
    ui: {
      custom,
      notify() {
        return undefined;
      },
    },
  });
}

beforeEach(() => {
  clearReplacementSurfaceLeases();
});

describe("questionnaire replacement lease", () => {
  it("releases the scoped replacement lease after successful submit", async () => {
    await executeQuestionnaireWithCustom(() => {
      expect(getActiveReplacementLeaseDiagnostics()).toEqual([
        { owner: "questionnaire", id: "custom-ui" },
      ]);
      return {
        questions: [],
        answers: [
          {
            kind: "option",
            id: "format",
            value: "json",
            label: "JSON",
            wasCustom: false,
            index: 1,
          },
        ],
        cancelled: false,
      };
    });

    expect(getActiveReplacementLeaseDiagnostics()).toEqual([]);
  });

  it("releases the scoped replacement lease after cancellation", async () => {
    await executeQuestionnaireWithCustom(() => {
      expect(getActiveReplacementLeaseDiagnostics()).toHaveLength(1);
      return { questions: [], answers: [], cancelled: true };
    });

    expect(getActiveReplacementLeaseDiagnostics()).toEqual([]);
  });

  it("releases the scoped replacement lease when custom UI throws", async () => {
    await expect(
      executeQuestionnaireWithCustom(() => {
        expect(getActiveReplacementLeaseDiagnostics()).toHaveLength(1);
        throw new Error("custom UI failed");
      })
    ).rejects.toThrow("custom UI failed");

    expect(getActiveReplacementLeaseDiagnostics()).toEqual([]);
  });

  it("does not acquire a replacement lease for validation errors", async () => {
    const tool = registerQuestionnaireTool();
    await tool.execute("tool-call", { questions: [] }, undefined, undefined, {
      hasUI: true,
      ui: {
        custom() {
          throw new Error("custom UI should not open");
        },
        notify() {
          return undefined;
        },
      },
    });

    expect(getActiveReplacementLeaseDiagnostics()).toEqual([]);
  });
});

describe("wrapQuestionnaireText", () => {
  it("wraps long questionnaire copy instead of truncating it", () => {
    const text =
      "This is a long questionnaire description that should wrap across multiple lines instead of getting cut off.";

    const lines = wrapQuestionnaireText(text, 24);

    expect(lines.length).toBeGreaterThan(1);
    expect(lines.join(" ").replace(/\s+/g, " ").trim()).toBe(
      text.replace(/\s+/g, " ").trim()
    );
    for (const line of lines) {
      expect(visibleWidth(line)).toBeLessThanOrEqual(24);
    }
  });

  it("strips terminal control sequences from questionnaire text", () => {
    const lines = wrapQuestionnaireText(
      "Safe\u001b[2J text\u001b]52;c;SGVsbG8=\u0007 done",
      80
    );

    expect(lines.join("\n")).toBe("Safe text done");
  });
});

describe("getQuestionnaireRedirectCorrectionMessage", () => {
  it("tells the assistant to continue the original task after the questionnaire answer", () => {
    const message = getQuestionnaireRedirectCorrectionMessage();

    expect(message).toContain("continue the original task immediately");
    expect(message).toContain("provide the pending result");
    expect(message).toContain(
      "instead of stopping after a brief acknowledgment"
    );
  });
});

describe("getRenderOptions", () => {
  it("always appends the custom input option", () => {
    const options = getRenderOptions({
      options: [{ value: "json", label: "JSON" }],
    });

    expect(options).toHaveLength(2);
    expect(options[0]).toMatchObject({ value: "json", label: "JSON" });
    expect(options[1]).toMatchObject({
      value: "__other__",
      label: "Type something.",
      isOther: true,
    });
  });

  it("keeps the custom option last", () => {
    const options = getRenderOptions({
      options: [
        { value: "high", label: "High" },
        { value: "medium", label: "Medium" },
      ],
    });

    expect(options.map((option) => option.label)).toEqual([
      "High",
      "Medium",
      "Type something.",
    ]);
  });

  it("uses Next instead of custom input for multi-select questions", () => {
    const options = getRenderOptions({
      multiSelect: true,
      options: [
        { value: "docs", label: "Docs" },
        { value: "tests", label: "Tests" },
      ],
    });

    expect(options.map((option) => option.label)).toEqual([
      "Docs",
      "Tests",
      "Next",
    ]);
    expect(options.some((option) => option.isOther === true)).toBe(false);
    expect(options[2]).toMatchObject({ value: "__next__", isNext: true });
  });
});

describe("validateQuestionnaireParams", () => {
  const validQuestion = {
    id: "format",
    label: "Format",
    prompt: "Which format?",
    options: [
      { value: "json", label: "JSON" },
      { value: "text", label: "Text" },
    ],
  };

  it("accepts 1-3 questions with 2-5 options", () => {
    expect(
      validateQuestionnaireParams({ questions: [validQuestion] })
    ).toMatchObject({ valid: true });
  });

  it("rejects duplicate question ids", () => {
    const result = validateQuestionnaireParams({
      questions: [validQuestion, { ...validQuestion, label: "Other" }],
    });

    expect(result).toMatchObject({
      valid: false,
      issues: [{ code: "duplicate_question_id" }],
    });
  });

  it("rejects invalid counts, duplicate options, reserved sentinels, and multiSelect option previews", () => {
    const result = validateQuestionnaireParams({
      questions: [
        {
          ...validQuestion,
          multiSelect: true,
          options: [
            { value: "same", label: "Same", preview: "Preview" },
            { value: "same", label: "Same" },
            { value: CUSTOM_OPTION_VALUE, label: CUSTOM_OPTION_LABEL },
            { value: NEXT_OPTION_VALUE, label: NEXT_OPTION_LABEL },
            { value: "extra", label: "Extra" },
            { value: "too-many", label: "Too many" },
          ],
        },
      ],
    });

    expect(result).toMatchObject({ valid: false });
    if (result.valid) {
      throw new Error("expected validation errors");
    }
    expect(result.issues.map((issue) => issue.code)).toEqual(
      expect.arrayContaining([
        "preview_multi_select",
        "option_count",
        "duplicate_option_value",
        "duplicate_option_label",
        "reserved_option_value",
        "reserved_option_label",
      ])
    );
  });
});

describe("questionnaire reducer and key router", () => {
  const questions = [
    {
      id: "format",
      label: "Format",
      prompt: "Which format?",
      options: [
        { value: "json", label: "JSON" },
        { value: "text", label: "Text" },
      ],
    },
    {
      id: "tone",
      label: "Tone",
      prompt: "Which tone?",
      options: [
        { value: "brief", label: "Brief" },
        { value: "full", label: "Full" },
      ],
    },
  ];

  it("wraps option selection at list boundaries", () => {
    const state = createQuestionnaireRuntimeState();

    const upResult = reduceQuestionnaireRuntime(
      state,
      { type: "moveOption", delta: -1, optionCount: 2 },
      questions
    );
    const downResult = reduceQuestionnaireRuntime(
      upResult.state,
      { type: "moveOption", delta: 1, optionCount: 2 },
      questions
    );

    expect(upResult.state.optionIndex).toBe(1);
    expect(upResult.effect).toEqual({ type: "refresh" });
    expect(downResult.state.optionIndex).toBe(0);
  });

  it("saves a selected answer and advances to the next question", () => {
    const state = createQuestionnaireRuntimeState();

    const result = reduceQuestionnaireRuntime(
      state,
      {
        type: "selectOption",
        question: questions[0],
        option: questions[0].options[1],
        optionIndex: 1,
      },
      questions
    );

    expect(result.state.currentTab).toBe(1);
    expect(result.state.answers.get("format")).toMatchObject({
      kind: "option",
      value: "text",
      label: "Text",
      wasCustom: false,
      index: 2,
    });
    expect(result.effect).toEqual({ type: "refresh" });
  });

  it("routes vim navigation keys like arrow navigation", () => {
    const state = createQuestionnaireRuntimeState();
    const options = getRenderOptions(questions[0]);
    const cases = [
      { data: "j", action: { type: "moveOption", delta: 1, optionCount: 3 } },
      { data: "k", action: { type: "moveOption", delta: -1, optionCount: 3 } },
      { data: "l", action: { type: "moveTab", delta: 1, totalTabs: 3 } },
      { data: "h", action: { type: "moveTab", delta: -1, totalTabs: 3 } },
    ] as const;

    for (const { data, action } of cases) {
      expect(
        routeQuestionnaireKey({
          data,
          state,
          questions,
          options,
          allAnswered: false,
        })
      ).toEqual(action);
    }
  });

  it("keeps vim navigation keys in editor and note modes as editor input", () => {
    const modes = [
      {
        ...createQuestionnaireRuntimeState(),
        inputMode: true,
        inputQuestionId: "format",
      },
      {
        ...createQuestionnaireRuntimeState(),
        notesMode: true,
        noteQuestionId: "format",
      },
    ];

    for (const state of modes) {
      for (const data of ["j", "k", "h", "l"]) {
        expect(
          routeQuestionnaireKey({
            data,
            state,
            questions,
            options: getRenderOptions(questions[0]),
            allAnswered: false,
          })
        ).toEqual({ type: "editor" });
      }
    }
  });

  it("routes enter to custom input when Type something is selected", () => {
    const state = { ...createQuestionnaireRuntimeState(), optionIndex: 2 };
    const options = getRenderOptions(questions[0]);

    const action = routeQuestionnaireKey({
      data: "\r",
      state,
      questions,
      options,
      allAnswered: false,
    });

    expect(action).toMatchObject({
      type: "selectOption",
      option: { isOther: true },
    });
  });

  it("rejects empty custom answers and keeps input open", () => {
    const state = {
      ...createQuestionnaireRuntimeState(),
      inputMode: true,
      inputQuestionId: "format",
    };

    const result = reduceQuestionnaireRuntime(
      state,
      { type: "saveCustomAnswer", questionId: "format", value: "   " },
      questions
    );

    expect(result.state.inputMode).toBe(true);
    expect(result.state.inputQuestionId).toBe("format");
    expect(result.state.answers.has("format")).toBe(false);
    expect(result.effect).toEqual({ type: "refresh" });
  });

  it("keeps submit disabled until all questions are answered", () => {
    const state = {
      ...createQuestionnaireRuntimeState(),
      currentTab: questions.length,
    };

    const action = routeQuestionnaireKey({
      data: "\r",
      state,
      questions,
      options: [],
      allAnswered: false,
    });
    const result = reduceQuestionnaireRuntime(
      state,
      action as Parameters<typeof reduceQuestionnaireRuntime>[1],
      questions
    );

    expect(action).toEqual({ type: "submitIfReady", ready: false });
    expect(result.effect).toEqual({ type: "none" });
  });

  it("allows cancel from the submit picker even with missing answers", () => {
    const state = {
      ...createQuestionnaireRuntimeState(),
      currentTab: questions.length,
      optionIndex: 1,
    };

    const action = routeQuestionnaireKey({
      data: "\r",
      state,
      questions,
      options: [],
      allAnswered: false,
    });

    expect(action).toEqual({ type: "cancel" });
  });

  it("wraps submit picker rows", () => {
    const state = {
      ...createQuestionnaireRuntimeState(),
      currentTab: questions.length,
    };

    const action = routeQuestionnaireKey({
      data: "\u001b[A",
      state,
      questions,
      options: [],
      allAnswered: false,
    });
    const result = reduceQuestionnaireRuntime(
      state,
      action as Parameters<typeof reduceQuestionnaireRuntime>[1],
      questions
    );

    expect(action).toEqual({ type: "moveOption", delta: -1, optionCount: 2 });
    expect(result.state.optionIndex).toBe(1);
  });

  it("renders a submit and cancel picker with disabled submit copy", () => {
    const state = {
      ...createQuestionnaireRuntimeState(),
      currentTab: questions.length,
    };
    const lines = renderQuestionnaireRuntime({
      width: 80,
      theme: PLAIN_THEME,
      questions,
      state,
      options: [],
      editor: EMPTY_EDITOR as never,
    });

    expect(lines.join("\n")).toContain("> Submit (answer all questions first)");
    expect(lines.join("\n")).toContain("  Cancel");
  });

  it("toggles multi-select options with space and enter, then commits with Next", () => {
    const multiQuestion = {
      id: "scope",
      label: "Scope",
      prompt: "What should change?",
      multiSelect: true,
      options: [
        { value: "docs", label: "Docs" },
        { value: "tests", label: "Tests" },
        { value: "code", label: "Code" },
      ],
    };
    const options = getRenderOptions(multiQuestion);
    let state = createQuestionnaireRuntimeState();

    const firstAction = routeQuestionnaireKey({
      data: " ",
      state,
      questions: [multiQuestion],
      options,
      allAnswered: false,
    });
    let result = reduceQuestionnaireRuntime(
      state,
      firstAction as Parameters<typeof reduceQuestionnaireRuntime>[1],
      [multiQuestion]
    );
    state = { ...result.state, optionIndex: 2 };

    const secondAction = routeQuestionnaireKey({
      data: "\r",
      state,
      questions: [multiQuestion],
      options,
      allAnswered: false,
    });
    result = reduceQuestionnaireRuntime(
      state,
      secondAction as Parameters<typeof reduceQuestionnaireRuntime>[1],
      [multiQuestion]
    );
    state = { ...result.state, optionIndex: 3 };

    const nextAction = routeQuestionnaireKey({
      data: "\r",
      state,
      questions: [multiQuestion],
      options,
      allAnswered: false,
    });
    result = reduceQuestionnaireRuntime(
      state,
      nextAction as Parameters<typeof reduceQuestionnaireRuntime>[1],
      [multiQuestion]
    );

    expect(result.effect).toEqual({ type: "submit", cancelled: false });
    expect(result.state.answers.get("scope")).toMatchObject({
      kind: "multi",
      value: ["docs", "code"],
      label: "Docs, Code",
      multi: true,
      selectedOptions: [
        { value: "docs", label: "Docs", index: 1 },
        { value: "code", label: "Code", index: 3 },
      ],
    });
  });

  it("renders previews automatically when single-select options include preview content", () => {
    const question = {
      id: "format",
      label: "Format",
      prompt: "Which format?",
      options: [
        {
          value: "json",
          label: "JSON",
          description: "Best for structured downstream parsing.",
          preview: "Structured JSON output",
        },
        { value: "text", label: "Text", preview: "Plain text output" },
      ],
    };
    const wideLines = renderQuestionnaireRuntime({
      width: 100,
      theme: PLAIN_THEME,
      questions: [question],
      state: createQuestionnaireRuntimeState(),
      options: getRenderOptions(question),
      editor: EMPTY_EDITOR as never,
      previewEnabled: true,
    });
    const customState = {
      ...createQuestionnaireRuntimeState(),
      optionIndex: 2,
    };
    const narrowLines = renderQuestionnaireRuntime({
      width: 60,
      theme: PLAIN_THEME,
      questions: [question],
      state: customState,
      options: getRenderOptions(question),
      editor: EMPTY_EDITOR as never,
      previewEnabled: true,
    });

    expect(wideLines.join("\n")).toContain("Options");
    expect(wideLines.join("\n")).toContain("Preview");
    expect(wideLines.join("\n")).toContain(
      "Best for structured downstream parsing."
    );
    expect(wideLines.join("\n")).toContain("Structured JSON output");
    expect(narrowLines.join("\n")).toContain("Type something.");
    expect(narrowLines.join("\n")).toContain(
      "Custom answer preview will appear after you type it."
    );
  });

  it("keeps wide preview separator aligned with ANSI themes and strips outer code fences", () => {
    const question = {
      id: "style",
      label: "Style",
      prompt: "Which preview style?",
      options: [
        {
          value: "compact",
          label: "Compact card",
          preview: "```text\n[ Compact ]\nFast\n```",
        },
        { value: "dashboard", label: "Dashboard layout" },
      ],
    };
    const lines = renderQuestionnaireRuntime({
      width: 100,
      theme: ANSI_THEME,
      questions: [question],
      state: createQuestionnaireRuntimeState(),
      options: getRenderOptions(question),
      editor: EMPTY_EDITOR as never,
      previewEnabled: true,
    });
    const previewRows = lines.filter((line) => line.includes("│"));
    const separatorColumns = previewRows.map((line) =>
      visibleWidth(line.slice(0, line.indexOf("│")))
    );

    expect(new Set(separatorColumns).size).toBe(1);
    expect(lines.join("\n")).toContain("[ Compact ]");
    expect(lines.join("\n")).not.toContain("```text");
  });

  it("persists preview note drafts and attaches them to the answer", () => {
    const question = {
      id: "format",
      label: "Format",
      prompt: "Which format?",
      options: [
        { value: "json", label: "JSON", preview: "Structured JSON output" },
        { value: "text", label: "Text" },
      ],
    };
    let state = createQuestionnaireRuntimeState();

    let result = reduceQuestionnaireRuntime(
      state,
      { type: "startNote", questionId: "format" },
      [question]
    );
    expect(result.state.notesMode).toBe(true);

    result = reduceQuestionnaireRuntime(
      result.state,
      { type: "saveNoteDraft", questionId: "format", value: "Prefer schemas" },
      [question]
    );
    state = result.state;

    result = reduceQuestionnaireRuntime(
      state,
      {
        type: "selectOption",
        question,
        option: question.options[0],
        optionIndex: 0,
      },
      [question]
    );

    expect(result.state.noteDrafts.get("format")).toBe("Prefer schemas");
    expect(result.state.answers.get("format")).toMatchObject({
      kind: "option",
      value: "json",
      preview: "Structured JSON output",
      note: "Prefer schemas",
    });
  });

  it("routes n to notes mode only for preview-capable questions", () => {
    const state = createQuestionnaireRuntimeState();
    const question = questions[0];

    expect(
      routeQuestionnaireKey({
        data: "n",
        state,
        questions: [question],
        options: getRenderOptions(question),
        allAnswered: false,
        previewNotesEnabled: true,
      })
    ).toEqual({ type: "startNote", questionId: "format" });
    expect(
      routeQuestionnaireKey({
        data: "n",
        state,
        questions: [question],
        options: getRenderOptions(question),
        allAnswered: false,
      })
    ).toBeNull();
  });

  it("renders multi-select options as checkboxes without custom input row", () => {
    const multiQuestion = {
      id: "scope",
      label: "Scope",
      prompt: "What should change?",
      multiSelect: true,
      options: [
        { value: "docs", label: "Docs" },
        { value: "tests", label: "Tests" },
      ],
    };
    const state = createQuestionnaireRuntimeState();
    state.multiSelections.set("scope", new Set(["tests"]));
    const lines = renderQuestionnaireRuntime({
      width: 80,
      theme: PLAIN_THEME,
      questions: [multiQuestion],
      state,
      options: getRenderOptions(multiQuestion),
      editor: EMPTY_EDITOR as never,
    });
    const output = lines.join("\n");

    expect(output).toContain("☐ Docs");
    expect(output).toContain("☑ Tests");
    expect(output).toContain("Next");
    expect(output).not.toContain("Type something.");
  });
});

describe("createQuestionnaireEnvelope", () => {
  it("returns LLM-facing summary and answer lookup", () => {
    const result = createQuestionnaireEnvelope({
      questions: [
        {
          id: "format",
          label: "Format",
          prompt: "Which format?",
          options: [
            { value: "json", label: "JSON" },
            { value: "text", label: "Text" },
          ],
        },
      ],
      answers: [
        {
          kind: "option",
          id: "format",
          value: "json",
          label: "JSON",
          wasCustom: false,
          index: 1,
        },
      ],
      cancelled: false,
    });

    expect(result.content[0]?.text).toBe(
      "User has answered your questions:\nFormat: user selected: 1. JSON\n\nYou can now continue with the user's answers in mind."
    );
    expect(result.details.summary).toBe("Format: user selected: 1. JSON");
    expect(result.details.answersByQuestion?.format).toMatchObject({
      value: "json",
      label: "JSON",
    });
  });

  it("formats preview and note metadata for single-select answers", () => {
    const result = createQuestionnaireEnvelope({
      questions: [
        {
          id: "format",
          label: "Format",
          prompt: "Which format?",
          options: [
            { value: "json", label: "JSON", preview: "Structured output" },
            { value: "text", label: "Text" },
          ],
        },
      ],
      answers: [
        {
          kind: "option",
          id: "format",
          value: "json",
          label: "JSON",
          wasCustom: false,
          index: 1,
          preview: "Structured output",
          note: "Use schemas",
        },
      ],
      cancelled: false,
    });

    expect(result.content[0]?.text).toBe(
      "User has answered your questions:\nFormat: user selected: 1. JSON Preview: Structured output Note: Use schemas\n\nYou can now continue with the user's answers in mind."
    );
    expect(result.details.answersByQuestion?.format).toMatchObject({
      preview: "Structured output",
      note: "Use schemas",
    });
  });

  it("formats multi-select answers in option order", () => {
    const result = createQuestionnaireEnvelope({
      questions: [
        {
          id: "scope",
          label: "Scope",
          prompt: "What should change?",
          multiSelect: true,
          options: [
            { value: "docs", label: "Docs" },
            { value: "tests", label: "Tests" },
            { value: "code", label: "Code" },
          ],
        },
      ],
      answers: [
        {
          kind: "multi",
          id: "scope",
          value: ["docs", "code"],
          label: "Docs, Code",
          wasCustom: false,
          multi: true,
          selectedOptions: [
            { value: "docs", label: "Docs", index: 1 },
            { value: "code", label: "Code", index: 3 },
          ],
        },
      ],
      cancelled: false,
    });

    expect(result.content[0]?.text).toBe(
      "User has answered your questions:\nScope: user selected: 1. Docs, 3. Code\n\nYou can now continue with the user's answers in mind."
    );
    expect(result.details.answersByQuestion?.scope).toMatchObject({
      value: ["docs", "code"],
      multi: true,
    });
  });
});

describe("questionnaire auto-redirect", () => {
  function setupHarness() {
    const handlers = new Map<string, (...args: any[]) => any>();
    const sendMessageCalls: Array<{ message: any; options: any }> = [];
    const appendEntryCalls: Array<{ type: string; data: any }> = [];
    const notifyCalls: Array<{ message: string; level: string }> = [];

    questionnaire({
      on(eventName: string, handler: (...args: any[]) => any) {
        handlers.set(eventName, handler);
      },
      registerCommand() {
        /* noop */
      },
      registerTool() {
        /* noop */
      },
      appendEntry(type: string, data: any) {
        appendEntryCalls.push({ type, data });
      },
      sendMessage(message: any, options: any) {
        sendMessageCalls.push({ message, options });
      },
    } as any);

    return {
      inputHandler: handlers.get("input"),
      agentEndHandler: handlers.get("agent_end"),
      sendMessageCalls,
      appendEntryCalls,
      notifyCalls,
    };
  }

  it("redirects an interactive plain-text clarification into a questionnaire follow-up turn", async () => {
    const {
      inputHandler,
      agentEndHandler,
      sendMessageCalls,
      appendEntryCalls,
      notifyCalls,
    } = setupHarness();

    expect(inputHandler).toBeDefined();
    expect(agentEndHandler).toBeDefined();

    await inputHandler?.({ source: "interactive" });
    await agentEndHandler?.(
      {
        messages: [
          {
            role: "assistant",
            stopReason: "stop",
            content: [
              {
                type: "text",
                text: "Which output format do you prefer?",
              },
            ],
          },
        ],
      },
      {
        hasUI: true,
        ui: {
          notify(message: string, level: string) {
            notifyCalls.push({ message, level });
          },
        },
      }
    );

    expect(notifyCalls).toEqual([
      {
        message:
          "Assistant asked a plain-text clarification. Auto-redirecting it to questionnaire.",
        level: "warning",
      },
    ]);

    expect(appendEntryCalls).toHaveLength(1);
    expect(appendEntryCalls[0]?.type).toBe("questionnaire-plain-text-miss");
    expect(appendEntryCalls[0]?.data).toMatchObject({
      source: "interactive",
      redirectedAlready: false,
      autoRedirected: true,
      text: "Which output format do you prefer?",
    });

    expect(sendMessageCalls).toEqual([
      {
        message: {
          customType: "questionnaire-auto-redirect",
          content: getQuestionnaireRedirectCorrectionMessage(),
          display: false,
        },
        options: { triggerTurn: true },
      },
    ]);
  });

  it("does not trigger another turn after a prior auto-redirect message already exists", async () => {
    const {
      inputHandler,
      agentEndHandler,
      sendMessageCalls,
      appendEntryCalls,
      notifyCalls,
    } = setupHarness();

    expect(inputHandler).toBeDefined();
    expect(agentEndHandler).toBeDefined();

    await inputHandler?.({ source: "interactive" });
    await agentEndHandler?.(
      {
        messages: [
          {
            role: "custom",
            customType: "questionnaire-auto-redirect",
          },
          {
            role: "assistant",
            stopReason: "stop",
            content: [
              {
                type: "text",
                text: "Which output format do you prefer?",
              },
            ],
          },
        ],
      },
      {
        hasUI: true,
        ui: {
          notify(message: string, level: string) {
            notifyCalls.push({ message, level });
          },
        },
      }
    );

    expect(notifyCalls).toEqual([
      {
        message:
          "Assistant still asked a plain-text clarification after redirect. Prefer questionnaire manually.",
        level: "warning",
      },
    ]);

    expect(appendEntryCalls).toHaveLength(1);
    expect(appendEntryCalls[0]?.type).toBe("questionnaire-plain-text-miss");
    expect(appendEntryCalls[0]?.data).toMatchObject({
      source: "interactive",
      redirectedAlready: true,
      autoRedirected: false,
      text: "Which output format do you prefer?",
    });

    expect(sendMessageCalls).toEqual([]);
  });
});
