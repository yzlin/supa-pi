import { describe, expect, it } from "bun:test";

import { parseGoalCommand } from "./command";

describe("goal command parser", () => {
  it("parses classic objectives with quoted text and defaults", () => {
    const parsed = parseGoalCommand('ship "goal extension" tests');

    expect(parsed.ok).toBe(true);
    if (!parsed.ok) {
      throw new Error(parsed.error);
    }
    expect(parsed.value).toMatchObject({
      action: "start",
      mode: "classic",
      objective: "ship goal extension tests",
      normalizedObjective: "ship goal extension tests",
      resume: false,
      checkpoint: null,
      taskBudget: null,
      maxAttemptsPerTask: 2,
      dryRun: false,
    });
  });

  it("parses task mode budget and flags", () => {
    const parsed = parseGoalCommand(
      "task --tasks=3 --max-attempts-per-task 4 --checkpoint cp-1 --dry-run finish work"
    );

    expect(parsed.ok).toBe(true);
    if (!parsed.ok) {
      throw new Error(parsed.error);
    }
    expect(parsed.value).toMatchObject({
      action: "start",
      mode: "task",
      objective: "finish work",
      normalizedObjective: "finish work",
      checkpoint: "cp-1",
      taskBudget: 3,
      maxAttemptsPerTask: 4,
      dryRun: true,
    });
  });

  it("requires task mode budget and rejects legacy max-tasks flag", () => {
    expect(parseGoalCommand("task finish work")).toEqual({
      ok: false,
      error: "/goal task requires --tasks N.",
    });
    expect(parseGoalCommand("task --max-tasks 2 finish work")).toEqual({
      ok: false,
      error: "Use --tasks for /goal task budget.",
    });
  });

  it("parses lifecycle actions without objectives", () => {
    expect(parseGoalCommand("status")).toMatchObject({
      ok: true,
      value: { action: "status" },
    });
    expect(parseGoalCommand("pause")).toMatchObject({
      ok: true,
      value: { action: "pause" },
    });
    expect(parseGoalCommand("resume")).toMatchObject({
      ok: true,
      value: { action: "resume", resume: true },
    });
    expect(parseGoalCommand("statusbar")).toMatchObject({
      ok: true,
      value: { action: "statusbar" },
    });
  });
});
