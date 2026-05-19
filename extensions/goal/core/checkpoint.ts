import { randomBytes } from "node:crypto";
import {
  existsSync,
  mkdirSync,
  readFileSync,
  renameSync,
  writeFileSync,
} from "node:fs";
import { dirname, join } from "node:path";

import type {
  DirtyBaseline,
  GoalBlockerState,
  GoalCheckpoint,
  GoalEvidenceEntry,
  GoalExecutorSummary,
  GoalMilestone,
  GoalMode,
  GoalStatus,
  GoalTask,
  GoalTaskBudget,
  GoalTaskStatus,
  Result,
} from "./types";

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function nonEmptyString(value: unknown, field: string): string {
  if (typeof value !== "string" || value.trim().length === 0) {
    throw new Error(
      `Invalid goal checkpoint: ${field} must be a non-empty string.`
    );
  }
  return value.trim();
}

function nullableString(value: unknown, field: string): string | null {
  if (value === null) {
    return null;
  }
  if (typeof value !== "string" || value.trim().length === 0) {
    throw new Error(
      `Invalid goal checkpoint: ${field} must be a string or null.`
    );
  }
  return value.trim();
}

function arrayOf<T>(
  value: unknown,
  field: string,
  parseEntry: (entry: unknown, index: number) => T
): T[] {
  if (!Array.isArray(value)) {
    throw new Error(`Invalid goal checkpoint: ${field} must be an array.`);
  }
  return value.map(parseEntry);
}

function stringArray(value: unknown, field: string): string[] {
  if (!Array.isArray(value)) {
    throw new Error(
      `Invalid goal checkpoint: ${field} must be an array of strings.`
    );
  }
  return value.map((entry, index) =>
    nonEmptyString(entry, `${field}[${index}]`)
  );
}

function nonNegativeInteger(value: unknown, field: string): number {
  if (!Number.isSafeInteger(value) || (value as number) < 0) {
    throw new Error(
      `Invalid goal checkpoint: ${field} must be a non-negative integer.`
    );
  }
  return value as number;
}

const GOAL_STATUSES = new Set<GoalStatus>([
  "active",
  "paused",
  "blocked",
  "budget_limited",
  "complete",
  "cleared",
]);
const TASK_STATUSES = new Set<GoalTaskStatus>([
  "pending",
  "active",
  "blocked",
  "budget_limited",
  "complete",
]);
const MODES = new Set<GoalMode>(["classic", "task"]);

function status(value: unknown, field: string): GoalStatus {
  if (typeof value !== "string" || !GOAL_STATUSES.has(value as GoalStatus)) {
    throw new Error(
      `Invalid goal checkpoint: ${field} has unsupported status.`
    );
  }
  return value as GoalStatus;
}

function taskStatus(value: unknown, field: string): GoalTaskStatus {
  if (
    typeof value !== "string" ||
    !TASK_STATUSES.has(value as GoalTaskStatus)
  ) {
    throw new Error(
      `Invalid goal checkpoint: ${field} has unsupported status.`
    );
  }
  return value as GoalTaskStatus;
}

function mode(value: unknown): GoalMode {
  if (typeof value !== "string" || !MODES.has(value as GoalMode)) {
    throw new Error("Invalid goal checkpoint: mode must be classic or task.");
  }
  return value as GoalMode;
}

function budget(value: unknown, field: string): GoalTaskBudget {
  if (!isRecord(value)) {
    throw new Error(`Invalid goal checkpoint: ${field} must be an object.`);
  }
  const normalized: GoalTaskBudget = {
    maxAttempts: nonNegativeInteger(value.maxAttempts, `${field}.maxAttempts`),
    usedAttempts: nonNegativeInteger(
      value.usedAttempts,
      `${field}.usedAttempts`
    ),
    usedToolCalls: nonNegativeInteger(
      value.usedToolCalls,
      `${field}.usedToolCalls`
    ),
  };
  if (value.maxToolCalls !== undefined) {
    normalized.maxToolCalls = nonNegativeInteger(
      value.maxToolCalls,
      `${field}.maxToolCalls`
    );
  }
  if (normalized.maxAttempts <= 0) {
    throw new Error(
      `Invalid goal checkpoint: ${field}.maxAttempts must be positive.`
    );
  }
  return normalized;
}

