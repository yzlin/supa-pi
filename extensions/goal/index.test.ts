import { describe, expect, it } from "bun:test";
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import type {
  ExtensionAPI,
  ExtensionCommandContext,
} from "@earendil-works/pi-coding-agent";

import goalExtension from "./index";

type CommandOptions = Parameters<ExtensionAPI["registerCommand"]>[1] & {
  handler: NonNullable<
    Parameters<ExtensionAPI["registerCommand"]>[1]["handler"]
  >;
};
type ToolRegistration = Parameters<ExtensionAPI["registerTool"]>[0];

interface SentMessage {
  message: string;
  options?: { deliverAs?: string };
}

interface CustomMessage {
  message: { content?: string; details?: unknown };
  options?: { deliverAs?: string; triggerTurn?: boolean };
}

interface AppendEntry {
  type: string;
  data: unknown;
}

function createHarness(
  options: { cwd?: string; branchEntries?: unknown[]; reset?: boolean } = {}
) {
  const commands = new Map<string, CommandOptions>();
  const tools: ToolRegistration[] = [];
  const statuses: Array<string | undefined> = [];
  const notifications: Array<{ message: string; level: string }> = [];
  const messages: SentMessage[] = [];
  const customMessages: CustomMessage[] = [];
  const appendEntries: AppendEntry[] = [];
  const handlers = new Map<
    string,
    (event: unknown, context: unknown) => void
  >();
  let activeTools = ["bash", "read"];

  const api = {
    on(name: string, handler: (event: unknown, context: unknown) => void) {
      handlers.set(name, handler);
    },
    registerMessageRenderer() {
      /* noop */
    },
    registerCommand(name: string, commandOptions: CommandOptions) {
      commands.set(name, commandOptions);
    },
    registerTool(tool: ToolRegistration) {
      tools.push(tool);
    },
    getActiveTools() {
      return activeTools;
    },
    setActiveTools(next: string[]) {
      activeTools = next;
    },
    sendUserMessage(message: string, messageOptions?: { deliverAs?: string }) {
      messages.push({ message, options: messageOptions });
    },
    sendMessage(
      message: { content?: string; details?: unknown },
      messageOptions?: { deliverAs?: string; triggerTurn?: boolean }
    ) {
      customMessages.push({ message, options: messageOptions });
    },
    appendEntry(type: string, data: unknown) {
      appendEntries.push({ type, data });
    },
  } as unknown as ExtensionAPI;

  const cwd =
    options.cwd ?? mkdtempSync(join(tmpdir(), "goal-extension-test-"));
  const makeCtx = (idle: boolean): ExtensionCommandContext =>
    ({
      cwd,
      hasUI: true,
      isIdle: () => idle,
      hasPendingMessages: () => false,
      sessionManager: {
        getBranch() {
          return options.branchEntries ?? [];
        },
      },
      ui: {
        setStatus(_key: string, value: string | undefined) {
          statuses.push(value);
        },
        notify(message: string, level: string) {
          notifications.push({ message, level });
        },
      },
    }) as unknown as ExtensionCommandContext;

  goalExtension(api);
  const command = commands.get("goal");
  if (!command) {
    throw new Error("goal command was not registered");
  }
  if (options.reset !== false) {
    command.handler("clear", makeCtx(true));
    statuses.length = 0;
    notifications.length = 0;
    messages.length = 0;
    customMessages.length = 0;
    appendEntries.length = 0;
  }

  return {
    api,
    command,
    tools,
    statuses,
    notifications,
    messages,
    customMessages,
    appendEntries,
    handlers,
    getActiveTools: () => activeTools,
    ctx: makeCtx,
    cwd,
  };
}

function getTool(harness: ReturnType<typeof createHarness>) {
  const tool = harness.tools.find(
    (registered) => registered.name === "goal_checkpoint"
  );
  if (!tool) {
    throw new Error("goal_checkpoint tool was not registered");
  }
  return tool;
}

