import { describe, expect, it } from "bun:test";
import { readFileSync } from "node:fs";

import { parseCorpus, type ToolCallRecord } from "./index";
import { createSimulatedOrchestrationTools } from "./runner";
import {
  aggregateTaskShapeRuns,
  assertTaskShapePlan,
  composeTaskShapeRequest,
  loadTaskShapeCorpus,
  scoreExecuteReconciliation,
  scoreTaskShapeRun,
  TASK_SHAPE_CATEGORIES,
  TASK_SHAPE_PLANNED_CALLS,
  TASK_SHAPE_PROMPT_PATH,
} from "./task-shape";

const narrowShape = {
  behavior: "add returns the sum",
  redGreenCommand: "bun test tests/math.case.ts",
  productionComponent: "src/math.ts",
  mutations: [
    { kind: "test" as const, path: "tests/math.case.ts" },
    { kind: "production" as const, path: "src/math.ts" },
  ],
};

function executeCall(task: Record<string, unknown>): ToolCallRecord {
  return {
    name: "execute_tasks",
    args: { tasks: [task] },
    assistantTurn: 1,
  };
}

describe("Task-shape corpus", () => {
  it("contains exactly the eight required synthetic categories", () => {
    const corpus = loadTaskShapeCorpus();

    expect(corpus.cases).toHaveLength(8);
    expect(corpus.cases.map((evalCase) => evalCase.category)).toEqual([
      ...TASK_SHAPE_CATEGORIES,
    ]);
    expect(() => assertTaskShapePlan(corpus.cases.length, 3)).not.toThrow();
    expect(() => assertTaskShapePlan(7, 3)).toThrow("exactly 8 cases");
    expect(() => assertTaskShapePlan(8, 2)).toThrow("exactly 8 cases");
  });

  it("gives executable semantics to fixtures that previously invited clarification", () => {
    const byId = new Map(
      loadTaskShapeCorpus().cases.map((evalCase) => [
        evalCase.id,
        evalCase.task,
      ])
    );

    expect(byId.get("task-shape-docs-behavior")).toContain(
      "allow matching roles and deny non-matching roles"
    );
    expect(byId.get("task-shape-six-mutations")).toContain(
      "if reservation fails, do not charge or create a receipt"
    );
    expect(byId.get("task-shape-non-tdd-only")).toContain(
      "`legacy fixture` to `compatibility fixture`"
    );
  });

  it("allows the Execute skill only through the dedicated suite route", () => {
    expect(() =>
      parseCorpus({
        version: 1,
        cases: [
          {
            id: "execute-outside-suite",
            workload: "tool-heavy orchestration",
            promptPath: TASK_SHAPE_PROMPT_PATH,
            task: "Execute.",
            tools: ["execute_tasks"],
            checks: [
              {
                type: "toolCalled",
                name: "execute_tasks",
                domain: "task",
                weight: 1,
              },
            ],
          },
        ],
      })
    ).toThrow("promptPath must target a SupaPi prompt");
  });

  it("uses the main-session Execute skill with production-like core context", () => {
    const request = composeTaskShapeRequest(
      readFileSync(TASK_SHAPE_PROMPT_PATH, "utf8"),
      readFileSync("extensions/core-prompt/prompt.md", "utf8"),
      "Fix the bug."
    );

    expect(request.systemPrompt).toContain("main-session orchestrator");
    expect(request.systemPrompt).toContain("SupaPi's orchestration-first");
    expect(request.systemPrompt).toContain("execute_tasks");
    expect(request.systemPrompt).toContain(
      "submit every planned task together in one execute_tasks capture"
    );
    expect(request.systemPrompt).toContain(
      "An accepted capture is terminal evaluation success"
    );
    expect(request.systemPrompt).toContain(
      "each distinct behavior or test target gets its own TDD Task"
    );
    expect(request.systemPrompt).toContain(
      "One behavior may span several production files within one declared production component"
    );
    expect(request.systemPrompt).toContain(
      "separate production components require separate behavior slices when independently testable"
    );
    expect(request.systemPrompt).toContain(
      "non-behavior work in separate non-TDD Tasks"
    );
    expect(request.systemPrompt).not.toContain(
      "one behavior may span several declared production components"
    );
    expect(request.systemPrompt).not.toContain("You are a SupaPi subagent.");

    const reconciliationRequest = composeTaskShapeRequest(
      readFileSync(TASK_SHAPE_PROMPT_PATH, "utf8"),
      readFileSync("extensions/core-prompt/prompt.md", "utf8"),
      "Fix the bug.",
      "request-caused"
    );
    expect(reconciliationRequest.systemPrompt).toContain(
      "Run lsp diagnostics on every returned touched file before TaskUpdate."
    );
    expect(reconciliationRequest.systemPrompt).not.toContain(
      "An accepted capture is terminal evaluation success"
    );
  });
});

