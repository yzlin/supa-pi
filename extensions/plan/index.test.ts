import * as fs from "node:fs";
import * as path from "node:path";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "bun:test";

import planExtension from "./index";

const PROMPT = fs
  .readFileSync(
    path.join(path.dirname(fileURLToPath(import.meta.url)), "prompt.md"),
    "utf8"
  )
  .trim();

function buildPlanRequest(task: string): string {
  return `${PROMPT}\n\n<request>\n${task}\n</request>`;
}

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
    {
      handler: (args: string, ctx: unknown) => Promise<void> | void;
    }
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

describe("plan command", () => {
  it("sends the planner prompt immediately when idle", async () => {
    const runtime = createMockPiRuntime();
    const { ctx, notifications } = createMockCtx();

    planExtension(runtime.pi as never);
    const handler = runtime.commands.get("plan")?.handler;

    expect(handler).toBeDefined();
    await handler?.("ship settings sync", ctx as never);

    expect(runtime.sentUserMessages).toEqual([
      {
        content: buildPlanRequest("ship settings sync"),
        options: undefined,
      },
    ]);
    expect(notifications).toEqual([]);
  });

  it("queues the planner prompt as a follow-up when busy", async () => {
    const runtime = createMockPiRuntime();
    const { ctx, notifications } = createMockCtx();

    planExtension(runtime.pi as never);
    const handler = runtime.commands.get("plan")?.handler;

    expect(handler).toBeDefined();
    await handler?.(
      "ship settings sync",
      { ...ctx, isIdle: () => false } as never
    );

    expect(runtime.sentUserMessages).toEqual([
      {
        content: buildPlanRequest("ship settings sync"),
        options: { deliverAs: "followUp" },
      },
    ]);
    expect(notifications).toContainEqual({
      message: "Queued /plan as a follow-up",
      level: "info",
    });
  });

  it("reuses the last session message when /plan has no args", async () => {
    const runtime = createMockPiRuntime();
    const { ctx, notifications } = createMockCtx([
      {
        type: "message",
        message: {
          role: "assistant",
          content: [{ type: "text", text: "ship settings sync" }],
        },
      },
    ]);

    planExtension(runtime.pi as never);
    const handler = runtime.commands.get("plan")?.handler;

    expect(handler).toBeDefined();
    await handler?.("   ", ctx as never);

    expect(runtime.sentUserMessages).toEqual([
      {
        content: buildPlanRequest("ship settings sync"),
        options: undefined,
      },
    ]);
    expect(notifications).toEqual([]);
  });

  it("skips prior /plan prompt wrappers when reusing the last message", async () => {
    const runtime = createMockPiRuntime();
    const { ctx, notifications } = createMockCtx([
      {
        type: "message",
        message: {
          role: "assistant",
          content: [{ type: "text", text: "ship settings sync" }],
        },
      },
      {
        type: "message",
        message: {
          role: "user",
          content: buildPlanRequest("old task"),
        },
      },
    ]);

    planExtension(runtime.pi as never);
    const handler = runtime.commands.get("plan")?.handler;

    expect(handler).toBeDefined();
    await handler?.("   ", ctx as never);

    expect(runtime.sentUserMessages).toEqual([
      {
        content: buildPlanRequest("ship settings sync"),
        options: undefined,
      },
    ]);
    expect(notifications).toEqual([]);
  });

  it("warns when /plan has no args and no reusable message", async () => {
    const runtime = createMockPiRuntime();
    const { ctx, notifications } = createMockCtx();

    planExtension(runtime.pi as never);
    const handler = runtime.commands.get("plan")?.handler;

    expect(handler).toBeDefined();
    await handler?.("   ", ctx as never);

    expect(runtime.sentUserMessages).toEqual([]);
    expect(notifications).toContainEqual({
      message:
        "Usage: /plan [what to build] (or run it after a message to reuse that text)",
      level: "warning",
    });
  });
});
