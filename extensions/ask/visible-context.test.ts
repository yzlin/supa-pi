import { describe, expect, it } from "bun:test";

import ask from "./index";

// Shape of a real miss (session 01a1ab6c): after tool calls and hidden
// thinking, the agent asked "Given those costs, ..." with no visible text, so
// the user could not see the costs.
const COSTS_ASK = {
  questions: [
    {
      id: "detect",
      prompt:
        "Given those costs, should I still add the GitHub-hosted detect job?",
      options: [
        {
          value: "drop",
          label: "Drop it: do checkout reuse + merge only",
          description: "Recommended. Leaves the gated workflows untouched.",
        },
        {
          value: "keep",
          label: "Do it anyway",
          description: "About 4 billed GitHub minutes per push.",
        },
      ],
    },
  ],
};

function registerTool() {
  let tool: { execute: (...args: unknown[]) => Promise<unknown> } | undefined;
  ask({
    registerTool(registered: typeof tool) {
      tool = registered;
    },
    registerCommand() {
      return;
    },
    on() {
      return;
    },
  } as never);
  if (!tool) {
    throw new Error("ask tool was not registered");
  }
  return tool;
}

function assistant(text?: string) {
  return {
    type: "message",
    message: {
      role: "assistant",
      content: [
        { type: "thinking", thinking: "The detect job costs 4 min per push." },
        ...(text ? [{ type: "text", text }] : []),
        { type: "toolCall", name: "ask", arguments: {} },
      ],
    },
  };
}

const toolResult = {
  type: "message",
  message: { role: "toolResult", content: [{ type: "text", text: "ok" }] },
};

// Earlier in the turn the agent wrote a progress note, then kept working.
function branchEndingWith(current: ReturnType<typeof assistant>) {
  return [
    { type: "message", message: { role: "user", content: "optimize CI" } },
    assistant("Progress: mapping which guards read the detect step."),
    toolResult,
    current,
  ];
}

async function execute(params: unknown, branch: unknown[]) {
  let opened = false;
  const value = await registerTool().execute(
    "tool-call",
    params,
    undefined,
    undefined,
    {
      hasUI: true,
      sessionManager: { getBranch: () => branch },
      ui: {
        custom() {
          opened = true;
          return;
        },
        notify() {
          return;
        },
      },
    },
  );
  return { value, opened };
}

describe("ask visible context", () => {
  it("refuses an ask whose reply has no visible text", async () => {
    const { value, opened } = await execute(
      COSTS_ASK,
      branchEndingWith(assistant()),
    );
    expect(opened).toBe(false);
    expect(value).toMatchObject({
      content: [
        {
          type: "text",
          text: expect.stringContaining("this reply has no visible text"),
        },
      ],
      details: { cancelled: true },
    });
  });

  it("refuses when only earlier tool calls in the same reply have results", async () => {
    const { opened } = await execute(COSTS_ASK, [
      ...branchEndingWith(assistant()),
      toolResult,
    ]);
    expect(opened).toBe(false);
  });

  it("opens the same ask once the reply states the costs", async () => {
    const { opened } = await execute(
      COSTS_ASK,
      branchEndingWith(
        assistant(
          "The detect job costs about 4 billed minutes per push and needs 3 guard rewrites.",
        ),
      ),
    );
    expect(opened).toBe(true);
  });

  it("opens an ask whose options carry previews", async () => {
    const withPreview = {
      questions: [
        {
          ...COSTS_ASK.questions[0],
          options: COSTS_ASK.questions[0]?.options.map((option) => ({
            ...option,
            preview: `${option.label}: about 4 billed minutes per push.`,
          })),
        },
      ],
    };
    const { opened } = await execute(
      withPreview,
      branchEndingWith(assistant()),
    );
    expect(opened).toBe(true);
  });
});
