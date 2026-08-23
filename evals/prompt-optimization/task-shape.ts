import { readFileSync } from "node:fs";
import { readdir, readFile } from "node:fs/promises";
import { join } from "node:path";

import { parseFrontmatter } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { Value } from "typebox/value";

import {
  type TaskMutation,
  validateTaskShape,
} from "../../extensions/execute/task-shape";
import { CORE_EVAL_BASE_PROMPT, type ToolCallRecord } from "./index";

export const TASK_SHAPE_CASE_COUNT = 8;
export const TASK_SHAPE_REPETITIONS = 3;
export const TASK_SHAPE_PLANNED_CALLS = 24;
export const TASK_SHAPE_PROMPT_PATH = "skills/execute/SKILL.md";
const TASK_SHAPE_ID_PATTERN = /^task-shape-[a-z0-9-]+$/;
const EXECUTOR_OUTCOMES = new Set([
  "completed",
  "needs_verification",
  "failed",
]);
export const TASK_SHAPE_CATEGORIES = [
  "narrow bug",
  "broad feature",
  "multi-component behavior",
  "docs plus behavior",
  "multiple test targets",
  "six-mutation budget edge",
  "non-TDD-only work",
  "unsafe or ambiguous shape",
] as const;

export type TaskShapeCategory = (typeof TASK_SHAPE_CATEGORIES)[number];

export type ExpectedTaskSlice =
  | {
      classification: "tdd";
      testPath: string;
      redGreenCommand: string;
      productionPaths: string[];
    }
  | { classification: "non-tdd"; paths: string[] };

export interface TaskShapeCase {
  id: string;
  category: TaskShapeCategory;
  task: string;
  expected: ExpectedTaskSlice[];
  reconciliation?: ExecuteDiagnosticOwnership;
}

export interface TaskShapeCorpus {
  version: 1;
  cases: TaskShapeCase[];
}

export interface TaskShapeAttemptEvidence {
  callIndex: number;
  requestClosed: boolean;
  taskCount: number;
  tasks: Array<{
    taskId?: string;
    subject?: string;
    prompt?: string;
    tdd: boolean;
    tddShapeDeclared: boolean;
    tddShapeValid: boolean;
    redGreenCommand?: string;
    mutations: TaskMutation[];
    errors: string[];
  }>;
}

export interface TaskShapeRunEvidence {
  structurallyValid: boolean;
  classificationCorrect: boolean;
  shapeCorrect: boolean;
  reconciliationCorrect: boolean;
  invalidOrOversizedTddAttempts: number;
  attemptedTaskCount: number;
  expectedTaskCount: number;
  attempts: TaskShapeAttemptEvidence[];
}

export interface TaskShapeAggregate {
  plannedRunsValid: boolean;
  structuralValidRuns: number;
  classificationCorrectRuns: number;
  invalidOrOversizedTddAttempts: number;
  gates: {
    allRunsStructurallyValid: boolean;
    zeroInvalidOrOversizedTddAttempts: boolean;
    classificationAtLeast23Of24: boolean;
    passed: boolean;
  };
}

export type ExecuteDiagnosticOwnership = "request-caused" | "unrelated";

export interface ExecuteReconciliationEvidence {
  executionCompleted: boolean;
  diagnosticsAfterExecution: boolean;
  keptInProgressAfterDiagnostics: boolean;
  completedAfterDiagnostics: boolean;
  invalidCorrelationAttempt: boolean;
  passed: boolean;
}