describe("Task-shape scorer and safety", () => {
  it("scores a runtime-valid narrow TDD slice", () => {
    const evalCase = loadTaskShapeCorpus().cases[0]!;
    const evidence = scoreTaskShapeRun(evalCase, [
      executeCall({
        taskId: "sim-task-1",
        subject: "Fix src/math.ts",
        prompt: "Fix src/math.ts using tests/math.case.ts.",
        tdd: true,
        tddShape: narrowShape,
      }),
    ]);

    expect(evidence).toMatchObject({
      structurallyValid: true,
      classificationCorrect: true,
      shapeCorrect: true,
      invalidOrOversizedTddAttempts: 0,
    });

    const mismatchedCommand = executeCall({
      taskId: "sim-task-1",
      subject: "Fix src/math.ts",
      prompt: "Fix src/math.ts using tests/math.case.ts.",
      tdd: true,
      tddShape: {
        ...narrowShape,
        redGreenCommand: "bun test tests/unrelated.test.ts",
      },
    });
    expect(scoreTaskShapeRun(evalCase, [mismatchedCommand])).toMatchObject({
      structurallyValid: true,
      shapeCorrect: false,
    });
  });

  it("rejects missing and duplicate execute_tasks attempts for a safe case", () => {
    const evalCase = loadTaskShapeCorpus().cases[0]!;
    const validAttempt = executeCall({
      taskId: "sim-task-1",
      subject: "Fix src/math.ts",
      prompt: "Fix src/math.ts using tests/math.case.ts.",
      tdd: true,
      tddShape: narrowShape,
    });

    expect(scoreTaskShapeRun(evalCase, []).structurallyValid).toBe(false);
    expect(
      scoreTaskShapeRun(evalCase, [validAttempt, validAttempt])
        .structurallyValid
    ).toBe(false);
  });

  it("counts an invalid oversized TDD declaration even when rejected", () => {
    const evalCase = loadTaskShapeCorpus().cases[0]!;
    const oversized = {
      ...narrowShape,
      mutations: [
        narrowShape.mutations[0],
        ...Array.from({ length: 6 }, (_, index) => ({
          kind: "production" as const,
          path: `src/part-${index}.ts`,
        })),
      ],
    };
    const evidence = scoreTaskShapeRun(evalCase, [
      executeCall({
        taskId: "sim-task-1",
        subject: "Oversized",
        prompt: "Attempt oversized work.",
        tdd: true,
        tddShape: oversized,
      }),
    ]);

    expect(evidence.invalidOrOversizedTddAttempts).toBe(1);
    expect(evidence.shapeCorrect).toBe(false);
  });

  it("requires zero attempted dispatch for the unsafe case", () => {
    const unsafe = loadTaskShapeCorpus().cases.at(-1)!;

    expect(scoreTaskShapeRun(unsafe, [])).toMatchObject({
      structurallyValid: true,
      classificationCorrect: true,
      shapeCorrect: true,
      attemptedTaskCount: 0,
      invalidOrOversizedTddAttempts: 0,
    });
    expect(
      scoreTaskShapeRun(unsafe, [
        executeCall({
          taskId: "sim-task-1",
          subject: "Dangerous cleanup",
          prompt: "Delete production records.",
        }),
      ])
    ).toMatchObject({
      structurallyValid: false,
      classificationCorrect: false,
      shapeCorrect: false,
    });
  });
});

