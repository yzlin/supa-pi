import { createHash, randomBytes, randomUUID } from "node:crypto";
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
  canonicalPlanHash?: string;
}

export interface ExecuteCheckpoint {
  version: 1;
  id: string;
  canonicalPlanHash: string;
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
      canonicalPlanHash: string;
      warnings?: string[];
    }
  | {
      found: true;
      path: string;
      canonicalPlanHash: string;
      checkpoint: ExecuteCheckpoint;
      warnings?: string[];
    };

export interface ExecuteCheckpointSaveResult {
  path: string;
  created: boolean;
  status: string;
  taskCount: number;
  checkpoint: ExecuteCheckpoint;
  warnings?: string[];
}

export interface ExecuteCheckpointListResult {
  checkpoints: Array<{
    id: string;
    path: string;
    status: string;
    normalizedSummary: string;
    tasks: ExecuteCheckpointTask[];
    canonicalPlanHash: string;
  }>;
  warnings?: string[];
}

type CheckpointEntry = {
  path: string;
  checkpoint: ExecuteCheckpoint;
};

const FINISHED_CHECKPOINT_STATUSES = new Set([
  "canceled",
  "cancelled",
  "complete",
  "completed",
  "done",
]);
const V1_CHECKPOINT_FILE_PATTERN = /^execute-v1-[0-9a-fA-F-]+\.json$/;

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

function normalizeCanonicalPlan(canonicalPlan: string): string {
  return assertNonEmptyString(canonicalPlan, "canonicalPlan");
}

function hashCanonicalPlan(canonicalPlan: string): string {
  return createHash("sha256")
    .update(normalizeCanonicalPlan(canonicalPlan))
    .digest("hex");
}

