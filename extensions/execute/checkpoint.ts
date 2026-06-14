import { createHash, randomBytes } from "node:crypto";
import {
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  renameSync,
  writeFileSync,
} from "node:fs";
import { dirname, join } from "node:path";

export interface ExecuteCheckpointTask {
  id: string;
  subject: string;
  status: string;
  blockedBy?: string[];
}

export interface ExecuteDangerousActionApproval {
  approved: boolean;
  approvedAt: string;
  reason?: string;
  planFingerprint?: string;
}

export interface ExecuteCheckpoint {
  planId: string;
  status: string;
  createdAt: string;
  updatedAt: string;
  normalizedSummary: string;
  tasks: ExecuteCheckpointTask[];
  dangerousActionApproval?: ExecuteDangerousActionApproval;
}

export interface ExecuteCheckpointInput {
  status: string;
  normalizedSummary: string;
  tasks: ExecuteCheckpointTask[];
  dangerousActionApproval?: ExecuteDangerousActionApproval;
}

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

export interface ExecuteCheckpointSaveResult {
  path: string;
  created: boolean;
  status: string;
  taskCount: number;
  checkpoint: ExecuteCheckpoint;
}

export interface ExecuteCheckpointListResult {
  checkpoints: Array<{
    path: string;
    checkpoint: ExecuteCheckpoint;
  }>;
}

const FINISHED_CHECKPOINT_STATUSES = new Set([
  "canceled",
  "cancelled",
  "complete",
  "completed",
  "done",
]);

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

function normalizeDangerousActionApproval(
  approval: unknown
): ExecuteDangerousActionApproval {
  if (!isRecord(approval)) {
    throw new Error(
      "Invalid execute checkpoint: dangerousActionApproval must be an object."
    );
  }

  if (typeof approval.approved !== "boolean") {
    throw new Error(
      "Invalid execute checkpoint: dangerousActionApproval.approved must be a boolean."
    );
  }

  const normalizedApproval: ExecuteDangerousActionApproval = {
    approved: approval.approved,
    approvedAt: assertNonEmptyString(
      approval.approvedAt,
      "dangerousActionApproval.approvedAt"
    ),
  };

  if (approval.reason !== undefined) {
    normalizedApproval.reason = assertNonEmptyString(
      approval.reason,
      "dangerousActionApproval.reason"
    );
  }

  if (approval.planFingerprint !== undefined) {
    normalizedApproval.planFingerprint = assertNonEmptyString(
      approval.planFingerprint,
      "dangerousActionApproval.planFingerprint"
    );
  }

  return normalizedApproval;
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

  const checkpoint: ExecuteCheckpoint = {
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

  if (value.dangerousActionApproval !== undefined) {
    checkpoint.dangerousActionApproval = normalizeDangerousActionApproval(
      value.dangerousActionApproval
    );
  }

  return checkpoint;
}

function buildPlanFingerprint(
  normalizedSummary: string,
  tasks: ExecuteCheckpointTask[]
): string {
  return createHash("sha256")
    .update(JSON.stringify({ normalizedSummary, tasks }))
    .digest("hex");
}

function normalizeCheckpointForSave(
  planId: string,
  input: ExecuteCheckpointInput,
  existingCheckpoint: ExecuteCheckpoint | null,
  now: string
): ExecuteCheckpoint {
  const normalizedSummary = assertNonEmptyString(
    input.normalizedSummary,
    "normalizedSummary"
  );
  const tasks = input.tasks.map((task, index) => normalizeTask(task, index));
  const planFingerprint = buildPlanFingerprint(normalizedSummary, tasks);
  const checkpoint: ExecuteCheckpoint = {
    planId,
    status: assertNonEmptyString(input.status, "status"),
    createdAt: existingCheckpoint?.createdAt ?? now,
    updatedAt: now,
    normalizedSummary,
    tasks,
  };

  if (input.dangerousActionApproval !== undefined) {
    checkpoint.dangerousActionApproval = {
      ...normalizeDangerousActionApproval(input.dangerousActionApproval),
      planFingerprint,
    };
  } else if (
    existingCheckpoint?.dangerousActionApproval?.planFingerprint ===
    planFingerprint
  ) {
    checkpoint.dangerousActionApproval =
      existingCheckpoint.dangerousActionApproval;
  }

  return checkpoint;
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

function readCheckpointFile(
  planId: string,
  checkpointPath: string
): ExecuteCheckpoint {
  let parsed: unknown;
  try {
    parsed = JSON.parse(readFileSync(checkpointPath, "utf8"));
  } catch (error) {
    throw new Error(
      `Failed to parse execute checkpoint ${checkpointPath}: ${error instanceof Error ? error.message : String(error)}`
    );
  }

  return parseStoredCheckpoint(planId, parsed);
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

  return {
    found: true,
    path: checkpointPath,
    checkpoint: readCheckpointFile(planId, checkpointPath),
  };
}

function isUnfinishedCheckpoint(status: string): boolean {
  return !FINISHED_CHECKPOINT_STATUSES.has(status.trim().toLowerCase());
}

export function listUnfinishedExecuteCheckpoints(
  cwd = process.cwd()
): ExecuteCheckpointListResult {
  const checkpointDir = join(cwd, ".pi", "execute");
  if (!existsSync(checkpointDir)) {
    return { checkpoints: [] };
  }

  const checkpoints = readdirSync(checkpointDir)
    .filter((entry) => entry.endsWith(".json"))
    .sort()
    .map((entry) => {
      const planId = entry.slice(0, -".json".length);
      const path = join(checkpointDir, entry);
      return {
        path,
        checkpoint: readCheckpointFile(planId, path),
      };
    })
    .filter(({ checkpoint }) => isUnfinishedCheckpoint(checkpoint.status));

  return { checkpoints };
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