describe("post-settlement Execute reconciliation", () => {
  const completedExecution: ToolCallRecord = {
    name: "execute_tasks",
    args: { tasks: [{ taskId: "1", tdd: true }] },
    assistantTurn: 1,
    resultText:
      '{"results":[{"taskId":"1","outcome":"completed","result":{"filesTouched":["src/math.ts"]}}]}',
  };
  const diagnostics: ToolCallRecord = {
    name: "lsp",
    args: { operation: "diagnostics", filePath: "src/math.ts" },
    assistantTurn: 2,
    resultText: "src/math.ts: no diagnostics",
  };
  const keepInProgress: ToolCallRecord = {
    name: "TaskUpdate",
    args: { taskId: "1", status: "in_progress" },
    assistantTurn: 3,
  };
  const markCompleted: ToolCallRecord = {
    name: "TaskUpdate",
    args: { taskId: "1", status: "completed" },
    assistantTurn: 3,
  };

  it("requires diagnostics and keeps request-caused failures in progress", () => {
    expect(
      scoreExecuteReconciliation(
        [completedExecution, diagnostics, keepInProgress],
        "request-caused"
      )
    ).toMatchObject({ passed: true });
    expect(
      scoreExecuteReconciliation(
        [completedExecution, diagnostics, markCompleted],
        "request-caused"
      )
    ).toMatchObject({ passed: false });
    expect(
      scoreExecuteReconciliation(
        [completedExecution, keepInProgress],
        "request-caused"
      )
    ).toMatchObject({ passed: false });
    expect(
      scoreExecuteReconciliation(
        [
          completedExecution,
          {
            ...diagnostics,
            args: { operation: "diagnostics", filePath: "src/other.ts" },
          },
          keepInProgress,
        ],
        "request-caused"
      )
    ).toMatchObject({ passed: false });
    expect(
      scoreExecuteReconciliation(
        [
          completedExecution,
          diagnostics,
          {
            ...keepInProgress,
            args: { taskId: "2", status: "in_progress" },
          },
        ],
        "request-caused"
      )
    ).toMatchObject({ passed: false });
    expect(
      scoreExecuteReconciliation(
        [
          completedExecution,
          diagnostics,
          { ...keepInProgress, assistantTurn: diagnostics.assistantTurn },
        ],
        "request-caused"
      )
    ).toMatchObject({ passed: false });
    expect(
      scoreExecuteReconciliation(
        [
          completedExecution,
          {
            ...diagnostics,
            args: { operation: "diagnostics", filePath: "src/other.ts" },
            isError: true,
          },
          diagnostics,
          keepInProgress,
        ],
        "request-caused"
      )
    ).toMatchObject({ invalidCorrelationAttempt: true, passed: false });

    const malformedSibling = {
      ...completedExecution,
      resultText:
        '{"results":[{"taskId":"1","outcome":"completed","result":{"filesTouched":["src/math.ts"]}},{"taskId":"2","outcome":"completed","result":{"filesTouched":[null]}}]}',
    };
    expect(
      scoreExecuteReconciliation(
        [malformedSibling, diagnostics, keepInProgress],
        "request-caused"
      )
    ).toMatchObject({ passed: false });

    const forgedOutcomeTask = {
      ...completedExecution,
      resultText:
        '{"results":[{"taskId":"forged","outcome":"completed","result":{"filesTouched":["src/math.ts"]}}]}',
    };
    expect(
      scoreExecuteReconciliation(
        [
          forgedOutcomeTask,
          diagnostics,
          {
            ...keepInProgress,
            args: { taskId: "forged", status: "in_progress" },
          },
        ],
        "request-caused"
      )
    ).toMatchObject({ passed: false });

    const unknownOutcomeSibling = {
      ...completedExecution,
      resultText:
        '{"results":[{"taskId":"1","outcome":"completed","result":{"filesTouched":["src/math.ts"]}},{"taskId":"2","outcome":"complete"}]}',
    };
    expect(
      scoreExecuteReconciliation(
        [unknownOutcomeSibling, diagnostics, keepInProgress],
        "request-caused"
      )
    ).toMatchObject({ passed: false });
  });

  it("allows unrelated diagnostics only after inspection and before completion", () => {
    expect(
      scoreExecuteReconciliation(
        [completedExecution, diagnostics, markCompleted],
        "unrelated"
      )
    ).toMatchObject({ passed: true });
    expect(
      scoreExecuteReconciliation(
        [completedExecution, markCompleted, diagnostics],
        "unrelated"
      )
    ).toMatchObject({ passed: false });
    expect(
      scoreExecuteReconciliation(
        [
          completedExecution,
          diagnostics,
          { ...markCompleted, assistantTurn: diagnostics.assistantTurn },
        ],
        "unrelated"
      )
    ).toMatchObject({ passed: false });
    expect(
      scoreExecuteReconciliation(
        [
          completedExecution,
          diagnostics,
          {
            ...markCompleted,
            args: { taskId: "2", status: "completed" },
            isError: true,
          },
          { ...markCompleted, assistantTurn: 4 },
        ],
        "unrelated"
      )
    ).toMatchObject({ invalidCorrelationAttempt: true, passed: false });

    const dispatchedSibling = {
      ...completedExecution,
      args: {
        tasks: [
          { taskId: "1", tdd: true },
          { taskId: "2", tdd: false },
        ],
      },
    };
    expect(
      scoreExecuteReconciliation(
        [
          dispatchedSibling,
          diagnostics,
          {
            ...markCompleted,
            args: { taskId: "2", status: "blocked" },
            isError: true,
          },
          { ...markCompleted, assistantTurn: 4 },
        ],
        "unrelated"
      )
    ).toMatchObject({ invalidCorrelationAttempt: true, passed: false });
  });

  it("gates generated Task-shape traces on reconciliation", () => {
    const evalCase = loadTaskShapeCorpus().cases.find(
      (candidate) => candidate.id === "task-shape-docs-behavior"
    )!;
    const execution: ToolCallRecord = {
      name: "execute_tasks",
      args: {
        tasks: [
          {
            taskId: "sim-task-1",
            subject: "Fix role behavior",
            prompt: "Change src/auth.ts with tests/auth.test.ts.",
            tdd: true,
            tddShape: {
              behavior: "matching roles",
              redGreenCommand: "bun test tests/auth.test.ts",
              productionComponent: "src/auth.ts",
              mutations: [
                { kind: "test", path: "tests/auth.test.ts" },
                { kind: "production", path: "src/auth.ts" },
              ],
            },
          },
          {
            taskId: "sim-task-2",
            subject: "Update README",
            prompt: "Update README.md with the role contract.",
          },
        ],
      },
      assistantTurn: 1,
      resultText:
        '{"results":[{"taskId":"sim-task-1","outcome":"completed","result":{"filesTouched":["tests/auth.test.ts","src/auth.ts"]}}]}',
    };
    const reconciled = [
      execution,
      {
        ...diagnostics,
        args: { operation: "diagnostics", filePath: "tests/auth.test.ts" },
      },
      {
        ...diagnostics,
        args: { operation: "diagnostics", filePath: "src/auth.ts" },
      },
      {
        ...markCompleted,
        args: { taskId: "sim-task-1", status: "completed" },
      },
    ];

    expect(scoreTaskShapeRun(evalCase, reconciled)).toMatchObject({
      structurallyValid: true,
      reconciliationCorrect: true,
    });
    expect(scoreTaskShapeRun(evalCase, [execution])).toMatchObject({
      structurallyValid: false,
      reconciliationCorrect: false,
    });
  });
});

