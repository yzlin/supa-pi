import { describe, expect, it } from "bun:test";
import { cpSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import {
  type Api,
  type AssistantMessage,
  createAssistantMessageEventStream,
  type Model,
} from "@earendil-works/pi-ai/compat";
import { ModelRegistry, ModelRuntime } from "@earendil-works/pi-coding-agent";

import type { EvalCase } from "./index";
import {
  CANONICAL_SUBTRACT_TEST,
  isContainedRelativePath,
  planRuns,
  runAllowedFixtureTest,
  runVariant,
} from "./runner";

const fixturePath = resolve(
  fileURLToPath(new URL(".", import.meta.url)),
  "fixtures/sample-project"
);
const modelRegistry = new ModelRegistry(await ModelRuntime.create());
describe("run planning", () => {
  it("plans one candidate arm for the bounded suite and preserves paired ordering", () => {
    const caseIds = Array.from({ length: 8 }, (_, index) => `case-${index}`);
    const singleArm = planRuns(caseIds, 3, true);

    expect(singleArm).toHaveLength(24);
    expect(singleArm.every((run) => run.variant === "candidate")).toBe(true);
    expect(planRuns(["a"], 1)).toEqual([
      { caseId: "a", repetition: 1, variant: "candidate" },
      { caseId: "a", repetition: 1, variant: "baseline" },
    ]);
  });
});

describe("canonical fixture test execution", () => {
  it("semantically checks code and rejects tampered regression tests", () => {
    const deadWorkspace = mkdtempSync(join(tmpdir(), "supa-pi-dead-test-"));
    cpSync(fixturePath, deadWorkspace, { recursive: true });
    const mathPath = join(deadWorkspace, "src/math.ts");
    writeFileSync(
      mathPath,
      `${readFileSync(mathPath, "utf8")}\n// export function add(left: number, right: number): number { return left + right; }\nfunction dead(left: number, right: number) { if (false) return left + right; }\n`
    );
    expect(runAllowedFixtureTest(deadWorkspace).exitCode).toBe(1);

    writeFileSync(
      mathPath,
      readFileSync(join(fixturePath, "src/math.ts"), "utf8").replace(
        "return left - right",
        "return left + right"
      )
    );
    expect(runAllowedFixtureTest(deadWorkspace).exitCode).toBe(0);

    const changedTestWorkspace = mkdtempSync(
      join(tmpdir(), "supa-pi-changed-test-")
    );
    cpSync(fixturePath, changedTestWorkspace, { recursive: true });
    writeFileSync(
      join(changedTestWorkspace, "tests/math.case.ts"),
      'import { test, expect } from "bun:test";\ntest("weakened", () => expect(true).toBe(true));\n'
    );
    expect(runAllowedFixtureTest(changedTestWorkspace).exitCode).toBe(1);
  });

  it("semantically simulates canonical test-first creation without host execution", () => {
    const workspace = mkdtempSync(join(tmpdir(), "supa-pi-created-test-"));
    cpSync(fixturePath, workspace, { recursive: true });
    const command = "bun test tests/subtract.case.ts";

    expect(runAllowedFixtureTest(workspace, command)).toMatchObject({
      exitCode: 1,
    });
    writeFileSync(
      join(workspace, "tests/subtract.case.ts"),
      CANONICAL_SUBTRACT_TEST
    );
    const red = runAllowedFixtureTest(workspace, command);
    expect(red.exitCode).toBe(1);
    expect(red.output.toString()).toContain("1 failed, 0 passed");

    const mathPath = join(workspace, "src/math.ts");
    writeFileSync(
      mathPath,
      `${readFileSync(mathPath, "utf8")}\nexport function subtract(left: number, right: number): number {\n  return left - right;\n}\n`
    );
    expect(runAllowedFixtureTest(workspace, command).exitCode).toBe(1);
    writeFileSync(
      mathPath,
      readFileSync(mathPath, "utf8").replace(
        "return left - right;",
        "return left + right;"
      )
    );
    const green = runAllowedFixtureTest(workspace, command);
    expect(green.exitCode).toBe(0);
    expect(green.output.toString()).toContain("1 passed, 0 failed");
    expect(
      readFileSync(join(workspace, "tests/subtract.case.ts"), "utf8")
    ).toBe(CANONICAL_SUBTRACT_TEST);

    writeFileSync(
      mathPath,
      "export function add(left: number, right: number): number { return ((left) + (right)); }\n\nexport function multiply(left: number, right: number): number { return ((left * right)); }\n\nexport function subtract(left: number, right: number): number { return (left - (right)); }\n"
    );
    expect(runAllowedFixtureTest(workspace, command).exitCode).toBe(0);

    for (const expressions of [
      ["right + left", "left * right", "left - right"],
      ["left + right + 1 - 1", "left * right", "left - right"],
      ["left + right", "left * right", "left - right + left - left"],
      ["left + right + left - left", "left * right", "left - right"],
      ["left + right", "-(right * -left)", "left - right"],
      ["left + right", "left * right", "left + (0 - right)"],
      [
        "left + right + (left - 9007199254740992) - (left - 9007199254740992)",
        "left * right",
        "left - right",
      ],
    ]) {
      writeFileSync(
        mathPath,
        `export function add(left: number, right: number): number { return ${expressions[0]}; }\n\nexport function multiply(left: number, right: number): number { return ${expressions[1]}; }\n\nexport function subtract(left: number, right: number): number { return ${expressions[2]}; }\n`
      );
      expect(runAllowedFixtureTest(workspace, command).exitCode).toBe(1);
    }

    writeFileSync(
      mathPath,
      "export function add(left: number, right: number): number { return right + left; }\n\nexport function subtract(left: number, right: number): number { return left + (0 - right); }\n"
    );
    expect(runAllowedFixtureTest(workspace, command).exitCode).toBe(1);

    cpSync(fixturePath, workspace, { recursive: true });
    writeFileSync(
      join(workspace, "tests/subtract.case.ts"),
      CANONICAL_SUBTRACT_TEST
    );
    writeFileSync(
      join(workspace, "src/math.ts"),
      "export function add(left: number, right: number): number {\n  return left + right;\n}\n\nexport function multiply(left: number, right: number): number {\n  return left * right;\n}\n\nexport function subtract(left: number, right: number): number {\n  return left - right;\n}\n"
    );
    writeFileSync(join(workspace, "tests/math.case.ts"), "corrupted\n");
    expect(runAllowedFixtureTest(workspace, command).exitCode).toBe(1);
  });

  it("never executes and rejects code outside the closed fixture grammar", () => {
    const workspace = mkdtempSync(join(tmpdir(), "supa-pi-malicious-test-"));
    cpSync(fixturePath, workspace, { recursive: true });
    const marker = join(workspace, "host-code-ran");
    const declarations =
      "export function add(left: number, right: number): number { return left + right; }\nexport function multiply(left: number, right: number): number { return left * right; }\n";

    for (const residue of [
      `Bun.write(${JSON.stringify(marker)}, "owned");`,
      "while (true) {}",
      'throw new Error("owned");',
      'if (false) { Bun.write("dead", "code"); }',
      "function dead() { return 1; }",
      declarations,
    ]) {
      writeFileSync(
        join(workspace, "src/math.ts"),
        `${residue}\n${declarations}`
      );
      expect(runAllowedFixtureTest(workspace).exitCode).toBe(1);
    }
    expect(() => readFileSync(marker)).toThrow();

    writeFileSync(
      join(workspace, "src/math.ts"),
      `// fixture implementation\n${declarations}`
    );
    expect(runAllowedFixtureTest(workspace).exitCode).toBe(0);
  });
});

const UUID_V7_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

function createMessage(
  model: Model<Api>,
  content: AssistantMessage["content"],
  stopReason: "stop" | "toolUse" = "stop"
): AssistantMessage {
  return {
    role: "assistant",
    content,
    api: model.api,
    provider: model.provider,
    model: model.id,
    usage: {
      input: 20,
      output: 8,
      reasoning: 2,
      cacheRead: 5,
      cacheWrite: 0,
      totalTokens: 33,
      cost: {
        input: 0,
        output: 0,
        cacheRead: 0,
        cacheWrite: 0,
        total: 0,
      },
    },
    stopReason,
    timestamp: Date.now(),
  };
}

function createMessageStream(message: AssistantMessage) {
  const stream = createAssistantMessageEventStream();
  const reason = message.stopReason;
  if (reason !== "stop" && reason !== "toolUse") {
    throw new Error(`unsupported test stop reason: ${reason}`);
  }
  queueMicrotask(() => {
    stream.push({ type: "start", partial: message });
    stream.push({ type: "done", reason, message });
  });
  return stream;
}

function createSuccessfulStream(model: Model<Api>) {
  return createMessageStream(
    createMessage(model, [
      {
        type: "text",
        text: "Evidence: src/math.ts uses subtraction.",
      },
    ])
  );
}

function createAskToolCall(id: string, multiSelect?: boolean) {
  return {
    type: "toolCall" as const,
    id,
    name: "ask",
    arguments: {
      questions: [
        {
          id: "fix-gate",
          prompt: "Apply the scoped fix?",
          options: [
            { value: "approve", label: "Approve scoped fix" },
            { value: "stop", label: "Stop and clean probes" },
          ],
          ...(multiSelect === undefined ? {} : { multiSelect }),
        },
      ],
    },
  };
}

describe("workspace containment", () => {
  it("rejects POSIX and Windows traversal paths", () => {
    expect(isContainedRelativePath("../secret", "/")).toBe(false);
    expect(isContainedRelativePath("..\\secret", "\\")).toBe(false);
    expect(isContainedRelativePath("C:\\secret", "\\")).toBe(false);
    expect(isContainedRelativePath("src\\math.ts", "\\")).toBe(true);
  });
});

describe("runVariant", () => {
  it("runs a prompt in a fresh fixture and captures model telemetry", async () => {
    const model = modelRegistry.find("openai", "gpt-4o");
    if (!model) {
      throw new Error("test model is unavailable");
    }
    const evalCase: EvalCase = {
      id: "fake-run",
      workload: "explanation",
      promptPath: "extensions/core-prompt/prompt.md",
      task: "Explain the defect.",
      tools: [],
      checks: [
        {
          type: "outputIncludes",
          value: "src/math.ts",
          domain: "evidence",
          weight: 1,
        },
      ],
    };

    let observedSessionId: string | undefined;
    const result = await runVariant({
      evalCase,
      variant: "candidate",
      repetition: 1,
      promptContent: "Be evidence driven.",
      promptSha256: "candidate-hash",
      fixturePath,
      model,
      thinking: "medium",
      timeoutMs: 5000,
      maxTurns: 3,
      getApiKey: () => Promise.resolve("test-key"),
      streamFn: (selectedModel, _context, options) => {
        observedSessionId = options?.sessionId;
        return createSuccessfulStream(selectedModel);
      },
    });

    expect(result.completed).toBe(true);
    expect(result.sessionId).toBe(observedSessionId);
    expect(result.sessionId).toMatch(UUID_V7_PATTERN);
    expect(result.score.overall).toBe(1);
    expect(result.output).toContain("src/math.ts");
    expect(result.metrics).toMatchObject({
      inputTokens: 20,
      outputTokens: 8,
      reasoningTokens: 2,
      cacheReadTokens: 5,
      turns: 1,
    });
  });

  it("forwards and records priority service tier", async () => {
    const model = modelRegistry.find("openai", "gpt-4o");
    if (!model) {
      throw new Error("test model is unavailable");
    }
    let observedServiceTier: string | undefined;
    const result = await runVariant({
      evalCase: {
        id: "priority-run",
        workload: "explanation",
        promptPath: "extensions/core-prompt/prompt.md",
        task: "Explain the defect.",
        tools: [],
        checks: [
          {
            type: "outputIncludes",
            value: "src/math.ts",
            domain: "evidence",
            weight: 1,
          },
        ],
      },
      variant: "candidate",
      repetition: 1,
      promptContent: "Be evidence driven.",
      promptSha256: "candidate-hash",
      fixturePath,
      model,
      thinking: "medium",
      serviceTier: "priority",
      timeoutMs: 5000,
      maxTurns: 3,
      getApiKey: () => Promise.resolve("test-key"),
      streamFn: (selectedModel, _context, options) => {
        observedServiceTier = (options as { serviceTier?: string })
          ?.serviceTier;
        options?.onPayload?.({ service_tier: "priority" }, selectedModel);
        return createSuccessfulStream(selectedModel);
      },
    });

    expect(observedServiceTier).toBe("priority");
    expect(result.serviceTier).toBe("priority");
    expect(result.payloadServiceTier).toBe("priority");
  });

  it("terminates after structured_output without accepting a later provider turn", async () => {
    const model = modelRegistry.find("openai", "gpt-4o");
    if (!model) {
      throw new Error("test model is unavailable");
    }
    let providerCalls = 0;
    const result = await runVariant({
      evalCase: {
        id: "structured-termination",
        workload: "focused bug fix",
        promptPath: "skills/tdd-workflow/SKILL.md",
        task: "Report completion.",
        tools: ["structured_output"],
        checks: [
          {
            type: "structuredOutput",
            expectedStatus: "done",
            domain: "evidence",
            weight: 1,
          },
        ],
      },
      variant: "candidate",
      repetition: 1,
      promptContent: "---\nname: tdd-workflow\n---\nRun tests.",
      promptSha256: "candidate-hash",
      fixturePath,
      model,
      thinking: "medium",
      timeoutMs: 5000,
      maxTurns: 3,
      getApiKey: () => Promise.resolve("test-key"),
      streamFn: (selectedModel) => {
        providerCalls += 1;
        if (providerCalls > 1) {
          return createMessageStream(
            createMessage(selectedModel, [
              { type: "text", text: "later work must not be accepted" },
            ])
          );
        }
        return createMessageStream(
          createMessage(
            selectedModel,
            [
              {
                type: "toolCall",
                id: "structured-1",
                name: "structured_output",
                arguments: {
                  status: "done",
                  summary: "Finished.",
                  filesTouched: [],
                  validation: [],
                  followUps: [],
                  blockers: [],
                },
              },
            ],
            "toolUse"
          )
        );
      },
    });

    expect(providerCalls).toBe(1);
    expect(result.output).not.toContain("later work");
    expect(result.toolCalls).toHaveLength(1);
    expect(result.taskPassed).toBe(true);
  });

  it("executes fixture-bound tools and records the trajectory", async () => {
    const model = modelRegistry.find("openai", "gpt-4o");
    if (!model) {
      throw new Error("test model is unavailable");
    }
    let providerCall = 0;
    const result = await runVariant({
      evalCase: {
        id: "tool-run",
        workload: "exploration",
        promptPath: "agents/explorer.md",
        task: "Read src/math.ts and report the defect.",
        tools: ["read"],
        checks: [
          {
            type: "toolCalled",
            name: "read",
            domain: "task",
            weight: 1,
          },
        ],
      },
      variant: "baseline",
      repetition: 1,
      promptContent: "---\ndescription: Explore\n---\nRead carefully.",
      promptSha256: "baseline-hash",
      fixturePath,
      model,
      thinking: "low",
      timeoutMs: 5000,
      maxTurns: 3,
      getApiKey: () => Promise.resolve("test-key"),
      streamFn: (selectedModel) => {
        providerCall += 1;
        if (providerCall === 1) {
          return createMessageStream(
            createMessage(
              selectedModel,
              [
                {
                  type: "toolCall",
                  id: "read-1",
                  name: "read",
                  arguments: { path: "src/math.ts" },
                },
              ],
              "toolUse"
            )
          );
        }
        return createMessageStream(
          createMessage(selectedModel, [
            {
              type: "text",
              text: "src/math.ts subtracts right from left.",
            },
          ])
        );
      },
    });

    expect(result.completed).toBe(true);
    expect(result.toolCalls).toEqual([
      expect.objectContaining({
        name: "read",
        args: { path: "src/math.ts" },
        assistantTurn: 1,
        isError: false,
        resultText: expect.stringContaining("return left - right;"),
      }),
    ]);
    expect(result.metrics).toMatchObject({ turns: 2, toolCalls: 1 });
  });

  it("records an expected red bash result for exact reproduction scoring", async () => {
    const model = modelRegistry.find("openai", "gpt-4o");
    if (!model) {
      throw new Error("test model is unavailable");
    }
    let providerCall = 0;
    const result = await runVariant({
      evalCase: {
        id: "exact-red-reproduction",
        workload: "codebase exploration",
        promptPath: "skills/diagnose/SKILL.md",
        task: "Reproduce the exact failure.",
        tools: ["bash"],
        checks: [
          {
            type: "toolCallMatchesBeforeAssistantMatches",
            name: "bash",
            args: { command: "bun test tests/math.case.ts" },
            resultPattern: "Expected: 12[\\s\\S]*Received: 2",
            isError: true,
            assistantPattern: "root cause|candidate|hypothesis|probe",
            assistantFlags: "i",
            domain: "task",
            weight: 1,
          },
        ],
      },
      variant: "candidate",
      repetition: 1,
      promptContent: "---\nname: diagnose\n---\nReproduce first.",
      promptSha256: "candidate-hash",
      fixturePath,
      model,
      thinking: "medium",
      timeoutMs: 5000,
      maxTurns: 2,
      getApiKey: () => Promise.resolve("test-key"),
      streamFn: (selectedModel) => {
        providerCall += 1;
        if (providerCall === 1) {
          return createMessageStream(
            createMessage(
              selectedModel,
              [
                {
                  type: "toolCall",
                  id: "bash-red-1",
                  name: "bash",
                  arguments: { command: "bun test tests/math.case.ts" },
                },
              ],
              "toolUse"
            )
          );
        }
        return createMessageStream(
          createMessage(selectedModel, [
            { type: "text", text: "Diagnosis: Incomplete" },
          ])
        );
      },
    });

    expect(result.score.overall).toBe(1);
    expect(result.toolCalls).toContainEqual(
      expect.objectContaining({
        name: "bash",
        isError: true,
        resultText: expect.stringContaining("Expected: 12"),
      })
    );
  });

  it("rejects causal reasoning before the matching red reproduction", async () => {
    const model = modelRegistry.find("openai", "gpt-4o");
    if (!model) {
      throw new Error("test model is unavailable");
    }
    let providerCall = 0;
    const result = await runVariant({
      evalCase: {
        id: "reproduction-before-reasoning",
        workload: "codebase exploration",
        promptPath: "skills/diagnose/SKILL.md",
        task: "Reproduce before causal reasoning.",
        tools: ["bash"],
        checks: [
          {
            type: "toolCallMatchesBeforeAssistantMatches",
            name: "bash",
            args: { command: "bun test tests/math.case.ts" },
            resultPattern: "Expected: 12[\\s\\S]*Received: 2",
            isError: true,
            assistantPattern: "root cause|candidate|hypothesis|probe",
            assistantFlags: "i",
            domain: "task",
            weight: 1,
          },
        ],
      },
      variant: "candidate",
      repetition: 1,
      promptContent: "---\nname: diagnose\n---\nReproduce first.",
      promptSha256: "candidate-hash",
      fixturePath,
      model,
      thinking: "medium",
      timeoutMs: 5000,
      maxTurns: 3,
      getApiKey: () => Promise.resolve("test-key"),
      streamFn: (selectedModel) => {
        providerCall += 1;
        if (providerCall === 1) {
          return createMessageStream(
            createMessage(
              selectedModel,
              [
                { type: "text", text: "The root cause is subtraction." },
                {
                  type: "toolCall",
                  id: "bash-preliminary-1",
                  name: "bash",
                  arguments: { command: "pwd" },
                },
              ],
              "toolUse"
            )
          );
        }
        if (providerCall === 2) {
          return createMessageStream(
            createMessage(
              selectedModel,
              [
                {
                  type: "toolCall",
                  id: "bash-red-2",
                  name: "bash",
                  arguments: { command: "bun test tests/math.case.ts" },
                },
              ],
              "toolUse"
            )
          );
        }
        return createMessageStream(
          createMessage(selectedModel, [
            { type: "text", text: "Diagnosis: Incomplete" },
          ])
        );
      },
    });

    expect(result.score.overall).toBe(0);
    expect(result.assistantMessages).toEqual([
      { text: "The root cause is subtraction.", assistantTurn: 1 },
      { text: "Diagnosis: Incomplete", assistantTurn: 3 },
    ]);
    expect(result.score.checks[0]?.evidence).toContain(
      "preceded matching bash call"
    );
  });

  it("supplies approval through one exact ask gate before editing", async () => {
    const model = modelRegistry.find("openai", "gpt-4o");
    if (!model) {
      throw new Error("test model is unavailable");
    }
    let providerCall = 0;
    const result = await runVariant({
      evalCase: {
        id: "ask-approve",
        workload: "focused bug fix",
        promptPath: "skills/diagnose/SKILL.md",
        task: "Use the required fix gate.",
        tools: ["ask", "edit", "bash"],
        askResponse: "Approve scoped fix",
        checks: [
          { type: "askGate", domain: "task", weight: 1 },
          {
            type: "toolCalledAfter",
            name: "edit",
            after: "ask",
            domain: "tests",
            weight: 1,
          },
          {
            type: "toolCalledAfter",
            name: "bash",
            after: "edit",
            args: { command: "bun test tests/math.case.ts" },
            domain: "tests",
            weight: 1,
          },
          {
            type: "workspaceChangesOnly",
            paths: ["src/math.ts"],
            domain: "tests",
            weight: 1,
          },
        ],
      },
      variant: "candidate",
      repetition: 1,
      promptContent: "---\nname: diagnose\n---\nGate fixes.",
      promptSha256: "candidate-hash",
      fixturePath,
      model,
      thinking: "medium",
      timeoutMs: 5000,
      maxTurns: 4,
      getApiKey: () => Promise.resolve("test-key"),
      streamFn: (selectedModel) => {
        providerCall += 1;
        if (providerCall === 1) {
          return createMessageStream(
            createMessage(
              selectedModel,
              [createAskToolCall("ask-1")],
              "toolUse"
            )
          );
        }
        if (providerCall === 2) {
          return createMessageStream(
            createMessage(
              selectedModel,
              [
                {
                  type: "toolCall",
                  id: "edit-1",
                  name: "edit",
                  arguments: {
                    path: "src/math.ts",
                    oldText: "return left - right;",
                    newText: "return left + right;",
                  },
                },
              ],
              "toolUse"
            )
          );
        }
        if (providerCall === 3) {
          return createMessageStream(
            createMessage(
              selectedModel,
              [
                {
                  type: "toolCall",
                  id: "bash-1",
                  name: "bash",
                  arguments: { command: "bun test tests/math.case.ts" },
                },
              ],
              "toolUse"
            )
          );
        }
        return createMessageStream(
          createMessage(selectedModel, [
            { type: "text", text: "Diagnosis: Proven\nFix: Verified" },
          ])
        );
      },
    });

    expect(result.score.overall).toBe(1);
    expect(result.toolCalls.map((call) => call.name)).toEqual([
      "ask",
      "edit",
      "bash",
    ]);
    expect(result.toolCalls.map((call) => call.assistantTurn)).toEqual([
      1, 2, 3,
    ]);
    expect(result.toolCalls[1]).toMatchObject({
      mutationTargets: ["src/math.ts"],
      hasProductionTargets: true,
      mutationProven: true,
      mutationDelta: [{ path: "src/math.ts", status: "changed" }],
    });
  });

  it("rejects ask approval and edit from the same assistant turn", async () => {
    const model = modelRegistry.find("openai", "gpt-4o");
    if (!model) {
      throw new Error("test model is unavailable");
    }
    let providerCall = 0;
    const result = await runVariant({
      evalCase: {
        id: "ask-same-turn",
        workload: "focused bug fix",
        promptPath: "skills/diagnose/SKILL.md",
        task: "Use the required fix gate.",
        tools: ["ask", "edit"],
        askResponse: "Approve scoped fix",
        checks: [
          {
            type: "toolCalledAfter",
            name: "edit",
            after: "ask",
            domain: "tests",
            weight: 1,
          },
        ],
      },
      variant: "candidate",
      repetition: 1,
      promptContent: "---\nname: diagnose\n---\nGate fixes.",
      promptSha256: "candidate-hash",
      fixturePath,
      model,
      thinking: "medium",
      timeoutMs: 5000,
      maxTurns: 2,
      getApiKey: () => Promise.resolve("test-key"),
      streamFn: (selectedModel) => {
        providerCall += 1;
        if (providerCall === 1) {
          return createMessageStream(
            createMessage(
              selectedModel,
              [
                createAskToolCall("ask-same-turn-1"),
                {
                  type: "toolCall",
                  id: "edit-same-turn-1",
                  name: "edit",
                  arguments: {
                    path: "src/math.ts",
                    oldText: "return left - right;",
                    newText: "return left + right;",
                  },
                },
              ],
              "toolUse"
            )
          );
        }
        return createMessageStream(
          createMessage(selectedModel, [{ type: "text", text: "done" }])
        );
      },
    });

    expect(result.score.overall).toBe(0);
    expect(result.toolCalls.map((call) => call.assistantTurn)).toEqual([1, 1]);
    for (const call of result.toolCalls) {
      expect(call.startOrder).toBeNumber();
      expect(call.endOrder).toBeNumber();
      expect(call.endOrder!).toBeGreaterThan(call.startOrder!);
    }
  });

  it("supplies the stop response without allowing workspace edits", async () => {
    const model = modelRegistry.find("openai", "gpt-4o");
    if (!model) {
      throw new Error("test model is unavailable");
    }
    let providerCall = 0;
    const result = await runVariant({
      evalCase: {
        id: "ask-stop",
        workload: "focused bug fix",
        promptPath: "skills/diagnose/SKILL.md",
        task: "Use the required fix gate.",
        tools: ["ask", "edit", "write"],
        askResponse: "Stop and clean probes",
        checks: [
          { type: "askGate", domain: "task", weight: 1 },
          { type: "toolNotCalled", name: "edit", domain: "tests", weight: 1 },
          {
            type: "workspaceUnchanged",
            domain: "tests",
            weight: 1,
          },
        ],
      },
      variant: "candidate",
      repetition: 1,
      promptContent: "---\nname: diagnose\n---\nGate fixes.",
      promptSha256: "candidate-hash",
      fixturePath,
      model,
      thinking: "medium",
      timeoutMs: 5000,
      maxTurns: 3,
      getApiKey: () => Promise.resolve("test-key"),
      streamFn: (selectedModel) => {
        providerCall += 1;
        if (providerCall === 1) {
          return createMessageStream(
            createMessage(
              selectedModel,
              [createAskToolCall("ask-stop-1", false)],
              "toolUse"
            )
          );
        }
        return createMessageStream(
          createMessage(selectedModel, [
            { type: "text", text: "Diagnosis: Proven\nFix: Not attempted" },
          ])
        );
      },
    });

    expect(result.score.overall).toBe(1);
    expect(result.toolCalls.map((call) => call.name)).toEqual(["ask"]);
  });

  it("blocks model file access outside the temporary workspace", async () => {
    const model = modelRegistry.find("openai", "gpt-4o");
    if (!model) {
      throw new Error("test model is unavailable");
    }
    let providerCall = 0;
    const result = await runVariant({
      evalCase: {
        id: "blocked-path",
        workload: "security",
        promptPath: "extensions/core-prompt/prompt.md",
        task: "Read a file.",
        tools: ["read"],
        checks: [
          {
            type: "outputIncludes",
            value: "blocked",
            domain: "quality",
            weight: 1,
          },
        ],
      },
      variant: "candidate",
      repetition: 1,
      promptContent: "Stay inside the workspace.",
      promptSha256: "candidate-hash",
      fixturePath,
      model,
      thinking: "low",
      timeoutMs: 5000,
      maxTurns: 3,
      getApiKey: () => Promise.resolve("test-key"),
      streamFn: (selectedModel) => {
        providerCall += 1;
        if (providerCall === 1) {
          return createMessageStream(
            createMessage(
              selectedModel,
              [
                {
                  type: "toolCall",
                  id: "read-outside",
                  name: "read",
                  arguments: { path: "/etc/passwd" },
                },
              ],
              "toolUse"
            )
          );
        }
        return createMessageStream(
          createMessage(selectedModel, [
            {
              type: "text",
              text: "The outside-workspace read was blocked.",
            },
          ])
        );
      },
    });

    expect(result.toolCalls[0]).toMatchObject({
      name: "read",
      args: { path: "/etc/passwd" },
      isError: true,
    });
    expect(result.metrics.toolErrors).toBe(1);
  });
});