export function scoreExecuteReconciliation(
  toolCalls: ToolCallRecord[],
  ownership: ExecuteDiagnosticOwnership
): ExecuteReconciliationEvidence {
  const executionIndex = toolCalls.findIndex(
    (call) => call.name === "execute_tasks" && !call.isError
  );
  let completedTasks: Array<{ taskId: string; filesTouched: string[] }> = [];
  try {
    const parsed = JSON.parse(toolCalls[executionIndex]?.resultText ?? "");
    if (isRecord(parsed) && Array.isArray(parsed.results)) {
      const tasks: Array<{ taskId: string; filesTouched: string[] }> = [];
      const taskIds = new Set<string>();
      let valid = parsed.results.length > 0;
      for (const entry of parsed.results) {
        if (
          !isRecord(entry) ||
          typeof entry.taskId !== "string" ||
          !entry.taskId ||
          typeof entry.outcome !== "string" ||
          !EXECUTOR_OUTCOMES.has(entry.outcome) ||
          taskIds.has(entry.taskId)
        ) {
          valid = false;
          break;
        }
        taskIds.add(entry.taskId);
        if (entry.outcome !== "completed") {
          continue;
        }
        const result = isRecord(entry.result) ? entry.result : undefined;
        if (
          !(result && Array.isArray(result.filesTouched)) ||
          result.filesTouched.length === 0 ||
          !result.filesTouched.every(
            (path) => typeof path === "string" && path.length > 0
          ) ||
          new Set(result.filesTouched).size !== result.filesTouched.length
        ) {
          valid = false;
          break;
        }
        tasks.push({
          taskId: entry.taskId,
          filesTouched: result.filesTouched as string[],
        });
      }
      completedTasks = valid ? tasks : [];
    }
  } catch {
    completedTasks = [];
  }
  const executionCall = toolCalls[executionIndex];
  const executionTurn = executionCall?.assistantTurn ?? -1;
  const completedByTaskId = new Map(
    completedTasks.map((task) => [task.taskId, task])
  );
  const expectedFiles = new Set(
    completedTasks.flatMap((task) => task.filesTouched)
  );
  const dispatchedTddTaskIds = new Set(
    Array.isArray(executionCall?.args.tasks)
      ? executionCall.args.tasks.flatMap((task) =>
          isRecord(task) && typeof task.taskId === "string" && task.tdd === true
            ? [task.taskId]
            : []
        )
      : []
  );
  const completedTaskIds = new Set(completedTasks.map((task) => task.taskId));
  const outcomesMatchDispatch =
    dispatchedTddTaskIds.size === completedTaskIds.size &&
    [...dispatchedTddTaskIds].every((taskId) => completedTaskIds.has(taskId));
  const executionCompleted =
    executionIndex >= 0 && completedTasks.length > 0 && outcomesMatchDispatch;
  const expectedStatus =
    ownership === "request-caused" ? "in_progress" : "completed";
  let invalidCorrelationAttempt = false;
  for (const [index, call] of toolCalls.entries()) {
    if (index <= executionIndex) {
      continue;
    }
    if (call.name === "lsp" && call.args.operation === "diagnostics") {
      if (
        call.isError ||
        call.assistantTurn <= executionTurn ||
        typeof call.args.filePath !== "string" ||
        !expectedFiles.has(call.args.filePath)
      ) {
        invalidCorrelationAttempt = true;
      }
      continue;
    }
    if (call.name !== "TaskUpdate") {
      continue;
    }
    if (
      typeof call.args.taskId !== "string" ||
      !completedByTaskId.has(call.args.taskId)
    ) {
      invalidCorrelationAttempt = true;
      continue;
    }
    const completedTask = completedByTaskId.get(call.args.taskId)!;
    const diagnosticsCompleteBeforeUpdate = completedTask.filesTouched.every(
      (filePath) =>
        toolCalls.some(
          (diagnostic, diagnosticIndex) =>
            diagnosticIndex > executionIndex &&
            diagnosticIndex < index &&
            diagnostic.name === "lsp" &&
            diagnostic.args.operation === "diagnostics" &&
            diagnostic.args.filePath === filePath &&
            !diagnostic.isError &&
            diagnostic.assistantTurn > executionTurn &&
            diagnostic.assistantTurn < call.assistantTurn
        )
    );
    if (
      call.isError ||
      call.args.status !== expectedStatus ||
      call.assistantTurn <= executionTurn ||
      !diagnosticsCompleteBeforeUpdate
    ) {
      invalidCorrelationAttempt = true;
    }
  }
  const taskEvidence = completedTasks.map(({ taskId, filesTouched }) => {
    const diagnosticIndexes = filesTouched.map((filePath) =>
      toolCalls.findIndex(
        (call, index) =>
          index > executionIndex &&
          call.assistantTurn > executionTurn &&
          call.name === "lsp" &&
          call.args.operation === "diagnostics" &&
          call.args.filePath === filePath &&
          !call.isError
      )
    );
    const diagnosticsComplete = diagnosticIndexes.every((index) => index >= 0);
    const lastDiagnosticIndex = Math.max(-1, ...diagnosticIndexes);
    const lastDiagnosticTurn = Math.max(
      -1,
      ...diagnosticIndexes.map((index) => toolCalls[index]?.assistantTurn ?? -1)
    );
    const inProgressIndex = toolCalls.findIndex(
      (call, index) =>
        index > lastDiagnosticIndex &&
        call.assistantTurn > lastDiagnosticTurn &&
        call.name === "TaskUpdate" &&
        call.args.taskId === taskId &&
        call.args.status === "in_progress"
    );
    const completedIndex = toolCalls.findIndex(
      (call, index) =>
        index > executionIndex &&
        call.assistantTurn > lastDiagnosticTurn &&
        call.name === "TaskUpdate" &&
        call.args.taskId === taskId &&
        call.args.status === "completed"
    );
    return {
      diagnosticsComplete,
      keptInProgress: inProgressIndex > lastDiagnosticIndex,
      completedAfterDiagnostics: completedIndex > lastDiagnosticIndex,
      completedAtAll: completedIndex >= 0,
    };
  });
  const diagnosticsAfterExecution =
    executionCompleted &&
    taskEvidence.every((task) => task.diagnosticsComplete);
  const keptInProgressAfterDiagnostics =
    diagnosticsAfterExecution &&
    taskEvidence.every((task) => task.keptInProgress);
  const completedAfterDiagnostics =
    diagnosticsAfterExecution &&
    taskEvidence.every((task) => task.completedAfterDiagnostics);
  const passed =
    executionCompleted &&
    !invalidCorrelationAttempt &&
    diagnosticsAfterExecution &&
    (ownership === "request-caused"
      ? keptInProgressAfterDiagnostics &&
        taskEvidence.every((task) => !task.completedAtAll)
      : completedAfterDiagnostics);
  return {
    executionCompleted,
    diagnosticsAfterExecution,
    keptInProgressAfterDiagnostics,
    completedAfterDiagnostics,
    invalidCorrelationAttempt,
    passed,
  };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function stringArray(value: unknown): value is string[] {
  return (
    Array.isArray(value) &&
    value.length > 0 &&
    value.every((entry) => typeof entry === "string" && entry.length > 0)
  );
}

export function parseTaskShapeCorpus(value: unknown): TaskShapeCorpus {
  if (!(isRecord(value) && value.version === 1 && Array.isArray(value.cases))) {
    throw new Error("Task-shape corpus must be a version 1 object with cases");
  }
  if (value.cases.length !== TASK_SHAPE_CASE_COUNT) {
    throw new Error(
      `Task-shape corpus requires exactly ${TASK_SHAPE_CASE_COUNT} cases`
    );
  }
  const ids = new Set<string>();
  const categories = new Set<TaskShapeCategory>();
  const cases = value.cases.map((entry, index): TaskShapeCase => {
    if (!isRecord(entry)) {
      throw new Error(`Task-shape case ${index} must be an object`);
    }
    if (
      typeof entry.id !== "string" ||
      !TASK_SHAPE_ID_PATTERN.test(entry.id) ||
      ids.has(entry.id)
    ) {
      throw new Error(
        `Task-shape case ${index} has an invalid or duplicate id`
      );
    }
    ids.add(entry.id);
    if (!TASK_SHAPE_CATEGORIES.includes(entry.category as TaskShapeCategory)) {
      throw new Error(`Task-shape case ${index} has an invalid category`);
    }
    categories.add(entry.category as TaskShapeCategory);
    if (typeof entry.task !== "string" || entry.task.trim().length === 0) {
      throw new Error(`Task-shape case ${index} requires a task`);
    }
    if (!Array.isArray(entry.expected) || entry.expected.length > 4) {
      throw new Error(
        `Task-shape case ${index} expected slices must contain 0-4 entries`
      );
    }
    const expected = entry.expected.map(
      (slice, sliceIndex): ExpectedTaskSlice => {
        if (!isRecord(slice)) {
          throw new Error(
            `Task-shape case ${index} slice ${sliceIndex} must be an object`
          );
        }
        if (
          slice.classification === "tdd" &&
          typeof slice.testPath === "string" &&
          typeof slice.redGreenCommand === "string" &&
          slice.redGreenCommand.length > 0 &&
          stringArray(slice.productionPaths)
        ) {
          const candidate = {
            behavior: "fixture behavior",
            redGreenCommand: slice.redGreenCommand,
            productionComponent: slice.productionPaths[0]!,
            mutations: [
              { kind: "test" as const, path: slice.testPath },
              ...slice.productionPaths.map((path) => ({
                kind: "production" as const,
                path,
              })),
            ],
          };
          if (!validateTaskShape(candidate).ok) {
            throw new Error(
              `Task-shape case ${index} slice ${sliceIndex} is not runtime-valid`
            );
          }
          return {
            classification: "tdd",
            testPath: slice.testPath,
            redGreenCommand: slice.redGreenCommand,
            productionPaths: slice.productionPaths,
          };
        }
        if (slice.classification === "non-tdd" && stringArray(slice.paths)) {
          return { classification: "non-tdd", paths: slice.paths };
        }
        throw new Error(
          `Task-shape case ${index} slice ${sliceIndex} is invalid`
        );
      }
    );
    let reconciliation: ExecuteDiagnosticOwnership | undefined;
    if (entry.reconciliation !== undefined) {
      if (
        entry.reconciliation !== "request-caused" &&
        entry.reconciliation !== "unrelated"
      ) {
        throw new Error(
          `Task-shape case ${index} has an invalid reconciliation mode`
        );
      }
      reconciliation = entry.reconciliation;
    }
    return {
      id: entry.id,
      category: entry.category as TaskShapeCategory,
      task: entry.task,
      expected,
      ...(reconciliation ? { reconciliation } : {}),
    };
  });
  if (
    categories.size !== TASK_SHAPE_CATEGORIES.length ||
    !TASK_SHAPE_CATEGORIES.every((category) => categories.has(category))
  ) {
    throw new Error(
      "Task-shape corpus must cover each required category exactly once"
    );
  }
  return { version: 1, cases };
}

export function loadTaskShapeCorpus(): TaskShapeCorpus {
  return parseTaskShapeCorpus(
    JSON.parse(
      readFileSync(new URL("./task-shape-corpus.json", import.meta.url), "utf8")
    )
  );
}

export function assertTaskShapePlan(
  caseCount: number,
  repetitions: number
): void {
  if (
    caseCount !== TASK_SHAPE_CASE_COUNT ||
    repetitions !== TASK_SHAPE_REPETITIONS ||
    caseCount * repetitions !== TASK_SHAPE_PLANNED_CALLS
  ) {
    throw new Error(
      "Task-shape suite must plan exactly 8 cases × 3 repetitions = 24 calls"
    );
  }
}

export function composeTaskShapeRequest(
  skillContent: string,
  corePromptContent: string,
  task: string,
  reconciliation?: ExecuteDiagnosticOwnership
): { systemPrompt: string; userPrompt: string } {
  const skill = parseFrontmatter(skillContent).body.trim();
  const evaluationContract = reconciliation
    ? `You are the main-session orchestrator, not an executor subagent. Evaluate the supplied plan through bounded simulated orchestration tools. Submit every planned task together in one execute_tasks capture. The simulator returns completed TDD outcomes with touched files. Run lsp diagnostics on every returned touched file before TaskUpdate. The diagnostic ownership is ${reconciliation}. For request-caused diagnostics, keep the matching task in_progress; for unrelated diagnostics, mark it completed only after inspection. The tools create no pi-tasks, checkpoints, files, or Agents, and no real Agent launches. Never claim simulated work changed files or validations ran. Do not use arbitrary shell execution.`
    : "You are the main-session orchestrator, not an executor subagent. Evaluate the supplied plan through bounded simulated orchestration tools. This suite evaluates only the complete pre-dispatch task graph: after safety checks, submit every planned task together in one execute_tasks capture, even when real execution would sequence dependencies. An accepted capture is terminal evaluation success, not an execution failure. The tools create no pi-tasks, checkpoints, files, or Agents, and no real Agent launches. Never claim simulated work changed files or validations ran. Do not use arbitrary shell execution.";
  return {
    systemPrompt: [
      CORE_EVAL_BASE_PROMPT,
      corePromptContent.trim(),
      "# Main-session Execute Workflow evaluation",
      evaluationContract,
      skill,
    ].join("\n\n"),
    userPrompt: `<plan>\n${task}\n</plan>`,
  };
}

const simulatedTaskSchema = Type.Object(
  {
    taskId: Type.String({ minLength: 1, maxLength: 200 }),
    subject: Type.String({ minLength: 1, maxLength: 500 }),
    prompt: Type.String({ minLength: 1, maxLength: 20_000 }),
    tdd: Type.Optional(Type.Boolean()),
    tddShape: Type.Optional(Type.Unknown()),
  },
  { additionalProperties: false }
);

export const simulatedExecuteTasksSchema = Type.Object(
  { tasks: Type.Array(simulatedTaskSchema, { minItems: 1, maxItems: 4 }) },
  { additionalProperties: false }
);

export const simulatedTaskCreateSchema = Type.Object(
  {
    subject: Type.String({ minLength: 1, maxLength: 500 }),
    description: Type.String({ minLength: 1, maxLength: 20_000 }),
    agentType: Type.Literal("executor"),
  },
  { additionalProperties: false }
);

export const simulatedTaskUpdateSchema = Type.Object(
  {
    taskId: Type.String({ minLength: 1, maxLength: 200 }),
    status: Type.Union([
      Type.Literal("pending"),
      Type.Literal("in_progress"),
      Type.Literal("completed"),
      Type.Literal("blocked"),
    ]),
  },
  { additionalProperties: false }
);

export const simulatedTaskIdSchema = Type.Object(
  { taskId: Type.String({ minLength: 1, maxLength: 200 }) },
  { additionalProperties: false }
);

export const simulatedCheckpointSchema = Type.Object(
  {
    op: Type.Union([Type.Literal("load"), Type.Literal("save")]),
    canonicalPlan: Type.String({ minLength: 1, maxLength: 20_000 }),
    checkpoint: Type.Optional(Type.Unknown()),
  },
  { additionalProperties: false }
);

function inspectAttempt(
  call: ToolCallRecord,
  callIndex: number
): TaskShapeAttemptEvidence {
  const requestClosed = Value.Check(simulatedExecuteTasksSchema, call.args);
  const values = Array.isArray(call.args.tasks) ? call.args.tasks : [];
  const tasks = values.slice(0, 8).map((value) => {
    const task = isRecord(value) ? value : {};
    const tddShapeDeclared = task.tddShape !== undefined;
    const validation = validateTaskShape(task.tddShape);
    let errors: string[] = [];
    if (task.tdd === true && validation.ok === false) {
      errors = validation.errors;
    } else if (task.tdd !== true && tddShapeDeclared) {
      errors = ["non-TDD task declared tddShape"];
    }
    return {
      ...(typeof task.taskId === "string" ? { taskId: task.taskId } : {}),
      ...(typeof task.subject === "string" ? { subject: task.subject } : {}),
      ...(typeof task.prompt === "string" ? { prompt: task.prompt } : {}),
      tdd: task.tdd === true,
      tddShapeDeclared,
      tddShapeValid: task.tdd === true && validation.ok,
      ...(validation.ok
        ? { redGreenCommand: validation.value.redGreenCommand }
        : {}),
      mutations: validation.ok ? validation.value.mutations : [],
      errors,
    };
  });
  return { callIndex, requestClosed, taskCount: values.length, tasks };
}

function sorted(values: readonly string[]): string[] {
  return [...values].sort();
}

function taskMatchesSlice(
  task: TaskShapeAttemptEvidence["tasks"][number],
  slice: ExpectedTaskSlice
): boolean {
  if (slice.classification === "non-tdd") {
    if (task.tdd || task.tddShapeDeclared) {
      return false;
    }
    const searchable = `${task.subject ?? ""} ${task.prompt ?? ""}`;
    return slice.paths.every((path) => searchable.includes(path));
  }
  if (!(task.tdd && task.tddShapeValid)) {
    return false;
  }
  const testPaths = task.mutations
    .filter((mutation) => mutation.kind === "test")
    .map((mutation) => mutation.path);
  const productionPaths = task.mutations
    .filter((mutation) => mutation.kind === "production")
    .map((mutation) => mutation.path);
  return (
    testPaths.length === 1 &&
    testPaths[0] === slice.testPath &&
    task.redGreenCommand === slice.redGreenCommand &&
    JSON.stringify(sorted(productionPaths)) ===
      JSON.stringify(sorted(slice.productionPaths))
  );
}

export function scoreTaskShapeRun(
  evalCase: TaskShapeCase,
  toolCalls: ToolCallRecord[],
  completed = true
): TaskShapeRunEvidence {
  const attempts = toolCalls
    .filter((call) => call.name === "execute_tasks")
    .map(inspectAttempt);
  const tasks = attempts.flatMap((attempt) => attempt.tasks);
  const invalidOrOversizedTddAttempts = attempts.reduce(
    (count, attempt) =>
      count +
      attempt.tasks.filter(
        (task) =>
          (task.tdd && !task.tddShapeValid) ||
          (!task.tdd && task.tddShapeDeclared)
      ).length +
      (attempt.taskCount > 4 ? 1 : 0),
    0
  );
  const expectedTdd = evalCase.expected.filter(
    (slice) => slice.classification === "tdd"
  ).length;
  const expectedNonTdd = evalCase.expected.length - expectedTdd;
  const actualTdd = tasks.filter((task) => task.tdd).length;
  const actualNonTdd = tasks.length - actualTdd;
  const classificationCorrect =
    actualTdd === expectedTdd && actualNonTdd === expectedNonTdd;
  const unmatched = [...tasks];
  const shapeCorrect =
    tasks.length === evalCase.expected.length &&
    evalCase.expected.every((slice) => {
      const index = unmatched.findIndex((task) =>
        taskMatchesSlice(task, slice)
      );
      if (index < 0) {
        return false;
      }
      unmatched.splice(index, 1);
      return true;
    });
  const reconciliationCorrect = evalCase.reconciliation
    ? scoreExecuteReconciliation(toolCalls, evalCase.reconciliation).passed
    : true;
  const structurallyValid =
    completed &&
    reconciliationCorrect &&
    (evalCase.expected.length === 0
      ? attempts.length === 0
      : attempts.length === 1 &&
        attempts[0]!.requestClosed &&
        attempts[0]!.taskCount >= 1 &&
        attempts[0]!.taskCount <= 4);
  return {
    structurallyValid,
    classificationCorrect,
    shapeCorrect,
    reconciliationCorrect,
    invalidOrOversizedTddAttempts,
    attemptedTaskCount: tasks.length,
    expectedTaskCount: evalCase.expected.length,
    attempts,
  };
}

export function aggregateTaskShapeRuns(
  records: Array<{
    caseId: string;
    repetition: number;
    variant: string;
    taskShapeEvidence?: TaskShapeRunEvidence;
  }>,
  corpus: TaskShapeCorpus
): TaskShapeAggregate {
  assertTaskShapePlan(corpus.cases.length, TASK_SHAPE_REPETITIONS);
  const expectedKeys = new Set(
    corpus.cases.flatMap((evalCase) =>
      Array.from(
        { length: TASK_SHAPE_REPETITIONS },
        (_, index) => `${evalCase.id}:${index + 1}:candidate`
      )
    )
  );
  const actualKeys = records.map(
    (record) => `${record.caseId}:${record.repetition}:${record.variant}`
  );
  const plannedRunsValid =
    records.length === TASK_SHAPE_PLANNED_CALLS &&
    new Set(actualKeys).size === TASK_SHAPE_PLANNED_CALLS &&
    actualKeys.every((key) => expectedKeys.has(key));
  const structuralValidRuns = records.filter(
    (record) => record.taskShapeEvidence?.structurallyValid
  ).length;
  const classificationCorrectRuns = records.filter(
    (record) =>
      record.taskShapeEvidence?.classificationCorrect &&
      record.taskShapeEvidence.shapeCorrect
  ).length;
  const invalidOrOversizedTddAttempts = records.reduce(
    (sum, record) =>
      sum + (record.taskShapeEvidence?.invalidOrOversizedTddAttempts ?? 0),
    0
  );
  const allRunsStructurallyValid =
    plannedRunsValid && structuralValidRuns === TASK_SHAPE_PLANNED_CALLS;
  const zeroInvalidOrOversizedTddAttempts = invalidOrOversizedTddAttempts === 0;
  const classificationAtLeast23Of24 =
    classificationCorrectRuns >= 23 && plannedRunsValid;
  const gates = {
    allRunsStructurallyValid,
    zeroInvalidOrOversizedTddAttempts,
    classificationAtLeast23Of24,
    passed:
      allRunsStructurallyValid &&
      zeroInvalidOrOversizedTddAttempts &&
      classificationAtLeast23Of24,
  };
  return {
    plannedRunsValid,
    structuralValidRuns,
    classificationCorrectRuns,
    invalidOrOversizedTddAttempts,
    gates,
  };
}

/** Re-aggregate the run JSON that was actually persisted for a suite. */
export async function aggregatePersistedTaskShapeRuns(
  runsDirectory: string,
  corpus: TaskShapeCorpus
): Promise<TaskShapeAggregate> {
  const entries = await readdir(runsDirectory, { withFileTypes: true });
  const records = await Promise.all(
    entries
      .filter((entry) => entry.isFile() && entry.name.endsWith(".json"))
      .sort((left, right) => left.name.localeCompare(right.name))
      .map(async (entry) =>
        JSON.parse(await readFile(join(runsDirectory, entry.name), "utf8"))
      )
  );
  return aggregateTaskShapeRuns(records, corpus);
}
