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

function textOf(value: unknown): string | undefined {
  return (value as { content: { text: string }[] }).content[0]?.text;
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

  // Session 01a1ca6f: the agent put its explanation in thinking four times in a
  // row, because the refusal never said thinking is hidden from the user.
  it("says the explanation went to hidden thinking when only thinking has it", async () => {
    const { value } = await execute(COSTS_ASK, branchEndingWith(assistant()));
    expect(value).toMatchObject({
      content: [
        {
          type: "text",
          text: expect.stringContaining("is in a thinking block"),
        },
      ],
    });
  });

  it("omits the thinking hint when the reply has no thinking", async () => {
    const bare = {
      type: "message",
      message: {
        role: "assistant",
        content: [{ type: "toolCall", name: "ask", arguments: {} }],
      },
    };
    const { value, opened } = await execute(COSTS_ASK, [
      ...branchEndingWith(assistant("note")).slice(0, -1),
      bare,
    ]);
    expect(opened).toBe(false);
    const text = textOf(value);
    expect(text).toContain("this reply has no visible text");
    expect(text).not.toContain("thinking block");
  });

  it("tells the agent to stop calling ask on a repeat refusal in the same turn", async () => {
    const first = await execute(COSTS_ASK, branchEndingWith(assistant()));
    const firstText = textOf(first.value);
    expect(firstText).not.toContain("do not call ask again");

    const refusal = {
      type: "message",
      message: {
        role: "toolResult",
        toolName: "ask",
        content: [{ type: "text", text: firstText }],
      },
    };
    const second = await execute(COSTS_ASK, [
      ...branchEndingWith(assistant()),
      refusal,
      assistant(),
    ]);
    expect(second.opened).toBe(false);
    expect(textOf(second.value)).toContain("do not call ask again");

    // A new user message starts a new turn, so the count resets.
    const nextTurn = await execute(COSTS_ASK, [
      ...branchEndingWith(assistant()),
      refusal,
      { type: "message", message: { role: "user", content: "continue" } },
      assistant(),
    ]);
    expect(textOf(nextTurn.value)).not.toContain("do not call ask again");
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
