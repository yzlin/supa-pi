import { describe, expect, it } from "bun:test";

import ask from "./index";
import {
  findUndefinedItemReferences,
  referencedItemNumbers,
} from "./item-references";

// Shape of a real miss: the agent enumerated the issue's four parts only in
// hidden reasoning, then asked the user to choose among them by number.
const UNSEEN_PARTS_ASK = {
  questions: [
    {
      id: "scope",
      prompt: "Which parts of the issue should I fix now?",
      options: [
        {
          value: "1+2",
          label: "1 + 2 (recommended)",
          description:
            "Cache trim-to-fit, plus stop size errors from clearing results. 3 and 4 become follow-ups.",
        },
        {
          value: "2",
          label: "2 only",
          description: "Small fix in this PR; cache change separately.",
        },
        {
          value: "all",
          label: "All four",
          description: "Includes the retry budget and a log-format check.",
        },
      ],
    },
  ],
};

const UNSEEN_PARTS_VISIBLE = [
  "address this issue",
  "The issue covers four separate problems. I'm reading the code paths before I pick a scope.",
  "I've found the error path. Next I'm checking where results are cleared.",
].join("\n");

const LISTED_PARTS_VISIBLE = `${UNSEEN_PARTS_VISIBLE}
The issue has four parts:
1. Cache refuses large entries instead of trimming them.
2. A size error clears the whole result list.
3. Retries use up the budget before the final step.
4. Some log lines have the wrong format — cause not yet known.`;

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

function branchWith(text: string) {
  return text.split("\n").map((line, index) => ({
    type: "message",
    message: {
      role: index === 0 ? "user" : "assistant",
      content:
        index === 0
          ? line
          : [
              { type: "thinking", thinking: "1. hidden part" },
              { type: "text", text: line },
            ],
    },
  }));
}

function execute(params: unknown, visible: string) {
  let opened = false;
  const result = registerTool().execute(
    "tool-call",
    params,
    undefined,
    undefined,
    {
      hasUI: true,
      sessionManager: { getBranch: () => branchWith(visible) },
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
  return result.then((value) => ({ value, opened }));
}

describe("ask numbered-item references", () => {
  it("refuses an ask whose numbered parts were never shown", async () => {
    const { value, opened } = await execute(
      UNSEEN_PARTS_ASK,
      UNSEEN_PARTS_VISIBLE,
    );
    expect(opened).toBe(false);
    expect(value).toMatchObject({
      content: [
        {
          type: "text",
          text: expect.stringContaining(
            "options refer to numbered items the user has not seen",
          ),
        },
      ],
      details: { cancelled: true },
    });
  });

  it("opens the same ask once the parts are listed in visible text", async () => {
    const { opened } = await execute(UNSEEN_PARTS_ASK, LISTED_PARTS_VISIBLE);
    expect(opened).toBe(true);
  });

  it("does not count hidden thinking as visible", () => {
    const problems = findUndefinedItemReferences(
      UNSEEN_PARTS_ASK.questions,
      "",
    );
    expect(problems.map((problem) => problem.missing)).toEqual([
      [1, 2],
      [2],
      [1, 2, 3, 4],
    ]);
  });

  it("accepts items defined in the option preview or as labelled headings", () => {
    const questions = [
      {
        id: "q",
        prompt: "Which option?",
        options: [
          { value: "a", label: "Option 1, browser computes it" },
          {
            value: "b",
            label: "Option 2",
            preview: "Option 2: split router, server returns it",
          },
        ],
      },
    ];
    expect(
      findUndefinedItemReferences(questions, "- **Option 1** — browser"),
    ).toEqual([]);
  });

  it("ignores self-describing numeric labels", () => {
    for (const label of [
      "15 seconds",
      "2-col grid desktop",
      "3 wrapped rows + Load more",
      "Option 1: 64 KiB / 128 KiB",
      "1, 2, 5 — no sketch",
      "Fix all 3 now",
      "#19 plus production's 4 fixes",
      "Edit all 3 repos + tests, no publish",
      "60 min, 4 vCPU VM",
      "3,000-character state budget",
      "1920 + 1080 px",
      "RPC-only fix (option 1)",
      "Recommend: Change all three",
      "Fix all 3, lock file for #2",
      "Clerk webhook (issue option 1)",
      "Option 2, split router, server returns it",
    ]) {
      expect([label, referencedItemNumbers(label)]).toEqual([label, []]);
    }
  });

  it("flags bare item-reference labels", () => {
    for (const [label, expected] of [
      ["1 + 2 (recommended)", [1, 2]],
      ["2 only", [2]],
      ["All four", [1, 2, 3, 4]],
      ["All 5 (recommended)", [1, 2, 3, 4, 5]],
      ["Fix 2 and 3 only", [2, 3]],
      ["Option 3", [3]],
      ["1 and 3", [1, 3]],
    ] as const) {
      expect([label, referencedItemNumbers(label)]).toEqual([
        label,
        [...expected],
      ]);
    }
  });
});
