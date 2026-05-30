import { describe, expect, it } from "bun:test";

import { completeGoalCommandArguments, parseGoalCommand } from "./command";

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
    expect(parseGoalCommand("clear")).toMatchObject({
      ok: true,
      value: { action: "clear" },
    });
    expect(parseGoalCommand("stop")).toMatchObject({
      ok: true,
      value: { action: "stop" },
    });
    expect(parseGoalCommand("statusbar")).toMatchObject({
      ok: true,
      value: { action: "statusbar" },
    });
  });

  it("rejects extra lifecycle arguments", () => {
    expect(parseGoalCommand("stop now")).toEqual({
      ok: false,
      error: "/goal stop does not accept extra arguments.",
    });
    expect(parseGoalCommand("stop --dry-run")).toEqual({
      ok: false,
      error: "/goal stop does not accept extra arguments.",
    });
    expect(parseGoalCommand("stop --resume")).toEqual({
      ok: false,
      error: "/goal stop does not accept extra arguments.",
    });
    expect(parseGoalCommand("clear now")).toEqual({
      ok: false,
      error: "/goal clear does not accept extra arguments.",
    });
  });

  it("completes empty first-token subcommands with descriptions", () => {
    expect(completeGoalCommandArguments("")).toEqual([
      {
        value: "task ",
        label: "task",
        description: "Start a budget-limited task goal",
      },
      {
        value: "status",
        label: "status",
        description: "Show active goal status",
      },
      {
        value: "statusbar",
        label: "statusbar",
        description: "Refresh goal status bar text",
      },
      {
        value: "pause",
        label: "pause",
        description: "Pause the active goal",
      },
      {
        value: "resume",
        label: "resume",
        description: "Resume a paused goal",
      },
      {
        value: "clear",
        label: "clear",
        description: "Clear the active goal",
      },
      {
        value: "stop",
        label: "stop",
        description: "Clear active goal; does not interrupt current turn",
      },
    ]);
  });

  it("completes first-token subcommands", () => {
    expect(completeGoalCommandArguments("st")).toEqual([
      {
        value: "status",
        label: "status",
        description: "Show active goal status",
      },
      {
        value: "statusbar",
        label: "statusbar",
        description: "Refresh goal status bar text",
      },
      {
        value: "stop",
        label: "stop",
        description: "Clear active goal; does not interrupt current turn",
      },
    ]);
    expect(completeGoalCommandArguments("task --")).toEqual([]);
    expect(completeGoalCommandArguments("status ")).toEqual([]);
    expect(completeGoalCommandArguments("stop ")).toEqual([]);
  });
});