function task(value: unknown, index: number): GoalTask {
  if (!isRecord(value)) {
    throw new Error(
      `Invalid goal checkpoint: tasks[${index}] must be an object.`
    );
  }
  const normalized: GoalTask = {
    id: nonEmptyString(value.id, `tasks[${index}].id`),
    title: nonEmptyString(value.title, `tasks[${index}].title`),
    status: taskStatus(value.status, `tasks[${index}].status`),
    attempts: nonNegativeInteger(value.attempts, `tasks[${index}].attempts`),
    budget: budget(value.budget, `tasks[${index}].budget`),
  };
  if (value.notes !== undefined) {
    normalized.notes = stringArray(value.notes, `tasks[${index}].notes`);
  }
  return normalized;
}

function dirtyBaseline(value: unknown): DirtyBaseline {
  if (!isRecord(value)) {
    throw new Error(
      "Invalid goal checkpoint: dirtyBaseline must be an object."
    );
  }
  return {
    gitHead: nullableString(value.gitHead, "dirtyBaseline.gitHead"),
    dirtyFiles: stringArray(value.dirtyFiles, "dirtyBaseline.dirtyFiles"),
  };
}

function milestone(value: unknown, index: number): GoalMilestone {
  if (!isRecord(value)) {
    throw new Error(
      `Invalid goal checkpoint: milestones[${index}] must be an object.`
    );
  }
  return {
    id: nonEmptyString(value.id, `milestones[${index}].id`),
    title: nonEmptyString(value.title, `milestones[${index}].title`),
    status: taskStatus(value.status, `milestones[${index}].status`),
  };
}

function evidenceEntry(value: unknown, index: number): GoalEvidenceEntry {
  if (!isRecord(value)) {
    throw new Error(
      `Invalid goal checkpoint: evidenceLedger[${index}] must be an object.`
    );
  }
  return {
    ...(value.taskId === undefined
      ? {}
      : {
          taskId: nonEmptyString(
            value.taskId,
            `evidenceLedger[${index}].taskId`
          ),
        }),
    summary: nonEmptyString(value.summary, `evidenceLedger[${index}].summary`),
    filesTouched: stringArray(
      value.filesTouched,
      `evidenceLedger[${index}].filesTouched`
    ),
    validation: stringArray(
      value.validation,
      `evidenceLedger[${index}].validation`
    ),
    risks: stringArray(value.risks, `evidenceLedger[${index}].risks`),
  };
}

function blockerState(value: unknown): GoalBlockerState {
  if (!isRecord(value)) {
    throw new Error("Invalid goal checkpoint: blockerState must be an object.");
  }
  return {
    blocked: value.blocked === true,
    reason: nullableString(value.reason, "blockerState.reason"),
    ...(value.taskId === undefined
      ? {}
      : { taskId: nonEmptyString(value.taskId, "blockerState.taskId") }),
  };
}

function executorSummary(value: unknown, index: number): GoalExecutorSummary {
  if (!isRecord(value)) {
    throw new Error(
      `Invalid goal checkpoint: executorSummaries[${index}] must be an object.`
    );
  }
  const resultStatus = value.status;
  if (
    resultStatus !== "done" &&
    resultStatus !== "blocked" &&
    resultStatus !== "needs_followup" &&
    resultStatus !== "failed"
  ) {
    throw new Error(
      `Invalid goal checkpoint: executorSummaries[${index}].status has unsupported status.`
    );
  }
  return {
    ...(value.taskId === undefined
      ? {}
      : {
          taskId: nonEmptyString(
            value.taskId,
            `executorSummaries[${index}].taskId`
          ),
        }),
    status: resultStatus,
    summary: nonEmptyString(
      value.summary,
      `executorSummaries[${index}].summary`
    ),
    filesTouched: stringArray(
      value.filesTouched,
      `executorSummaries[${index}].filesTouched`
    ),
    validation: stringArray(
      value.validation,
      `executorSummaries[${index}].validation`
    ),
    followUps: stringArray(
      value.followUps,
      `executorSummaries[${index}].followUps`
    ),
    blockers: stringArray(
      value.blockers,
      `executorSummaries[${index}].blockers`
    ),
    evidence: stringArray(
      value.evidence,
      `executorSummaries[${index}].evidence`
    ),
    risks: stringArray(value.risks, `executorSummaries[${index}].risks`),
    suggestedNextTask: nullableString(
      value.suggestedNextTask,
      `executorSummaries[${index}].suggestedNextTask`
    ),
  };
}