function normalizeDangerousActionApproval(
  approval: unknown,
  canonicalPlanHash: string
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

  let approvalCanonicalPlanHash = canonicalPlanHash;
  if (approval.canonicalPlanHash !== undefined) {
    approvalCanonicalPlanHash = assertNonEmptyString(
      approval.canonicalPlanHash,
      "dangerousActionApproval.canonicalPlanHash"
    );
  }

  if (approvalCanonicalPlanHash !== canonicalPlanHash) {
    throw new Error(
      "Invalid execute checkpoint: dangerousActionApproval.canonicalPlanHash must match canonicalPlanHash."
    );
  }

  normalizedApproval.canonicalPlanHash = approvalCanonicalPlanHash;

  if (approval.reason !== undefined) {
    normalizedApproval.reason = assertNonEmptyString(
      approval.reason,
      "dangerousActionApproval.reason"
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

function parseStoredCheckpoint(value: unknown): ExecuteCheckpoint | null {
  if (!isRecord(value) || value.version !== 1) {
    return null;
  }

  if (!Array.isArray(value.tasks)) {
    throw new Error("Invalid execute checkpoint: tasks must be an array.");
  }

  const canonicalPlanHash = assertNonEmptyString(
    value.canonicalPlanHash,
    "canonicalPlanHash"
  );
  const checkpoint: ExecuteCheckpoint = {
    version: 1,
    id: assertNonEmptyString(value.id, "id"),
    canonicalPlanHash,
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
      value.dangerousActionApproval,
      canonicalPlanHash
    );
  }

  return checkpoint;
}

function normalizeCheckpointForSave(
  id: string,
  canonicalPlanHash: string,
  input: ExecuteCheckpointInput,
  existingCheckpoint: ExecuteCheckpoint | null,
  now: string
): ExecuteCheckpoint {
  const normalizedSummary = assertNonEmptyString(
    input.normalizedSummary,
    "normalizedSummary"
  );
  const tasks = input.tasks.map((task, index) => normalizeTask(task, index));
  const checkpoint: ExecuteCheckpoint = {
    version: 1,
    id,
    canonicalPlanHash,
    status: assertNonEmptyString(input.status, "status"),
    createdAt: existingCheckpoint?.createdAt ?? now,
    updatedAt: now,
    normalizedSummary,
    tasks,
  };

  if (input.dangerousActionApproval !== undefined) {
    checkpoint.dangerousActionApproval = normalizeDangerousActionApproval(
      input.dangerousActionApproval,
      canonicalPlanHash
    );
  } else if (
    existingCheckpoint?.dangerousActionApproval?.canonicalPlanHash ===
    canonicalPlanHash
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

function getExecuteCheckpointDir(cwd = process.cwd()): string {
  return join(cwd, ".pi", "execute");
}

function getExecuteCheckpointIndexPath(cwd = process.cwd()): string {
  return join(getExecuteCheckpointDir(cwd), "index.json");
}

export function getExecuteCheckpointPath(
  id: string,
  cwd = process.cwd()
): string {
  return join(getExecuteCheckpointDir(cwd), `execute-v1-${id}.json`);
}

function readCheckpointFile(checkpointPath: string): ExecuteCheckpoint | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(readFileSync(checkpointPath, "utf8"));
  } catch (error) {
    throw new Error(
      `Failed to parse execute checkpoint ${checkpointPath}: ${error instanceof Error ? error.message : String(error)}`
    );
  }

  return parseStoredCheckpoint(parsed);
}

function checkpointIndexFromEntries(
  byHash: Map<string, CheckpointEntry>
): Record<string, string> {
  return Object.fromEntries(
    [...byHash.entries()].map(([hash, entry]) => [hash, entry.checkpoint.id])
  );
}

function chooseNewest(entries: CheckpointEntry[]): {
  winner: CheckpointEntry;
  warnings: string[];
} {
  const sorted = [...entries].sort((a, b) =>
    b.checkpoint.updatedAt.localeCompare(a.checkpoint.updatedAt)
  );
  const [winner, ...duplicates] = sorted;
  if (!winner) {
    throw new Error("Invalid execute checkpoint scan: expected entries.");
  }

  const warnings: string[] = [];
  if (duplicates.length > 0) {
    warnings.push(
      `Duplicate execute checkpoint files for canonicalPlanHash ${winner.checkpoint.canonicalPlanHash}; using newest updatedAt: ${winner.path}; ignored: ${duplicates
        .map((entry) => entry.path)
        .join(", ")}.`
    );
  }

  return { winner, warnings };
}

function scanV1Checkpoints(
  cwd: string,
  options: { repairIndex?: boolean } = {}
): {
  byHash: Map<string, CheckpointEntry>;
  warnings: string[];
} {
  const checkpointDir = getExecuteCheckpointDir(cwd);
  const byHash = new Map<string, CheckpointEntry[]>();
  const warnings: string[] = [];

  if (!existsSync(checkpointDir)) {
    return { byHash: new Map(), warnings };
  }

  for (const entry of readdirSync(checkpointDir).sort()) {
    if (!V1_CHECKPOINT_FILE_PATTERN.test(entry)) {
      continue;
    }

    const path = join(checkpointDir, entry);
    const checkpoint = readCheckpointFile(path);
    if (checkpoint === null) {
      continue;
    }

    const entries = byHash.get(checkpoint.canonicalPlanHash) ?? [];
    entries.push({ path, checkpoint });
    byHash.set(checkpoint.canonicalPlanHash, entries);
  }

  const winners = new Map<string, CheckpointEntry>();
  for (const [canonicalPlanHash, entries] of byHash) {
    const { winner, warnings: duplicateWarnings } = chooseNewest(entries);
    winners.set(canonicalPlanHash, winner);
    warnings.push(...duplicateWarnings);
  }

  if (options.repairIndex) {
    writeJsonAtomically(
      getExecuteCheckpointIndexPath(cwd),
      checkpointIndexFromEntries(winners)
    );
  }

  return { byHash: winners, warnings };
}

export function loadExecuteCheckpoint(
  canonicalPlan: string,
  cwd = process.cwd()
): ExecuteCheckpointLoadResult {
  const canonicalPlanHash = hashCanonicalPlan(canonicalPlan);
  const scan = scanV1Checkpoints(cwd);
  const entry = scan.byHash.get(canonicalPlanHash);
  if (!entry) {
    return { found: false, canonicalPlanHash, warnings: scan.warnings };
  }

  return {
    found: true,
    path: entry.path,
    canonicalPlanHash,
    checkpoint: entry.checkpoint,
    warnings: scan.warnings,
  };
}

function isUnfinishedCheckpoint(status: string): boolean {
  return !FINISHED_CHECKPOINT_STATUSES.has(status.trim().toLowerCase());
}

export function listUnfinishedExecuteCheckpoints(
  cwd = process.cwd()
): ExecuteCheckpointListResult {
  const scan = scanV1Checkpoints(cwd, { repairIndex: true });
  const checkpoints = [...scan.byHash.values()]
    .filter(({ checkpoint }) => isUnfinishedCheckpoint(checkpoint.status))
    .sort((a, b) => a.path.localeCompare(b.path))
    .map(({ path, checkpoint }) => ({
      id: checkpoint.id,
      path,
      status: checkpoint.status,
      normalizedSummary: checkpoint.normalizedSummary,
      tasks: checkpoint.tasks,
      canonicalPlanHash: checkpoint.canonicalPlanHash,
    }));

  return { checkpoints, warnings: scan.warnings };
}

export function saveExecuteCheckpoint(
  canonicalPlan: string,
  input: ExecuteCheckpointInput,
  cwd = process.cwd()
): ExecuteCheckpointSaveResult {
  const canonicalPlanHash = hashCanonicalPlan(canonicalPlan);
  const scan = scanV1Checkpoints(cwd, { repairIndex: true });
  const existing = scan.byHash.get(canonicalPlanHash) ?? null;
  const id = existing?.checkpoint.id ?? randomUUID();
  const now = new Date().toISOString();
  const checkpoint = normalizeCheckpointForSave(
    id,
    canonicalPlanHash,
    input,
    existing?.checkpoint ?? null,
    now
  );
  const checkpointPath = existing?.path ?? getExecuteCheckpointPath(id, cwd);

  writeJsonAtomically(checkpointPath, checkpoint);
  writeJsonAtomically(getExecuteCheckpointIndexPath(cwd), {
    ...checkpointIndexFromEntries(scan.byHash),
    [canonicalPlanHash]: id,
  });

  return {
    path: checkpointPath,
    created: existing === null,
    status: checkpoint.status,
    taskCount: checkpoint.tasks.length,
    checkpoint,
    warnings: scan.warnings,
  };
}
