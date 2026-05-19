import type { GoalStatus, GoalTaskStatus, Result } from "./types";

const STATUS_ORDER: GoalStatus[] = [
  "active",
  "paused",
  "blocked",
  "budget_limited",
  "complete",
  "cleared",
];

const ALLOWED: Record<GoalStatus, GoalStatus[]> = {
  active: ["paused", "blocked", "budget_limited", "complete", "cleared"],
  paused: ["active", "cleared"],
  blocked: ["active", "cleared"],
  budget_limited: ["active", "cleared"],
  complete: ["cleared"],
  cleared: [],
};

export function transitionGoalStatus(
  current: GoalStatus,
  next: GoalStatus
): Result<GoalStatus> {
  if (current === next) {
    return { ok: true, value: next };
  }
  if (!ALLOWED[current].includes(next)) {
    return {
      ok: false,
      error: `Invalid goal status transition: ${current} -> ${next}.`,
    };
  }
  return { ok: true, value: next };
}

export function inferGoalStatus(taskStatuses: GoalTaskStatus[]): GoalStatus {
  if (taskStatuses.length === 0) {
    return "active";
  }
  if (taskStatuses.some((status) => status === "blocked")) {
    return "blocked";
  }
  if (taskStatuses.some((status) => status === "budget_limited")) {
    return "budget_limited";
  }
  if (taskStatuses.every((status) => status === "complete")) {
    return "complete";
  }
  return "active";
}

export function isTerminalGoalStatus(status: GoalStatus): boolean {
  return status === "complete" || status === "cleared";
}

export function formatGoalStatus(
  status: GoalStatus,
  taskStatuses: GoalTaskStatus[] = []
): string {
  const counts = new Map<GoalTaskStatus, number>();
  for (const taskStatus of taskStatuses) {
    counts.set(taskStatus, (counts.get(taskStatus) ?? 0) + 1);
  }
  const suffix = ["pending", "active", "blocked", "budget_limited", "complete"]
    .map(
      (taskStatus) =>
        `${taskStatus}:${counts.get(taskStatus as GoalTaskStatus) ?? 0}`
    )
    .join(" ");
  return `goal:${status} ${suffix}`;
}

export function parseGoalStatus(value: string): Result<GoalStatus> {
  if (STATUS_ORDER.includes(value as GoalStatus)) {
    return { ok: true, value: value as GoalStatus };
  }
  return { ok: false, error: `Invalid goal status: ${value}.` };
}
