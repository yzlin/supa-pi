import { describe, expect, it } from "bun:test";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

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
  const tools = new Map<
    string,
    {
      name: string;
      execute: (
        toolCallId: string,
        params: unknown,
        signal: AbortSignal | undefined,
        onUpdate: unknown,
        ctx: unknown
      ) => Promise<unknown> | unknown;
    }
  >();
  const sentUserMessages: Array<{ content: string; options?: unknown }> = [];

  return {
    commands,
    tools,
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
      registerTool(definition: {
        name: string;
        execute: (
          toolCallId: string,
          params: unknown,
          signal: AbortSignal | undefined,
          onUpdate: unknown,
          ctx: unknown
        ) => Promise<unknown> | unknown;
      }) {
        tools.set(definition.name, definition);
      },
      sendUserMessage(content: string, options?: unknown) {
        sentUserMessages.push({ content, options });
      },
    },
  };
}

async function withTempDir<T>(run: (cwd: string) => Promise<T> | T) {
  const cwd = mkdtempSync(join(tmpdir(), "pi-execute-test-"));

  try {
    return await run(cwd);
  } finally {
    rmSync(cwd, { recursive: true, force: true });
  }
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

describe("execute_checkpoint tool", () => {
  it("registers the checkpoint tool with the execute extension", () => {
    const runtime = createMockPiRuntime();

    executeExtension(runtime.pi as never);

    expect(runtime.tools.has("execute_checkpoint")).toBe(true);
  });

  it("returns not found when no checkpoint exists", async () => {
    await withTempDir(async (cwd) => {
      const runtime = createMockPiRuntime();
      executeExtension(runtime.pi as never);

      const tool = runtime.tools.get("execute_checkpoint");
      expect(tool).toBeDefined();

      const result = (await tool?.execute(
        "call-1",
        { op: "load", planId: "plan-1" },
        undefined,
        undefined,
        { cwd }
      )) as {
        content: Array<{ text: string }>;
      };
      const payload = JSON.parse(result.content[0]?.text ?? "{}");

      expect(payload).toEqual({
        found: false,
        path: join(cwd, ".pi", "execute", "plan-1.json"),
      });
    });
  });

  it("saves a new checkpoint and preserves stored state on load", async () => {
    await withTempDir(async (cwd) => {
      const runtime = createMockPiRuntime();
      executeExtension(runtime.pi as never);

      const tool = runtime.tools.get("execute_checkpoint");
      expect(tool).toBeDefined();

      const saveResult = (await tool?.execute(
        "call-2",
        {
          op: "save",
          planId: "plan-2",
          checkpoint: {
            status: "running",
            normalizedSummary: "Ship the gallery thumbnail strip.",
            tasks: [
              {
                id: "1",
                subject: "Implement thumbnail strip feature",
                status: "pending",
              },
            ],
          },
        },
        undefined,
        undefined,
        { cwd }
      )) as {
        content: Array<{ text: string }>;
      };
      const savePayload = JSON.parse(saveResult.content[0]?.text ?? "{}");
      const checkpointPath = join(cwd, ".pi", "execute", "plan-2.json");

      expect(savePayload).toEqual({
        path: checkpointPath,
        created: true,
        status: "running",
        taskCount: 1,
      });
      expect(existsSync(checkpointPath)).toBe(true);

      const written = JSON.parse(readFileSync(checkpointPath, "utf8"));
      expect(written.planId).toBe("plan-2");
      expect(written.status).toBe("running");
      expect(written.normalizedSummary).toBe(
        "Ship the gallery thumbnail strip."
      );
      expect(written.tasks).toEqual([
        {
          id: "1",
          subject: "Implement thumbnail strip feature",
          status: "pending",
        },
      ]);
      expect(typeof written.createdAt).toBe("string");
      expect(typeof written.updatedAt).toBe("string");

      const loadResult = (await tool?.execute(
        "call-3",
        { op: "load", planId: "plan-2" },
        undefined,
        undefined,
        { cwd }
      )) as {
        content: Array<{ text: string }>;
      };
      const loadPayload = JSON.parse(loadResult.content[0]?.text ?? "{}");

      expect(loadPayload).toEqual({
        found: true,
        path: checkpointPath,
        checkpoint: written,
      });
    });
  });

  it("preserves createdAt when saving an existing checkpoint", async () => {
    await withTempDir(async (cwd) => {
      const runtime = createMockPiRuntime();
      executeExtension(runtime.pi as never);

      const tool = runtime.tools.get("execute_checkpoint");
      expect(tool).toBeDefined();

      const checkpointDir = join(cwd, ".pi", "execute");
      const checkpointPath = join(checkpointDir, "plan-3.json");
      mkdirSync(checkpointDir, { recursive: true });
      writeFileSync(
        checkpointPath,
        `${JSON.stringify(
          {
            planId: "plan-3",
            status: "starting",
            createdAt: "2026-04-17T00:00:00.000Z",
            updatedAt: "2026-04-17T00:00:00.000Z",
            normalizedSummary: "Old summary",
            tasks: [],
          },
          null,
          2
        )}\n`,
        "utf8"
      );

      const result = (await tool?.execute(
        "call-4",
        {
          op: "save",
          planId: "plan-3",
          checkpoint: {
            status: "running",
            normalizedSummary: "New summary",
            tasks: [
              {
                id: "1",
                subject: "Do the work",
                status: "in_progress",
                blockedBy: ["0"],
              },
            ],
          },
        },
        undefined,
        undefined,
        { cwd }
      )) as {
        content: Array<{ text: string }>;
      };
      const payload = JSON.parse(result.content[0]?.text ?? "{}");
      const written = JSON.parse(readFileSync(checkpointPath, "utf8"));

      expect(payload).toEqual({
        path: checkpointPath,
        created: false,
        status: "running",
        taskCount: 1,
      });
      expect(written.createdAt).toBe("2026-04-17T00:00:00.000Z");
      expect(written.updatedAt).not.toBe("2026-04-17T00:00:00.000Z");
      expect(written.tasks).toEqual([
        {
          id: "1",
          subject: "Do the work",
          status: "in_progress",
          blockedBy: ["0"],
        },
      ]);
    });
  });
});
