import { describe, expect, it } from "bun:test";

import { EXECUTE_PROMPT } from "./constants";
import executeExtension from "./index";

function createMockCtx(
  branchEntries: Array<{
    type: string;
    message?: {
      role: string;
      content: string | Array<{ type?: string; text?: string }>;
    };
  }> = []
) {
  const notifications: Array<{ message: string; level: string }> = [];

  return {
    notifications,
    ctx: {
      isIdle: () => true,
      sessionManager: {
        getBranch() {
          return branchEntries;
        },
      },
      ui: {
        notify(message: string, level: string) {
          notifications.push({ message, level });
        },
      },
    },
  };
}

function createMockPiRuntime() {
  const commands = new Map<
    string,
    { handler: (args: string, ctx: unknown) => Promise<void> | void }
  >();
  const sentUserMessages: Array<{ content: string; options?: unknown }> = [];

  return {
    commands,
    sentUserMessages,
    pi: {
      registerCommand(
        name: string,
        definition: {
          handler: (args: string, ctx: unknown) => Promise<void> | void;
        }
      ) {
        commands.set(name, definition);
      },
      sendUserMessage(content: string, options?: unknown) {
        sentUserMessages.push({ content, options });
      },
    },
  };
}

describe("execute command", () => {
  it("sends the orchestrator prompt immediately when idle", async () => {
    const runtime = createMockPiRuntime();
    const { ctx, notifications } = createMockCtx();

    executeExtension(runtime.pi as never);
    const handler = runtime.commands.get("execute")?.handler;

    expect(handler).toBeDefined();
    await handler?.("implement @plan.md", ctx as never);

    expect(runtime.sentUserMessages).toEqual([
      {
        content: `${EXECUTE_PROMPT}\n\n<plan>\nimplement @plan.md\n</plan>`,
        options: undefined,
      },
    ]);
    expect(notifications).toEqual([]);
  });

  it("queues the orchestrator prompt as a follow-up when busy", async () => {
    const runtime = createMockPiRuntime();
    const { ctx, notifications } = createMockCtx();

    executeExtension(runtime.pi as never);
    const handler = runtime.commands.get("execute")?.handler;

    expect(handler).toBeDefined();
    await handler?.("implement @plan.md", {
      ...ctx,
      isIdle: () => false,
    } as never);

    expect(runtime.sentUserMessages).toEqual([
      {
        content: `${EXECUTE_PROMPT}\n\n<plan>\nimplement @plan.md\n</plan>`,
        options: { deliverAs: "followUp" },
      },
    ]);
    expect(notifications).toContainEqual({
      message: "Queued /execute as a follow-up",
      level: "info",
    });
  });

  it("reuses the last session message when /execute has no args", async () => {
    const runtime = createMockPiRuntime();
    const { ctx, notifications } = createMockCtx([
      {
        type: "message",
        message: {
          role: "assistant",
          content: [{ type: "text", text: "1. Ship it\n2. Validate it" }],
        },
      },
    ]);

    executeExtension(runtime.pi as never);
    const handler = runtime.commands.get("execute")?.handler;

    expect(handler).toBeDefined();
    await handler?.("   ", ctx as never);

    expect(runtime.sentUserMessages).toEqual([
      {
        content: `${EXECUTE_PROMPT}\n\n<plan>\n1. Ship it\n2. Validate it\n</plan>`,
        options: undefined,
      },
    ]);
    expect(notifications).toEqual([]);
  });

  it("skips prior /execute prompt wrappers when reusing the last message", async () => {
    const runtime = createMockPiRuntime();
    const { ctx, notifications } = createMockCtx([
      {
        type: "message",
        message: {
          role: "assistant",
          content: [{ type: "text", text: "Ship the settings migration" }],
        },
      },
      {
        type: "message",
        message: {
          role: "user",
          content: `${EXECUTE_PROMPT}\n\n<plan>\nold task\n</plan>`,
        },
      },
    ]);

    executeExtension(runtime.pi as never);
    const handler = runtime.commands.get("execute")?.handler;

    expect(handler).toBeDefined();
    await handler?.("   ", ctx as never);

    expect(runtime.sentUserMessages).toEqual([
      {
        content: `${EXECUTE_PROMPT}\n\n<plan>\nShip the settings migration\n</plan>`,
        options: undefined,
      },
    ]);
    expect(notifications).toEqual([]);
  });

  it("warns when /execute has no args and no reusable message", async () => {
    const runtime = createMockPiRuntime();
    const { ctx, notifications } = createMockCtx();

    executeExtension(runtime.pi as never);
    const handler = runtime.commands.get("execute")?.handler;

    expect(handler).toBeDefined();
    await handler?.("   ", ctx as never);

    expect(runtime.sentUserMessages).toEqual([]);
    expect(notifications).toContainEqual({
      message:
        "Usage: /execute [plan] (or run it after a message to reuse that text)",
      level: "warning",
    });
  });
});
