import { describe, expect, it } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import type {
  ExtensionAPI,
  ExtensionContext,
} from "@earendil-works/pi-coding-agent";

import { loadExecuteCheckpoint } from "./checkpoint";
import executeExtension from "./index";

function harness(cwd: string) {
  const events = new Map<
    string,
    Array<(event: never, ctx: ExtensionContext) => unknown>
  >();
  let command: (args: string, ctx: never) => unknown;
  let checkpointTool: { execute: (...args: never[]) => unknown };
  const userMessages: string[] = [];
  const nudges: unknown[] = [];
  const controller = new AbortController();
  const ctx = {
    cwd,
    signal: controller.signal as AbortSignal | undefined,
    isIdle: () => true,
    hasPendingMessages: () => false,
    sessionManager: { getSessionId: () => "session-a", getBranch: () => [] },
    ui: { notify: () => undefined },
  };
  const pi = {
    on(
      name: string,
      handler: (event: never, context: ExtensionContext) => unknown
    ) {
      events.set(name, [...(events.get(name) ?? []), handler]);
    },
    registerCommand(_name: string, definition: { handler: typeof command }) {
      command = definition.handler;
    },
    registerTool(definition: {
      name: string;
      execute: (...args: never[]) => unknown;
    }) {
      if (definition.name === "execute_checkpoint") {
        checkpointTool = definition;
      }
    },
    sendUserMessage(content: string) {
      userMessages.push(content);
    },
    sendMessage(message: unknown, options: unknown) {
      nudges.push({ message, options });
    },
  };
  executeExtension(pi as unknown as ExtensionAPI);
  async function emit(name: string, event: unknown = {}) {
    for (const handler of events.get(name) ?? []) {
      await handler(event as never, ctx as unknown as ExtensionContext);
    }
  }
  async function start() {
    await command!("implement formatter", ctx as never);
    const content = userMessages.at(-1)!;
    await emit("input", { source: "extension", text: content });
    await emit("message_start", { message: { role: "user", content } });
  }
  async function save(
    checkpoint = readyCheckpoint(),
    canonicalPlan = "plan-a"
  ) {
    await emit("tool_execution_start", { toolName: "execute_checkpoint" });
    const result = await checkpointTool!.execute(
      ...([
        "save",
        { op: "save", canonicalPlan, checkpoint },
        ctx.signal,
        undefined,
        ctx,
      ] as never[])
    );
    await emit("tool_execution_end", {
      toolName: "execute_checkpoint",
      isError: false,
    });
    return result;
  }
  async function end(stopReason = "stop") {
    await emit("agent_end", {
      messages: [{ role: "assistant", stopReason, content: [] }],
    });
    const signal = ctx.signal;
    ctx.signal = undefined;
    await emit("agent_settled");
    ctx.signal = signal;
  }
  return { start, save, end, emit, ctx, controller, nudges };
}

function readyCheckpoint() {
  return {
    status: "active",
    normalizedSummary:
      "Scoped work remains; no blocker or pause. Original slice 1: zero recovery rounds.",
    tasks: [
      {
        id: "1",
        subject: "formatter",
        status: "pending",
        blockedBy: [] as string[],
      },
    ],
    continuation: { taskId: "1", recoveryRounds: 0 },
  };
}

async function withHarness(
  run: (h: ReturnType<typeof harness>, cwd: string) => Promise<void>
) {
  const cwd = mkdtempSync(join(tmpdir(), "pi-execute-continuation-"));
  try {
    await run(harness(cwd), cwd);
  } finally {
    rmSync(cwd, { recursive: true, force: true });
  }
}

