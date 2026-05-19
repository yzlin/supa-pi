import type { GoalCheckpointPatch, GoalExecutorStatus, Result } from "./types";

export interface GoalExecutorResult {
  status: GoalExecutorStatus;
  summary: string;
  filesTouched: string[];
  validation: string[];
  followUps: string[];
  blockers: string[];
  evidence: string[];
  risks: string[];
  checkpointPatch: GoalCheckpointPatch | null;
  suggestedNextTask: string | null;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function stringArray(value: unknown): string[] {
  if (!Array.isArray(value)) {
    return [];
  }
  return value
    .filter(
      (entry): entry is string =>
        typeof entry === "string" && entry.trim().length > 0
    )
    .map((entry) => entry.trim());
}

function optionalString(value: unknown): string | null {
  return typeof value === "string" && value.trim().length > 0
    ? value.trim()
    : null;
}

function checkpointPatch(value: unknown): GoalCheckpointPatch | null {
  if (value === undefined || value === null) {
    return null;
  }
  if (!isRecord(value)) {
    return null;
  }
  const patch: GoalCheckpointPatch = {};
  if (typeof value.status === "string") {
    patch.status = value.status as GoalCheckpointPatch["status"];
  }
  if (
    value.currentMilestone === null ||
    typeof value.currentMilestone === "string"
  ) {
    patch.currentMilestone = value.currentMilestone;
  }
  if (Array.isArray(value.coarsePlan)) {
    patch.coarsePlan = stringArray(value.coarsePlan);
  }
  if (Array.isArray(value.candidateFollowups)) {
    patch.candidateFollowups = stringArray(value.candidateFollowups);
  }
  if (isRecord(value.blockerState)) {
    const taskId = optionalString(value.blockerState.taskId);
    patch.blockerState = {
      blocked: value.blockerState.blocked === true,
      reason: optionalString(value.blockerState.reason),
      ...(taskId ? { taskId } : {}),
    };
  }
  return patch;
}

export function parseGoalExecutorResult(
  raw: string
): Result<GoalExecutorResult> {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw.trim());
  } catch (error) {
    return {
      ok: false,
      error: `Executor result must be strict JSON: ${error instanceof Error ? error.message : String(error)}`,
    };
  }
  if (!isRecord(parsed)) {
    return { ok: false, error: "Executor result must be an object." };
  }
  const status = parsed.status;
  if (
    status !== "done" &&
    status !== "blocked" &&
    status !== "needs_followup" &&
    status !== "failed"
  ) {
    return {
      ok: false,
      error:
        "Executor result status must be done, blocked, needs_followup, or failed.",
    };
  }
  if (
    typeof parsed.summary !== "string" ||
    parsed.summary.trim().length === 0
  ) {
    return {
      ok: false,
      error: "Executor result summary must be a non-empty string.",
    };
  }
  return {
    ok: true,
    value: {
      status,
      summary: parsed.summary.trim(),
      filesTouched: stringArray(parsed.filesTouched),
      validation: stringArray(parsed.validation),
      followUps: stringArray(parsed.followUps),
      blockers: stringArray(parsed.blockers),
      evidence: stringArray(parsed.evidence),
      risks: stringArray(parsed.risks),
      checkpointPatch: checkpointPatch(parsed.checkpointPatch),
      suggestedNextTask: optionalString(parsed.suggestedNextTask),
    },
  };
}
