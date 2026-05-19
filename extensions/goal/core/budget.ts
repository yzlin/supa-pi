import type { GoalTaskBudget, Result } from "./types";

export function createTaskBudget(
  maxAttempts: number,
  maxToolCalls?: number
): GoalTaskBudget {
  if (!Number.isSafeInteger(maxAttempts) || maxAttempts <= 0) {
    throw new Error("maxAttempts must be a positive integer.");
  }
  if (
    maxToolCalls !== undefined &&
    (!Number.isSafeInteger(maxToolCalls) || maxToolCalls <= 0)
  ) {
    throw new Error("maxToolCalls must be a positive integer when provided.");
  }
  return { maxAttempts, usedAttempts: 0, maxToolCalls, usedToolCalls: 0 };
}

export function spendTaskAttempt(
  budget: GoalTaskBudget
): Result<GoalTaskBudget> {
  if (budget.usedAttempts >= budget.maxAttempts) {
    return { ok: false, error: "Task attempt budget exhausted." };
  }
  return {
    ok: true,
    value: { ...budget, usedAttempts: budget.usedAttempts + 1 },
  };
}

export function spendToolCalls(
  budget: GoalTaskBudget,
  count: number
): Result<GoalTaskBudget> {
  if (!Number.isSafeInteger(count) || count < 0) {
    return {
      ok: false,
      error: "Tool call count must be a non-negative integer.",
    };
  }
  const nextUsedToolCalls = budget.usedToolCalls + count;
  if (
    budget.maxToolCalls !== undefined &&
    nextUsedToolCalls > budget.maxToolCalls
  ) {
    return { ok: false, error: "Task tool-call budget exhausted." };
  }
  return { ok: true, value: { ...budget, usedToolCalls: nextUsedToolCalls } };
}

export function getRemainingAttempts(budget: GoalTaskBudget): number {
  return Math.max(0, budget.maxAttempts - budget.usedAttempts);
}

export function isTaskBudgetExhausted(budget: GoalTaskBudget): boolean {
  return getRemainingAttempts(budget) === 0;
}
