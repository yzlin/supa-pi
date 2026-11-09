import { describe, expect, it } from "bun:test";
import { execFileSync } from "node:child_process";
import { mkdtempSync, renameSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { parseGoalCheckpoint } from "./checkpoint";
import { captureDirtyBaseline } from "./dirty-baseline";
import { buildGoalTaskPacket, buildGoalTaskPrompt } from "./packet";
import {
  formatGoalStatus,
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
    runLimit: null,
    runsUsed: 0,
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
        budget: { maxAttempts: 2, usedAttempts: 1 },
      },
    ],
    ...overrides,
  };
}

describe("goal core state helpers", () => {
  it("enforces status transitions", () => {
    expect(transitionGoalStatus("active", "paused")).toEqual({
      ok: true,
      value: "paused",
    });
    expect(transitionGoalStatus("complete", "active")).toEqual({
      ok: false,
      error: "Invalid goal status transition: complete -> active.",
    });
    expect(isTerminalGoalStatus("complete")).toBe(true);
    expect(parseGoalStatus("active")).toEqual({ ok: true, value: "active" });
    expect(formatGoalStatus("active", ["active", "pending"])).toBe(
      "goal:active pending:1 active:1 blocked:0 budget_limited:0 complete:0",
    );
  });

  it("drops tool-call fields from checkpoints written before their removal", () => {
    const legacy = checkpoint();
    const legacyTask = {
      ...legacy.tasks[0],
      budget: {
        maxAttempts: 2,
        usedAttempts: 1,
        maxToolCalls: 3,
        usedToolCalls: 3,
      },
    };
    const parsed = parseGoalCheckpoint({ ...legacy, tasks: [legacyTask] });
    if ("error" in parsed) {
      throw new Error(parsed.error);
    }
    expect(parsed.value.tasks[0]?.budget).toEqual({
      maxAttempts: 2,
      usedAttempts: 1,
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

  it("loads checkpoints written before run limits as unlimited", () => {
    const { runLimit: _limit, runsUsed: _used, ...legacy } = checkpoint();
    expect(parseGoalCheckpoint(legacy)).toMatchObject({
      ok: true,
      value: { runLimit: null, runsUsed: 0 },
    });
    expect(parseGoalCheckpoint({ ...legacy, runsUsed: -1 })).toEqual({
      ok: false,
      error:
        "Invalid goal checkpoint: runsUsed must be a non-negative integer.",
    });
  });

  it("builds executor packets and prompts with budget context", () => {
    const cp = checkpoint();
    const packet = buildGoalTaskPacket(cp, cp.tasks[0]);

    expect(packet.checkpointSummary).toBe(
      "1 tasks; status active; updated 2026-01-01T00:00:00.000Z",
    );
    expect(buildGoalTaskPrompt(packet)).toContain("Budget: attempts 1/2");
    expect(buildGoalTaskPrompt(packet)).toContain(
      "Return strict executor JSON",
    );
  });

  it("captures full dirty paths, including a leading unstaged change and renames", () => {
    const cwd = mkdtempSync(join(tmpdir(), "goal-dirty-"));
    const git = (...args: string[]) =>
      execFileSync("git", args, { cwd, stdio: "ignore" });
    git("init", "-q");
    writeFileSync(join(cwd, "a.ts"), "a\n");
    writeFileSync(join(cwd, "old.ts"), "old\n");
    writeFileSync(join(cwd, "keep.ts"), "keep\n");
    git("add", ".");
    git("-c", "user.email=a@b", "-c", "user.name=a", "commit", "-qm", "init");
    writeFileSync(join(cwd, "a.ts"), "changed\n");
    git("mv", "old.ts", "new.ts");

    expect(captureDirtyBaseline(cwd).dirtyFiles).toEqual(["a.ts", "new.ts"]);

    // Worktree-side rename: " R moved.ts\0keep.ts\0".
    renameSync(join(cwd, "keep.ts"), join(cwd, "moved.ts"));
    git("add", "-N", "moved.ts");
    expect(captureDirtyBaseline(cwd).dirtyFiles).toEqual([
      "a.ts",
      "moved.ts",
      "new.ts",
    ]);
  });
});
