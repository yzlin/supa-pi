import { randomBytes } from "node:crypto";
import {
  existsSync,
  mkdirSync,
  readFileSync,
  renameSync,
  writeFileSync,
} from "node:fs";
import { dirname, join } from "node:path";

export type ExecuteCheckpointTask = {
  id: string;
  subject: string;
  status: string;
  blockedBy?: string[];
};

export type ExecuteCheckpoint = {
  planId: string;
  status: string;
  createdAt: string;
  updatedAt: string;
  normalizedSummary: string;
  tasks: ExecuteCheckpointTask[];
};

export type ExecuteCheckpointInput = {
  status: string;
  normalizedSummary: string;
  tasks: ExecuteCheckpointTask[];
};

export type ExecuteCheckpointLoadResult =
  | {
      found: false;
      path: string;
    }
  | {
      found: true;
      path: string;
      checkpoint: ExecuteCheckpoint;
    };

export type ExecuteCheckpointSaveResult = {
  path: string;
  created: boolean;
  status: string;
  taskCount: number;
  checkpoint: ExecuteCheckpoint;
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function assertNonEmptyString(value: unknown, fieldName: string): string {
  if (typeof value !== "string" || value.trim().length === 0) {
    throw new Error(
      `Invalid execute checkpoint: ${fieldName} must be a non-empty string.`
    );
  }

  return value.trim();
}

function assertStringArray(value: unknown, fieldName: string): string[] {
  if (!Array.isArray(value)) {
    throw new Error(
      `Invalid execute checkpoint: ${fieldName} must be an array of strings.`
    );
  }

  return value.map((entry, index) =>
    assertNonEmptyString(entry, `${fieldName}[${index}]`)
  );
}

function normalizeTask(task: unknown, index: number): ExecuteCheckpointTask {
  if (!isRecord(task)) {
    throw new Error(
      `Invalid execute checkpoint: tasks[${index}] must be an object.`
    );
  }

  const normalizedTask: ExecuteCheckpointTask = {
    id: assertNonEmptyString(task.id, `tasks[${index}].id`),
    subject: assertNonEmptyString(task.subject, `tasks[${index}].subject`),
    status: assertNonEmptyString(task.status, `tasks[${index}].status`),
  };

  if (task.blockedBy !== undefined) {
    normalizedTask.blockedBy = assertStringArray(
      task.blockedBy,
      `tasks[${index}].blockedBy`
    );
  }

  return normalizedTask;
}

function parseStoredCheckpoint(
  planId: string,
  value: unknown
): ExecuteCheckpoint {
  if (!isRecord(value)) {
    throw new Error("Invalid execute checkpoint: expected an object.");
  }

  const storedPlanId = assertNonEmptyString(value.planId, "planId");
  if (storedPlanId !== planId) {
    throw new Error(
      `Invalid execute checkpoint: expected planId ${planId}, got ${storedPlanId}.`
    );
  }

  if (!Array.isArray(value.tasks)) {
    throw new Error("Invalid execute checkpoint: tasks must be an array.");
  }

  return {
    planId: storedPlanId,
    status: assertNonEmptyString(value.status, "status"),
    createdAt: assertNonEmptyString(value.createdAt, "createdAt"),
    updatedAt: assertNonEmptyString(value.updatedAt, "updatedAt"),
    normalizedSummary: assertNonEmptyString(
      value.normalizedSummary,
      "normalizedSummary"
    ),
    tasks: value.tasks.map((task, index) => normalizeTask(task, index)),
  };
}

function normalizeCheckpointForSave(
  planId: string,
  input: ExecuteCheckpointInput,
  existingCheckpoint: ExecuteCheckpoint | null,
  now: string
): ExecuteCheckpoint {
  return {
    planId,
    status: assertNonEmptyString(input.status, "status"),
    createdAt: existingCheckpoint?.createdAt ?? now,
    updatedAt: now,
    normalizedSummary: assertNonEmptyString(
      input.normalizedSummary,
      "normalizedSummary"
    ),
    tasks: input.tasks.map((task, index) => normalizeTask(task, index)),
  };
}

function writeJsonAtomically(filePath: string, value: unknown): void {
  const tempPath = `${filePath}.${randomBytes(8).toString("hex")}.tmp`;
  mkdirSync(dirname(filePath), { recursive: true });
  writeFileSync(tempPath, `${JSON.stringify(value, null, 2)}\n`, "utf8");
  renameSync(tempPath, filePath);
}

export function getExecuteCheckpointPath(
  planId: string,
  cwd = process.cwd()
): string {
  return join(cwd, ".pi", "execute", `${planId}.json`);
}

export function loadExecuteCheckpoint(
  planId: string,
  cwd = process.cwd()
): ExecuteCheckpointLoadResult {
  const checkpointPath = getExecuteCheckpointPath(planId, cwd);
  if (!existsSync(checkpointPath)) {
    return {
      found: false,
      path: checkpointPath,
    };
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(readFileSync(checkpointPath, "utf8"));
  } catch (error) {
    throw new Error(
      `Failed to parse execute checkpoint ${checkpointPath}: ${error instanceof Error ? error.message : String(error)}`
    );
  }

  return {
    found: true,
    path: checkpointPath,
    checkpoint: parseStoredCheckpoint(planId, parsed),
  };
}

export function saveExecuteCheckpoint(
  planId: string,
  input: ExecuteCheckpointInput,
  cwd = process.cwd()
): ExecuteCheckpointSaveResult {
  const existing = loadExecuteCheckpoint(planId, cwd);
  const now = new Date().toISOString();
  const checkpoint = normalizeCheckpointForSave(
    planId,
    input,
    existing.found ? existing.checkpoint : null,
    now
  );
  const checkpointPath = existing.path;

  writeJsonAtomically(checkpointPath, checkpoint);

  return {
    path: checkpointPath,
    created: !existing.found,
    status: checkpoint.status,
    taskCount: checkpoint.tasks.length,
    checkpoint,
  };
}
