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

import {
  EXECUTE_INVOCATION_PREAMBLE,
  EXECUTE_SYNTHESIS_MESSAGE,
} from "./constants";
import executeExtension from "./index";

const EXECUTION_BRIEF = [
  "# Execution Brief",
  "## Execution Scope\nShip it",
  "## Plan\n- Implement it",
  "## Done Criteria\n- Done",
  "## Verification\n- Test it",
  "## Out of Scope\n- Anything else",
].join("\n\n");

function expectExecutionBriefSynthesisRequest(
  content: string | undefined
): void {
  if (content === undefined) {
    throw new Error("Expected sent user message content");
  }

  expect(content).toBe(EXECUTE_SYNTHESIS_MESSAGE);
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

async function runExecuteCommand(
  runtime: ReturnType<typeof createMockPiRuntime>,
  args: string,
  ctx: unknown
): Promise<void> {
  const handler = runtime.commands.get("execute")?.handler;

  if (!handler) {
    throw new Error("Expected execute command handler");
  }

  await handler(args, ctx);
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
  it("sends the execute skill invocation packet immediately when idle", async () => {
    const runtime = createMockPiRuntime();
    const { ctx, notifications } = createMockCtx();

    executeExtension(runtime.pi as never);
    await runExecuteCommand(runtime, "implement @plan.md", ctx);

    expect(runtime.sentUserMessages).toEqual([
      {
        content: `${EXECUTE_INVOCATION_PREAMBLE}\n\n<plan>\nimplement @plan.md\n</plan>`,
        options: undefined,
      },
    ]);
    expect(notifications).toEqual([]);
  });

  it("queues the execute skill invocation packet as a follow-up when busy", async () => {
    const runtime = createMockPiRuntime();
    const { ctx, notifications } = createMockCtx();

    executeExtension(runtime.pi as never);
    await runExecuteCommand(runtime, "implement @plan.md", {
      ...ctx,
      isIdle: () => false,
    });

    expect(runtime.sentUserMessages).toEqual([
      {
        content: `${EXECUTE_INVOCATION_PREAMBLE}\n\n<plan>\nimplement @plan.md\n</plan>`,
        options: { deliverAs: "followUp" },
      },
    ]);
    expect(notifications).toContainEqual({
      message: "Queued /execute as a follow-up",
      level: "info",
    });
  });

  it("executes the latest assistant Execution Brief when /execute has no args", async () => {
    const runtime = createMockPiRuntime();
    const { ctx, notifications } = createMockCtx([
      {
        type: "message",
        message: {
          role: "assistant",
          content: [{ type: "text", text: EXECUTION_BRIEF }],
        },
      },
    ]);

    executeExtension(runtime.pi as never);
    await runExecuteCommand(runtime, "   ", ctx);

    expect(runtime.sentUserMessages).toEqual([
      {
        content: `${EXECUTE_INVOCATION_PREAMBLE}\n\n<plan>\n${EXECUTION_BRIEF}\n</plan>`,
        options: undefined,
      },
    ]);
    expect(notifications).toEqual([]);
  });

  it("synthesizes a brief and continues when a later user message makes the brief stale", async () => {
    const runtime = createMockPiRuntime();
    const { ctx, notifications } = createMockCtx([
      {
        type: "message",
        message: {
          role: "assistant",
          content: EXECUTION_BRIEF,
        },
      },
      {
        type: "message",
        message: {
          role: "user",
          content: "Actually, include settings too",
        },
      },
    ]);

    executeExtension(runtime.pi as never);
    await runExecuteCommand(runtime, "   ", ctx);

    expectExecutionBriefSynthesisRequest(runtime.sentUserMessages[0]?.content);
    expect(notifications).toEqual([]);
  });

  it("synthesizes a brief and continues when a later textless user message makes the brief stale", async () => {
    const runtime = createMockPiRuntime();
    const { ctx, notifications } = createMockCtx([
      {
        type: "message",
        message: {
          role: "assistant",
          content: EXECUTION_BRIEF,
        },
      },
      {
        type: "message",
        message: {
          role: "user",
          content: [],
        },
      },
    ]);

    executeExtension(runtime.pi as never);
    await runExecuteCommand(runtime, "   ", ctx);

    expectExecutionBriefSynthesisRequest(runtime.sentUserMessages[0]?.content);
    expect(notifications).toEqual([]);
  });

  it("synthesizes a brief and continues when a later /execute wrapper consumed the brief", async () => {
    const runtime = createMockPiRuntime();
    const { ctx, notifications } = createMockCtx([
      {
        type: "message",
        message: {
          role: "assistant",
          content: EXECUTION_BRIEF,
        },
      },
      {
        type: "message",
        message: {
          role: "user",
          content: `${EXECUTE_INVOCATION_PREAMBLE}\n\n<plan>\nold task\n</plan>`,
        },
      },
    ]);

    executeExtension(runtime.pi as never);
    await runExecuteCommand(runtime, "   ", ctx);

    expectExecutionBriefSynthesisRequest(runtime.sentUserMessages[0]?.content);
    expect(notifications).toEqual([]);
  });

  it("synthesizes a brief and continues when /execute has no args and no usable brief", async () => {
    const runtime = createMockPiRuntime();
    const { ctx, notifications } = createMockCtx();

    executeExtension(runtime.pi as never);
    await runExecuteCommand(runtime, "   ", ctx);

    expectExecutionBriefSynthesisRequest(runtime.sentUserMessages[0]?.content);
    expect(notifications).toEqual([]);
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

  it("lists unfinished checkpoints for collision detection", async () => {
    await withTempDir(async (cwd) => {
      const runtime = createMockPiRuntime();
      executeExtension(runtime.pi as never);

      const tool = runtime.tools.get("execute_checkpoint");
      expect(tool).toBeDefined();

      const checkpointDir = join(cwd, ".pi", "execute");
      mkdirSync(checkpointDir, { recursive: true });
      writeFileSync(
        join(checkpointDir, "done-plan.json"),
        `${JSON.stringify(
          {
            planId: "done-plan",
            status: "done",
            createdAt: "2026-04-17T00:00:00.000Z",
            updatedAt: "2026-04-17T00:00:00.000Z",
            normalizedSummary: "Finished work",
            tasks: [],
          },
          null,
          2
        )}\n`,
        "utf8"
      );
      writeFileSync(
        join(checkpointDir, "running-plan.json"),
        `${JSON.stringify(
          {
            planId: "running-plan",
            status: "running",
            createdAt: "2026-04-17T00:00:00.000Z",
            updatedAt: "2026-04-17T00:00:00.000Z",
            normalizedSummary: "Unfinished work",
            tasks: [
              {
                id: "1",
                subject: "Continue work",
                status: "pending",
              },
            ],
          },
          null,
          2
        )}\n`,
        "utf8"
      );

      const result = (await tool?.execute(
        "call-5",
        { op: "list_unfinished" },
        undefined,
        undefined,
        { cwd }
      )) as {
        content: Array<{ text: string }>;
      };
      const payload = JSON.parse(result.content[0]?.text ?? "{}");

      expect(payload).toEqual({
        checkpoints: [
          {
            path: join(checkpointDir, "running-plan.json"),
            checkpoint: {
              planId: "running-plan",
              status: "running",
              createdAt: "2026-04-17T00:00:00.000Z",
              updatedAt: "2026-04-17T00:00:00.000Z",
              normalizedSummary: "Unfinished work",
              tasks: [
                {
                  id: "1",
                  subject: "Continue work",
                  status: "pending",
                },
              ],
            },
          },
        ],
      });
    });
  });

  it("persists dangerous-action approval on the same plan fingerprint", async () => {
    await withTempDir(async (cwd) => {
      const runtime = createMockPiRuntime();
      executeExtension(runtime.pi as never);

      const tool = runtime.tools.get("execute_checkpoint");
      expect(tool).toBeDefined();

      const approvedCheckpoint = {
        status: "running",
        normalizedSummary: "Run dangerous migration.",
        tasks: [
          {
            id: "1",
            subject: "Apply migration",
            status: "pending",
          },
        ],
        dangerousActionApproval: {
          approved: true,
          approvedAt: "2026-04-17T00:00:00.000Z",
          reason: "User approved database migration.",
        },
      };

      await tool?.execute(
        "call-6",
        {
          op: "save",
          planId: "plan-with-approval",
          checkpoint: approvedCheckpoint,
        },
        undefined,
        undefined,
        { cwd }
      );

      await tool?.execute(
        "call-7",
        {
          op: "save",
          planId: "plan-with-approval",
          checkpoint: {
            status: "running",
            normalizedSummary: approvedCheckpoint.normalizedSummary,
            tasks: approvedCheckpoint.tasks,
          },
        },
        undefined,
        undefined,
        { cwd }
      );

      const checkpointPath = join(
        cwd,
        ".pi",
        "execute",
        "plan-with-approval.json"
      );
      const written = JSON.parse(readFileSync(checkpointPath, "utf8"));

      expect(typeof written.dangerousActionApproval.planFingerprint).toBe(
        "string"
      );
      expect(written.dangerousActionApproval).toEqual({
        approved: true,
        approvedAt: "2026-04-17T00:00:00.000Z",
        reason: "User approved database migration.",
        planFingerprint: written.dangerousActionApproval.planFingerprint,
      });
    });
  });

  it("drops dangerous-action approval when plan content changes", async () => {
    await withTempDir(async (cwd) => {
      const runtime = createMockPiRuntime();
      executeExtension(runtime.pi as never);

      const tool = runtime.tools.get("execute_checkpoint");
      expect(tool).toBeDefined();

      await tool?.execute(
        "call-8",
        {
          op: "save",
          planId: "plan-with-stale-approval",
          checkpoint: {
            status: "running",
            normalizedSummary: "Run dangerous migration.",
            tasks: [
              {
                id: "1",
                subject: "Apply migration",
                status: "pending",
              },
            ],
            dangerousActionApproval: {
              approved: true,
              approvedAt: "2026-04-17T00:00:00.000Z",
              reason: "User approved database migration.",
            },
          },
        },
        undefined,
        undefined,
        { cwd }
      );

      await tool?.execute(
        "call-9",
        {
          op: "save",
          planId: "plan-with-stale-approval",
          checkpoint: {
            status: "running",
            normalizedSummary: "Run different dangerous migration.",
            tasks: [
              {
                id: "1",
                subject: "Apply different migration",
                status: "pending",
              },
            ],
          },
        },
        undefined,
        undefined,
        { cwd }
      );

      const checkpointPath = join(
        cwd,
        ".pi",
        "execute",
        "plan-with-stale-approval.json"
      );
      const written = JSON.parse(readFileSync(checkpointPath, "utf8"));

      expect(written.dangerousActionApproval).toBeUndefined();
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