describe("goal extension", () => {
  it("registers the command and goal checkpoint tool", () => {
    const harness = createHarness();

    expect(harness.command.description).toContain("/goal <objective>");
    expect(harness.tools.map((tool) => tool.name)).toContain("goal_checkpoint");
  });

  it("starts classic goals, updates status, and sends prompt immediately when idle", () => {
    const harness = createHarness();

    harness.command.handler("write tests", harness.ctx(true));

    expect(harness.getActiveTools()).toEqual([
      "bash",
      "read",
      "goal_checkpoint",
    ]);
    expect(harness.statuses.at(-1)).toBe(
      "goal:active pending:0 active:0 blocked:0 budget_limited:0 complete:0"
    );
    expect(harness.messages).toHaveLength(1);
    expect(harness.messages[0]?.options).toBeUndefined();
    expect(harness.messages[0]?.message).toContain("<untrusted_objective>");
    expect(harness.messages[0]?.message).toContain("write tests");
    expect(harness.messages[0]?.message).toContain("Use goal_checkpoint");
    expect(harness.appendEntries.at(-1)).toMatchObject({
      type: "goal-state",
      data: { cwd: harness.cwd },
    });
  });

  it("queues task mode continuation as follow-up when not idle", () => {
    const harness = createHarness();

    harness.command.handler("task --tasks 2 build feature", harness.ctx(false));

    expect(harness.messages).toHaveLength(1);
    expect(harness.messages[0]?.options).toEqual({ deliverAs: "followUp" });
    expect(harness.messages[0]?.message).toContain(
      "You are the main-session orchestrator for /goal task mode."
    );
    expect(harness.messages[0]?.message).toContain(
      "You are executing goal task task-1: Task 1"
    );
    expect(harness.notifications).toContainEqual({
      message: "Queued /goal continuation as follow-up",
      level: "info",
    });
  });

  it("reports status/statusbar without starting a new prompt", () => {
    const harness = createHarness();

    harness.command.handler("status", harness.ctx(true));
    harness.command.handler("statusbar", harness.ctx(true));

    expect(harness.notifications).toEqual([
      { message: "goal: none", level: "info" },
      { message: "goal: none", level: "info" },
    ]);
    expect(harness.messages).toEqual([]);
  });

  it("pauses, resumes, clears, and restores active tools", () => {
    const harness = createHarness();

    harness.command.handler("task --tasks 1 ship", harness.ctx(true));
    harness.command.handler("pause", harness.ctx(true));
    expect(harness.getActiveTools()).toEqual(["bash", "read"]);
    expect(harness.statuses.at(-1)).toBe(
      "goal:paused pending:0 active:1 blocked:0 budget_limited:0 complete:0"
    );

    harness.command.handler("resume", harness.ctx(false));
    expect(harness.getActiveTools()).toEqual([
      "bash",
      "read",
      "goal_checkpoint",
    ]);
    expect(harness.messages.at(-1)?.options).toEqual({ deliverAs: "followUp" });

    harness.command.handler("clear", harness.ctx(true));
    expect(harness.getActiveTools()).toEqual(["bash", "read"]);
    expect(harness.statuses.at(-1)).toBeUndefined();
  });

  it("goal_checkpoint persists valid status patches and rejects budget rewrites", async () => {
    const harness = createHarness();
    const tool = getTool(harness);

    harness.command.handler("task --tasks 1 ship", harness.ctx(true));
    const rewriteResult = await tool.execute?.(
      "call-rewrite",
      {
        tasks: [
          {
            id: "task-1",
            title: "Task 1",
            status: "active",
            attempts: 0,
            budget: { maxAttempts: 999, usedAttempts: 0, usedToolCalls: 0 },
          },
        ],
      },
      new AbortController().signal,
      () => undefined,
      harness.ctx(true)
    );
    expect(rewriteResult?.isError).toBe(true);

    const result = await tool.execute?.(
      "call-1",
      {
        status: "blocked",
        currentMilestone: "task-1",
        coarsePlan: ["Check blocker"],
        candidateFollowups: ["Ask user"],
        blockerState: { blocked: true, reason: "Need input", taskId: "task-1" },
      },
      new AbortController().signal,
      () => undefined,
      harness.ctx(true)
    );

    expect(result?.isError).toBeUndefined();
    expect(result?.details).toMatchObject({
      status: "blocked",
      currentMilestone: "task-1",
      coarsePlan: ["Check blocker"],
      candidateFollowups: ["Ask user"],
      blockerState: { blocked: true, reason: "Need input", taskId: "task-1" },
    });
    expect(result?.content[0]).toMatchObject({ type: "text" });
  });

  it("adds task budget on resume after budget limit", async () => {
    const harness = createHarness();
    const tool = getTool(harness);

    harness.command.handler("task --tasks 1 ship", harness.ctx(true));
    await tool.execute?.(
      "call-budget",
      { status: "budget_limited" },
      new AbortController().signal,
      () => undefined,
      harness.ctx(true)
    );

    harness.command.handler("resume --tasks 2", harness.ctx(true));

    expect(harness.messages.at(-1)?.message).toContain(
      "You are executing goal task task-1: Task 1"
    );
    expect(harness.statuses.at(-1)).toBe(
      "goal:active pending:2 active:1 blocked:0 budget_limited:0 complete:0"
    );
  });

  it("restores active goals on reload as paused from session checkpoint", () => {
    const initial = createHarness();
    initial.command.handler("task --tasks 1 reload me", initial.ctx(true));
    const state = initial.appendEntries.at(-1);
    const goalId = (state?.data as { goalId: string }).goalId;
    expect(goalId).toBeTruthy();

    const restored = createHarness({
      cwd: initial.cwd,
      branchEntries: [
        { type: "custom", customType: "goal-state", data: state?.data },
      ],
      reset: false,
    });
    restored.handlers.get("session_start")?.(
      { reason: "reload" },
      restored.ctx(true)
    );

    expect(restored.statuses.at(-1)).toBe(
      "goal:paused pending:0 active:1 blocked:0 budget_limited:0 complete:0"
    );
    expect(restored.getActiveTools()).toEqual(["bash", "read"]);
    expect(
      readFileSync(join(initial.cwd, ".pi", "goal", `${goalId}.json`), "utf8")
    ).toContain('"status": "paused"');
  });

  it("does not expose active goal state across cwd boundaries", () => {
    const initial = createHarness();
    initial.command.handler("task --tasks 1 private goal", initial.ctx(true));
    const state = initial.appendEntries.at(-1);
    const other = createHarness({
      branchEntries: [
        { type: "custom", customType: "goal-state", data: state?.data },
      ],
      reset: false,
    });

    other.handlers.get("session_start")?.(
      { reason: "resume" },
      other.ctx(true)
    );

    expect(other.statuses.at(-1)).toBeUndefined();
    expect(other.getActiveTools()).toEqual(["bash", "read"]);
  });

  it("queues autonomous continuation on agent end", async () => {
    const harness = createHarness();

    harness.command.handler("write tests", harness.ctx(true));
    harness.handlers.get("agent_end")?.({}, harness.ctx(true));
    await Promise.resolve();

    expect(harness.customMessages.at(-1)?.options).toEqual({
      triggerTurn: true,
      deliverAs: "followUp",
    });
    expect(harness.customMessages.at(-1)?.message.content).toContain(
      "Continue working toward the active thread goal."
    );
  });
});