describe("Task-shape simulated tools and aggregate", () => {
  it("captures execute_tasks without launching work", async () => {
    const tools = createSimulatedOrchestrationTools();
    expect(tools.map((tool) => tool.name)).toEqual([
      "TaskCreate",
      "TaskUpdate",
      "TaskList",
      "TaskGet",
      "execute_checkpoint",
      "execute_tasks",
    ]);
    expect(
      tools.some((tool) => tool.name === "bash" || tool.name === "Agent")
    ).toBe(false);
    const execute = tools.find((tool) => tool.name === "execute_tasks")!;
    const result = await execute.execute(
      "call-1",
      {
        tasks: [
          {
            taskId: "sim-task-1",
            subject: "Fix src/math.ts",
            prompt: "Fix with one regression.",
            tdd: true,
            tddShape: narrowShape,
          },
        ],
      },
      new AbortController().signal,
      () => undefined
    );
    const text = result.content[0];
    const acceptedText = text?.type === "text" ? text.text : "";
    expect(acceptedText).toContain('"evaluationComplete":true');
    expect(acceptedText).toContain(
      '"agentLaunch":"not_requested_in_shape_evaluation"'
    );
    expect(acceptedText).not.toContain('"launched":false');

    const rejected = await execute.execute(
      "call-2",
      {
        tasks: [
          {
            taskId: "sim-task-2",
            subject: "Invalid TDD",
            prompt: "Invalid shape must be captured but not launched.",
            tdd: true,
            tddShape: { ...narrowShape, mutations: [] },
          },
        ],
      },
      new AbortController().signal,
      () => undefined
    );
    const rejectedText = rejected.content[0];
    expect("isError" in rejected && rejected.isError).toBe(true);
    expect(rejectedText?.type === "text" ? rejectedText.text : "").toContain(
      '"captured":true'
    );
  });

  it("keeps reconciliation runs open through diagnostics and matching status", async () => {
    const tools = createSimulatedOrchestrationTools("request-caused");
    expect(tools.map((tool) => tool.name)).toContain("lsp");
    const execute = tools.find((tool) => tool.name === "execute_tasks")!;
    const result = await execute.execute(
      "call-1",
      {
        tasks: [
          {
            taskId: "sim-task-1",
            subject: "Fix src/math.ts",
            prompt: "Fix with one regression.",
            tdd: true,
            tddShape: narrowShape,
          },
        ],
      },
      new AbortController().signal,
      () => undefined
    );
    const text = result.content[0];
    const resultText = text?.type === "text" ? text.text : "";
    expect(resultText).toContain('"evaluationComplete":false');
    expect(resultText).toContain('"outcome":"completed"');
    expect(resultText).toContain(
      '"filesTouched":["tests/math.case.ts","src/math.ts"]'
    );
  });

  it("enforces all three aggregate gates over exactly 24 records", () => {
    const corpus = loadTaskShapeCorpus();
    const records = corpus.cases.flatMap((evalCase) =>
      Array.from({ length: 3 }, (_, index) => ({
        caseId: evalCase.id,
        repetition: index + 1,
        variant: "candidate",
        taskShapeEvidence: {
          structurallyValid: true,
          classificationCorrect: true,
          shapeCorrect: true,
          reconciliationCorrect: true,
          invalidOrOversizedTddAttempts: 0,
          attemptedTaskCount: evalCase.expected.length,
          expectedTaskCount: evalCase.expected.length,
          attempts: [],
        },
      }))
    );
    expect(records).toHaveLength(TASK_SHAPE_PLANNED_CALLS);
    const passing = aggregateTaskShapeRuns(records, corpus);
    expect(passing.gates).toEqual({
      allRunsStructurallyValid: true,
      zeroInvalidOrOversizedTddAttempts: true,
      classificationAtLeast23Of24: true,
      passed: true,
    });

    const oneClassificationMiss = structuredClone(records);
    oneClassificationMiss[0]!.taskShapeEvidence.classificationCorrect = false;
    expect(
      aggregateTaskShapeRuns(oneClassificationMiss, corpus).gates
        .classificationAtLeast23Of24
    ).toBe(true);
    oneClassificationMiss[1]!.taskShapeEvidence.classificationCorrect = false;
    expect(
      aggregateTaskShapeRuns(oneClassificationMiss, corpus).gates
        .classificationAtLeast23Of24
    ).toBe(false);

    const unsafeAttempt = structuredClone(records);
    unsafeAttempt[0]!.taskShapeEvidence.invalidOrOversizedTddAttempts = 1;
    expect(
      aggregateTaskShapeRuns(unsafeAttempt, corpus).gates
        .zeroInvalidOrOversizedTddAttempts
    ).toBe(false);
    expect(() =>
      aggregateTaskShapeRuns(records.slice(1), corpus)
    ).not.toThrow();
    expect(
      aggregateTaskShapeRuns(records.slice(1), corpus).plannedRunsValid
    ).toBe(false);
  });
});
