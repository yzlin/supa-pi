import { describe, expect, it } from "bun:test";

import {
  createTaskBudget,
  getRemainingAttempts,
  isTaskBudgetExhausted,
  spendTaskAttempt,
  spendToolCalls,
} from "./budget";
import { parseGoalCheckpoint } from "./checkpoint";
import { assertDirtyBaselineUnchanged } from "./dirty-baseline";
import { parseGoalExecutorResult } from "./executor-result";
import { buildGoalTaskPacket, buildGoalTaskPrompt } from "./packet";
import {
  formatGoalStatus,
  inferGoalStatus,
  isTerminalGoalStatus,
  parseGoalStatus,
  transitionGoalStatus,
} from "./status";
import type { GoalCheckpoint } from "./types";

function checkpoint(overrides: Partial<GoalCheckpoint> = {}): GoalCheckpoint {
  return {
    version: 1,
    goalId: "goal-1",
    status: "active",
    mode: "task",
    objective: "Ship goal tests",
    normalizedObjective: "Ship goal tests",
    createdAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-01T00:00:00.000Z",
    coarsePlan: ["Plan"],
    milestones: [{ id: "task-1", title: "Task 1", status: "active" }],
    currentMilestone: "task-1",
    taskBudget: 1,
    attemptsUsed: 0,
    evidenceLedger: [],
    candidateFollowups: [],
    blockerState: { blocked: false, reason: null },
    dirtyBaseline: { gitHead: "abc", dirtyFiles: ["existing.ts"] },
    executorSummaries: [],
    tasks: [
      {
        id: "task-1",
        title: "Task 1",
        status: "active",
        attempts: 0,
        budget: { maxAttempts: 2, usedAttempts: 1, usedToolCalls: 3 },
      },
    ],
    ...overrides,
  };
}

describe("goal core state helpers", () => {
  it("enforces status transitions and infers aggregate status", () => {
    expect(transitionGoalStatus("active", "paused")).toEqual({
      ok: true,
      value: "paused",
    });
    expect(transitionGoalStatus("complete", "active")).toEqual({
      ok: false,
      error: "Invalid goal status transition: complete -> active.",
    });
    expect(inferGoalStatus(["complete", "complete"])).toBe("complete");
    expect(inferGoalStatus(["pending", "blocked"])).toBe("blocked");
    expect(inferGoalStatus(["budget_limited"])).toBe("budget_limited");
    expect(isTerminalGoalStatus("complete")).toBe(true);
    expect(parseGoalStatus("active")).toEqual({ ok: true, value: "active" });
    expect(formatGoalStatus("active", ["active", "pending"])).toBe(
      "goal:active pending:1 active:1 blocked:0 budget_limited:0 complete:0"
    );
  });

  it("accounts for task attempts and tool-call budget", () => {
    const budget = createTaskBudget(2, 3);
    const first = spendTaskAttempt(budget);
    expect(first).toEqual({
      ok: true,
      value: {
        maxAttempts: 2,
        usedAttempts: 1,
        maxToolCalls: 3,
        usedToolCalls: 0,
      },
    });
    if (!first.ok) {
      throw new Error(first.error);
    }
    expect(getRemainingAttempts(first.value)).toBe(1);
    expect(isTaskBudgetExhausted(first.value)).toBe(false);
    expect(spendToolCalls(first.value, 3)).toMatchObject({ ok: true });
    expect(spendToolCalls(first.value, 4)).toEqual({
      ok: false,
      error: "Task tool-call budget exhausted.",
    });
  });

  it("validates checkpoints and expected goal ids", () => {
    expect(parseGoalCheckpoint(checkpoint(), "goal-1")).toMatchObject({
      ok: true,
    });
    expect(parseGoalCheckpoint(checkpoint(), "other-goal")).toEqual({
      ok: false,
      error: "Invalid goal checkpoint: expected goalId other-goal, got goal-1.",
    });
    expect(parseGoalCheckpoint(checkpoint({ taskBudget: null }))).toEqual({
      ok: false,
      error: "Invalid goal checkpoint: task mode requires positive taskBudget.",
    });
  });

  it("parses strict executor JSON and normalizes optional arrays", () => {
    const parsed = parseGoalExecutorResult(
      JSON.stringify({
        status: "needs_followup",
        summary: "  needs input  ",
        filesTouched: ["a.ts", ""],
        validation: ["bun test"],
        followUps: ["schedule next"],
        blockers: ["missing secret"],
        checkpointPatch: {
          status: "blocked",
          blockerState: {
            blocked: true,
            reason: "missing secret",
            taskId: "task-1",
          },
        },
        suggestedNextTask: "task-2",
      })
    );

    expect(parsed).toMatchObject({
      ok: true,
      value: {
        status: "needs_followup",
        summary: "needs input",
        filesTouched: ["a.ts"],
        evidence: [],
        risks: [],
        suggestedNextTask: "task-2",
      },
    });
    expect(parseGoalExecutorResult("not json")).toMatchObject({ ok: false });
  });

  it("builds executor packets and prompts with budget context", () => {
    const cp = checkpoint();
    const packet = buildGoalTaskPacket(cp, cp.tasks[0]);

    expect(packet.checkpointSummary).toBe(
      "1 tasks; status active; updated 2026-01-01T00:00:00.000Z"
    );
    expect(buildGoalTaskPrompt(packet)).toContain(
      "Budget: attempts 1/2; tool calls 3/unlimited"
    );
    expect(buildGoalTaskPrompt(packet)).toContain(
      "Return strict executor JSON"
    );
  });

  it("guards dirty baseline changes", () => {
    expect(
      assertDirtyBaselineUnchanged(
        { gitHead: "a", dirtyFiles: ["one.ts"] },
        { gitHead: "a", dirtyFiles: ["one.ts"] }
      )
    ).toEqual({ ok: true, value: undefined });
    expect(
      assertDirtyBaselineUnchanged(
        { gitHead: "a", dirtyFiles: ["one.ts"] },
        { gitHead: "b", dirtyFiles: ["two.ts"] }
      )
    ).toEqual({
      ok: false,
      error:
        "Dirty baseline changed: headChanged=true added=two.ts removed=one.ts.",
    });
  });
});