export function parseGoalCheckpoint(
  value: unknown,
  expectedGoalId?: string
): Result<GoalCheckpoint> {
  try {
    if (!isRecord(value)) {
      throw new Error("Invalid goal checkpoint: expected an object.");
    }
    if (value.version !== 1) {
      throw new Error("Invalid goal checkpoint: version must be 1.");
    }
    const goalId = nonEmptyString(value.goalId, "goalId");
    if (expectedGoalId && goalId !== expectedGoalId) {
      throw new Error(
        `Invalid goal checkpoint: expected goalId ${expectedGoalId}, got ${goalId}.`
      );
    }
    const taskBudget =
      value.taskBudget === null
        ? null
        : nonNegativeInteger(value.taskBudget, "taskBudget");
    const checkpointMode = mode(value.mode);
    if (checkpointMode === "task" && (taskBudget === null || taskBudget <= 0)) {
      throw new Error(
        "Invalid goal checkpoint: task mode requires positive taskBudget."
      );
    }
    const tasks = arrayOf(value.tasks, "tasks", task);
    const checkpoint: GoalCheckpoint = {
      version: 1,
      goalId,
      status: status(value.status, "status"),
      mode: checkpointMode,
      objective: nonEmptyString(value.objective, "objective"),
      normalizedObjective: nonEmptyString(
        value.normalizedObjective,
        "normalizedObjective"
      ),
      createdAt: nonEmptyString(value.createdAt, "createdAt"),
      updatedAt: nonEmptyString(value.updatedAt, "updatedAt"),
      coarsePlan: stringArray(value.coarsePlan, "coarsePlan"),
      milestones: arrayOf(value.milestones, "milestones", milestone),
      currentMilestone: nullableString(
        value.currentMilestone,
        "currentMilestone"
      ),
      taskBudget,
      attemptsUsed: nonNegativeInteger(value.attemptsUsed, "attemptsUsed"),
      evidenceLedger: arrayOf(
        value.evidenceLedger,
        "evidenceLedger",
        evidenceEntry
      ),
      candidateFollowups: stringArray(
        value.candidateFollowups,
        "candidateFollowups"
      ),
      blockerState: blockerState(value.blockerState),
      dirtyBaseline: dirtyBaseline(value.dirtyBaseline),
      executorSummaries: arrayOf(
        value.executorSummaries,
        "executorSummaries",
        executorSummary
      ),
      tasks,
    };
    return { ok: true, value: checkpoint };
  } catch (error) {
    return {
      ok: false,
      error: error instanceof Error ? error.message : String(error),
    };
  }
}

export function getGoalCheckpointPath(
  goalId: string,
  cwd = process.cwd()
): string {
  return join(cwd, ".pi", "goal", `${goalId}.json`);
}

export function loadGoalCheckpoint(
  goalId: string,
  cwd = process.cwd()
): Result<{ found: boolean; path: string; checkpoint?: GoalCheckpoint }> {
  const path = getGoalCheckpointPath(goalId, cwd);
  if (!existsSync(path)) {
    return { ok: true, value: { found: false, path } };
  }
  try {
    const parsed = JSON.parse(readFileSync(path, "utf8"));
    const checkpoint = parseGoalCheckpoint(parsed, goalId);
    if (!checkpoint.ok) {
      return checkpoint;
    }
    return {
      ok: true,
      value: { found: true, path, checkpoint: checkpoint.value },
    };
  } catch (error) {
    return {
      ok: false,
      error: `Failed to load goal checkpoint ${path}: ${error instanceof Error ? error.message : String(error)}`,
    };
  }
}

export function saveGoalCheckpoint(
  checkpoint: GoalCheckpoint,
  cwd = process.cwd()
): Result<{ path: string; checkpoint: GoalCheckpoint }> {
  const normalized = parseGoalCheckpoint(checkpoint, checkpoint.goalId);
  if (!normalized.ok) {
    return normalized;
  }
  const path = getGoalCheckpointPath(checkpoint.goalId, cwd);
  const tempPath = `${path}.${randomBytes(8).toString("hex")}.tmp`;
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(
    tempPath,
    `${JSON.stringify(normalized.value, null, 2)}\n`,
    "utf8"
  );
  renameSync(tempPath, path);
  return { ok: true, value: { path, checkpoint: normalized.value } };
}
