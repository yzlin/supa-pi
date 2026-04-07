import { describe, expect, it } from "bun:test";

import { visibleWidth } from "@mariozechner/pi-tui";

import questionnaire, {
  getQuestionnaireRedirectCorrectionMessage,
  getRenderOptions,
  wrapQuestionnaireText,
} from "./questionnaire";

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
      registerCommand() {},
      registerTool() {},
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