describe("execute bounded continuation", () => {
  it("nudges only after settlement with a fresh saved ticket, at most twice per invocation", async () => {
    await withHarness(async (h, cwd) => {
      await h.start();
      await h.save();
      expect(loadExecuteCheckpoint("plan-a", cwd)).toMatchObject({
        found: true,
        checkpoint: { continuation: { taskId: "1", recoveryRounds: 0 } },
      });
      await h.emit("agent_end", {
        messages: [{ role: "assistant", stopReason: "stop" }],
      });
      expect(h.nudges).toHaveLength(0);
      await h.emit("agent_settled");
      expect(h.nudges).toHaveLength(1);
      expect(h.nudges[0]).toMatchObject({
        message: {
          customType: "execute-continuation",
          content: expect.stringContaining("independent verification"),
        },
        options: { triggerTurn: true, deliverAs: "followUp" },
      });
      const nudge = h.nudges[0] as {
        message: { customType: string; content: string; details: unknown };
      };
      await h.emit("message_start", {
        message: { role: "custom", ...nudge.message },
      });
      h.ctx.signal = new AbortController().signal;
      await h.end();
      expect(h.nudges).toHaveLength(1);
      await h.save();
      await h.end();
      expect(h.nudges).toHaveLength(2);
      await h.save();
      await h.end();
      expect(h.nudges).toHaveLength(2);
    });
  });

  it("fails closed for absent state, nonactive status, blocked dependencies, complete work and recovery exhaustion", async () => {
    const cases = [
      { ...readyCheckpoint(), continuation: undefined },
      ...[
        "paused",
        "blocked",
        "cancelled",
        "canceled",
        "error",
        "complete",
        "budget_limited",
        "unknown",
      ].map((status) => ({ ...readyCheckpoint(), status })),
      { ...readyCheckpoint(), tasks: [] },
      {
        ...readyCheckpoint(),
        tasks: [{ ...readyCheckpoint().tasks[0]!, status: "completed" }],
      },
      {
        ...readyCheckpoint(),
        tasks: [{ ...readyCheckpoint().tasks[0]!, blockedBy: ["missing"] }],
      },
      {
        ...readyCheckpoint(),
        continuation: { taskId: "missing", recoveryRounds: 0 },
      },
      {
        ...readyCheckpoint(),
        continuation: { taskId: "1", recoveryRounds: 2 },
      },
    ];
    for (const checkpoint of cases) {
      await withHarness(async (h) => {
        await h.start();
        await h.save(checkpoint);
        await h.end();
        expect(h.nudges).toHaveLength(0);
      });
    }
  });

  it("never activates from checkpoint storage alone or another plan", async () => {
    await withHarness(async (h) => {
      await h.save();
      await h.end();
      expect(h.nudges).toHaveLength(0);
      await h.start();
      await h.save();
      await h.save(readyCheckpoint(), "plan-b");
      await h.save();
      await h.end();
      expect(h.nudges).toHaveLength(0);
    });
  });

  it("invalidates on input, lifecycle changes, intervening tools and runtime errors", async () => {
    for (const [event, payload] of [
      ["input", { source: "interactive", text: "pause" }],
      ["input", { source: "extension", text: "unrelated request" }],
      ["message_start", { message: { role: "user", content: "stop" } }],
      ["message_start", { message: { role: "custom", customType: "goal" } }],
      ["session_start", {}],
      ["session_shutdown", {}],
      ["session_before_switch", {}],
      ["session_before_fork", {}],
      ["session_before_tree", {}],
      ["session_before_compact", {}],
      ["user_bash", {}],
      ["tool_execution_start", { toolName: "execute_tasks" }],
      ["tool_execution_end", { isError: true }],
    ] as const) {
      await withHarness(async (h) => {
        await h.start();
        await h.save();
        await h.emit(event, payload);
        await h.end();
        expect(h.nudges).toHaveLength(0);
      });
    }
  });

  it("requires normal stop, live signal, same session/cwd and idle without queued work", async () => {
    for (const stopReason of [
      "aborted",
      "error",
      "length",
      "toolUse",
      "pending",
    ]) {
      await withHarness(async (h) => {
        await h.start();
        await h.save();
        await h.end(stopReason);
        expect(h.nudges).toHaveLength(0);
      });
    }
    for (const invalidate of [
      (h: ReturnType<typeof harness>) => {
        h.controller.abort();
      },
      (h: ReturnType<typeof harness>) => {
        h.ctx.signal = undefined;
      },
      (h: ReturnType<typeof harness>) => {
        h.ctx.cwd = "/elsewhere";
      },
      (h: ReturnType<typeof harness>) => {
        h.ctx.sessionManager.getSessionId = () => "session-b";
      },
      (h: ReturnType<typeof harness>) => {
        h.ctx.hasPendingMessages = () => true;
      },
      (h: ReturnType<typeof harness>) => {
        h.ctx.isIdle = () => false;
      },
    ]) {
      await withHarness(async (h) => {
        await h.start();
        await h.save();
        invalidate(h);
        await h.end();
        expect(h.nudges).toHaveLength(0);
      });
    }
  });

  it("cancels between agent_end and settlement without leaving queued continuation", async () => {
    await withHarness(async (h) => {
      await h.start();
      await h.save();
      await h.emit("agent_end", {
        messages: [{ role: "assistant", stopReason: "stop" }],
      });
      h.controller.abort();
      await h.emit("agent_settled");
      expect(h.nudges).toHaveLength(0);
    });
  });

  it("does not revive terminal checkpoints or error runs with a later ready save", async () => {
    for (const status of [
      "paused",
      "blocked",
      "complete",
      "cancelled",
      "budget_limited",
    ]) {
      await withHarness(async (h) => {
        await h.start();
        await h.save({ ...readyCheckpoint(), status });
        await h.save();
        await h.end();
        expect(h.nudges).toHaveLength(0);
      });
    }
    await withHarness(async (h) => {
      await h.start();
      await h.save();
      await h.end("error");
      await h.save();
      await h.end();
      expect(h.nudges).toHaveLength(0);
    });
    await withHarness(async (h) => {
      await h.start();
      await h.save({
        ...readyCheckpoint(),
        continuation: { taskId: "1", recoveryRounds: 2 },
      });
      await h.save();
      await h.end();
      expect(h.nudges).toHaveLength(0);
    });
  });

  it("does not arm a checkpoint concurrent with other tool work", async () => {
    await withHarness(async (h) => {
      await h.start();
      await h.emit("tool_execution_start", {
        toolCallId: "worker",
        toolName: "execute_tasks",
      });
      await h.save();
      await h.emit("tool_execution_end", {
        toolCallId: "worker",
        toolName: "execute_tasks",
        isError: false,
      });
      await h.end();
      expect(h.nudges).toHaveLength(0);
    });
  });

  it("rejects invalid continuation counters without breaking older checkpoint reads", async () => {
    await withHarness(async (h, cwd) => {
      for (const recoveryRounds of [-1, 0.5, 3, Number.NaN]) {
        const response = await h.save({
          ...readyCheckpoint(),
          continuation: { taskId: "1", recoveryRounds },
        });
        expect(response).toMatchObject({ isError: true });
      }
      await h.save({ ...readyCheckpoint(), continuation: undefined });
      expect(loadExecuteCheckpoint("plan-a", cwd)).toMatchObject({
        found: true,
      });
      await h.end();
      expect(h.nudges).toHaveLength(0);
    });
  });
});
