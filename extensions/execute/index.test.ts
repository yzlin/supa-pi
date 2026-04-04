import { describe, expect, it } from "bun:test";

import executeExtension from "./index";
import { EXECUTE_PROMPT } from "./constants";

function createMockCtx() {
  const notifications: Array<{ message: string; level: string }> = [];

  return {
    notifications,
    ctx: {
      isIdle: () => true,
      ui: {
        notify(message: string, level: string) {
          notifications.push({ message, level });
        },
      },
    },
  };
}

function createMockPiRuntime() {
  const commands = new Map<string, { handler: (args: string, ctx: unknown) => Promise<void> | void }>();
  const sentUserMessages: Array<{ content: string; options?: unknown }> = [];

  return {
    commands,
    sentUserMessages,
    pi: {
      registerCommand(name: string, definition: { handler: (args: string, ctx: unknown) => Promise<void> | void }) {
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
        content: `${EXECUTE_PROMPT}\n\nTask: implement @plan.md`,
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
    await handler?.(
      "implement @plan.md",
      { ...ctx, isIdle: () => false } as never
    );

    expect(runtime.sentUserMessages).toEqual([
      {
        content: `${EXECUTE_PROMPT}\n\nTask: implement @plan.md`,
        options: { deliverAs: "followUp" },
      },
    ]);
    expect(notifications).toContainEqual({
      message: "Queued /execute as a follow-up",
      level: "info",
    });
  });

  it("warns when /execute is missing a plan", async () => {
    const runtime = createMockPiRuntime();
    const { ctx, notifications } = createMockCtx();

    executeExtension(runtime.pi as never);
    const handler = runtime.commands.get("execute")?.handler;

    expect(handler).toBeDefined();
    await handler?.("   ", ctx as never);

    expect(runtime.sentUserMessages).toEqual([]);
    expect(notifications).toContainEqual({
      message: "Usage: /execute <plan>",
      level: "warning",
    });
  });
});
