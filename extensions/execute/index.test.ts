import { describe, expect, it } from "bun:test";
import { createHash } from "node:crypto";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
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

function hashCanonicalPlan(canonicalPlan: string): string {
  return createHash("sha256").update(canonicalPlan.trim()).digest("hex");
}

function readToolPayload(result: unknown): Record<string, unknown> {
  const text = (result as { content: Array<{ text: string }> }).content[0]
    ?.text;

  if (!text) {
    throw new Error("Expected tool text payload");
  }

  return JSON.parse(text);
}

async function runExecuteCheckpointTool(
  runtime: ReturnType<typeof createMockPiRuntime>,
  cwd: string,
  params: unknown,
  toolCallId = "call"
): Promise<unknown> {
  const tool = runtime.tools.get("execute_checkpoint");

  if (!tool) {
    throw new Error("Expected execute_checkpoint tool");
  }

  return await tool.execute(toolCallId, params, undefined, undefined, { cwd });
}

function writeJsonFile(path: string, value: unknown): void {
  writeFileSync(path, `${JSON.stringify(value)}\n`, "utf8");
}

describe("execute_checkpoint tool", () => {
  it("registers the checkpoint tool with the execute extension", () => {
    const runtime = createMockPiRuntime();

    executeExtension(runtime.pi as never);

    expect(runtime.tools.has("execute_checkpoint")).toBe(true);
  });

  it("pure load misses by canonicalPlan without creating checkpoint files", async () => {
    await withTempDir(async (cwd) => {
      const runtime = createMockPiRuntime();
      executeExtension(runtime.pi as never);
      const result = await runExecuteCheckpointTool(
        runtime,
        cwd,
        { op: "load", canonicalPlan: "  Ship thumbnails  " },
        "call-1"
      );
      const payload = readToolPayload(result);

      expect(payload).toEqual({
        found: false,
        canonicalPlanHash: hashCanonicalPlan("Ship thumbnails"),
        warnings: [],
      });
      expect(existsSync(join(cwd, ".pi", "execute"))).toBe(false);
    });
  });

  it("pure load with legacy files does not create an index", async () => {
    await withTempDir(async (cwd) => {
      const runtime = createMockPiRuntime();
      executeExtension(runtime.pi as never);
      const checkpointDir = join(cwd, ".pi", "execute");
      mkdirSync(checkpointDir, { recursive: true });
      writeJsonFile(join(checkpointDir, "legacy-plan.json"), {
        planId: "legacy-plan",
        status: "running",
      });

      const payload = readToolPayload(
        await runExecuteCheckpointTool(
          runtime,
          cwd,
          { op: "load", canonicalPlan: "No match" },
          "call-1b"
        )
      );

      expect(payload.found).toBe(false);
      expect(existsSync(join(checkpointDir, "index.json"))).toBe(false);
    });
  });

  it("saves and loads canonicalPlan checkpoints using UUID filenames and index entries", async () => {
    await withTempDir(async (cwd) => {
      const runtime = createMockPiRuntime();
      executeExtension(runtime.pi as never);
      const canonicalPlan = "Ship the gallery thumbnail strip.";
      const canonicalPlanHash = hashCanonicalPlan(canonicalPlan);

      const savePayload = readToolPayload(
        await runExecuteCheckpointTool(
          runtime,
          cwd,
          {
            op: "save",
            canonicalPlan,
            checkpoint: {
              status: "running",
              normalizedSummary: "Ship thumbnails.",
              tasks: [{ id: "1", subject: "Build strip", status: "pending" }],
            },
          },
          "call-2"
        )
      );

      expect(savePayload.created).toBe(true);
      expect(savePayload.status).toBe("running");
      expect(savePayload.taskCount).toBe(1);
      expect(savePayload.path).toMatch(/execute-v1-[0-9a-f-]+\.json$/);

      const checkpointPath = savePayload.path as string;
      const written = JSON.parse(readFileSync(checkpointPath, "utf8"));
      expect(written).toMatchObject({
        version: 1,
        canonicalPlanHash,
        status: "running",
        normalizedSummary: "Ship thumbnails.",
      });
      expect(typeof written.id).toBe("string");
      expect(checkpointPath).toBe(
        join(cwd, ".pi", "execute", `execute-v1-${written.id}.json`)
      );
      expect(
        JSON.parse(
          readFileSync(join(cwd, ".pi", "execute", "index.json"), "utf8")
        )
      ).toEqual({
        [canonicalPlanHash]: written.id,
      });

      const loadPayload = readToolPayload(
        await runExecuteCheckpointTool(
          runtime,
          cwd,
          { op: "load", canonicalPlan },
          "call-3"
        )
      );

      expect(loadPayload).toEqual({
        found: true,
        path: checkpointPath,
        canonicalPlanHash,
        checkpoint: written,
        warnings: [],
      });
    });
  });

  it("resolves the same canonicalPlan to the same checkpoint on repeated saves", async () => {
    await withTempDir(async (cwd) => {
      const runtime = createMockPiRuntime();
      executeExtension(runtime.pi as never);
      const canonicalPlan = "Repeatable plan identity";
      const saveParams = {
        op: "save",
        canonicalPlan,
        checkpoint: {
          status: "running",
          normalizedSummary: "Repeatable work",
          tasks: [{ id: "1", subject: "Do work", status: "pending" }],
        },
      };

      const first = readToolPayload(
        await runExecuteCheckpointTool(runtime, cwd, saveParams, "call-4")
      );
      const second = readToolPayload(
        await runExecuteCheckpointTool(runtime, cwd, saveParams, "call-5")
      );

      expect(first.created).toBe(true);
      expect(second.created).toBe(false);
      expect(second.path).toBe(first.path);
      const checkpointFiles = readdirSync(join(cwd, ".pi", "execute")).filter(
        (entry) => entry.startsWith("execute-v1-")
      );
      expect(checkpointFiles).toHaveLength(1);
    });
  });

  it("finds missing-index checkpoints by scan and repairs cache on save", async () => {
    await withTempDir(async (cwd) => {
      const runtime = createMockPiRuntime();
      executeExtension(runtime.pi as never);
      const canonicalPlan = "Repair index from files";
      const canonicalPlanHash = hashCanonicalPlan(canonicalPlan);

      await runExecuteCheckpointTool(
        runtime,
        cwd,
        {
          op: "save",
          canonicalPlan,
          checkpoint: {
            status: "running",
            normalizedSummary: "Repair",
            tasks: [],
          },
        },
        "call-6"
      );
      rmSync(join(cwd, ".pi", "execute", "index.json"), { force: true });

      const loadPayload = readToolPayload(
        await runExecuteCheckpointTool(
          runtime,
          cwd,
          { op: "load", canonicalPlan },
          "call-7"
        )
      );

      expect(loadPayload.found).toBe(true);
      expect(existsSync(join(cwd, ".pi", "execute", "index.json"))).toBe(
        false
      );

      await runExecuteCheckpointTool(
        runtime,
        cwd,
        {
          op: "save",
          canonicalPlan,
          checkpoint: {
            status: "running",
            normalizedSummary: "Repair updated",
            tasks: [],
          },
        },
        "call-7b"
      );

      const repairedIndex = JSON.parse(
        readFileSync(join(cwd, ".pi", "execute", "index.json"), "utf8")
      );
      expect(repairedIndex[canonicalPlanHash]).toBe(
        (loadPayload.checkpoint as { id: string }).id
      );
    });
  });

  it("lists only unfinished v1 checkpoints and ignores readable legacy files", async () => {
    await withTempDir(async (cwd) => {
      const runtime = createMockPiRuntime();
      executeExtension(runtime.pi as never);
      const checkpointDir = join(cwd, ".pi", "execute");
      mkdirSync(checkpointDir, { recursive: true });
      writeJsonFile(join(checkpointDir, "legacy-plan.json"), {
        planId: "legacy-plan",
        status: "running",
        normalizedSummary: "Legacy",
        tasks: [],
      });

      await runExecuteCheckpointTool(
        runtime,
        cwd,
        {
          op: "save",
          canonicalPlan: "Running v1",
          checkpoint: {
            status: "running",
            normalizedSummary: "Running v1",
            tasks: [{ id: "1", subject: "Continue", status: "pending" }],
          },
        },
        "call-8"
      );
      await runExecuteCheckpointTool(
        runtime,
        cwd,
        {
          op: "save",
          canonicalPlan: "Done v1",
          checkpoint: {
            status: "done",
            normalizedSummary: "Done v1",
            tasks: [],
          },
        },
        "call-9"
      );

      const payload = readToolPayload(
        await runExecuteCheckpointTool(
          runtime,
          cwd,
          { op: "list_unfinished" },
          "call-10"
        )
      );

      expect(payload).toEqual({
        checkpoints: [
          {
            id: (payload.checkpoints as Array<{ id: string }>)[0]?.id,
            path: (payload.checkpoints as Array<{ path: string }>)[0]?.path,
            status: "running",
            normalizedSummary: "Running v1",
            tasks: [{ id: "1", subject: "Continue", status: "pending" }],
            canonicalPlanHash: hashCanonicalPlan("Running v1"),
          },
        ],
        warnings: [],
      });
      expect(existsSync(join(checkpointDir, "legacy-plan.json"))).toBe(true);
    });
  });

  it("hard-errors old planId-only load and save calls", async () => {
    await withTempDir(async (cwd) => {
      const runtime = createMockPiRuntime();
      executeExtension(runtime.pi as never);
      const loadResult = await runExecuteCheckpointTool(
        runtime,
        cwd,
        { op: "load", planId: "old-plan" },
        "call-11"
      );
      const saveResult = await runExecuteCheckpointTool(
        runtime,
        cwd,
        {
          op: "save",
          planId: "old-plan",
          checkpoint: {
            status: "running",
            normalizedSummary: "Old",
            tasks: [],
          },
        },
        "call-12"
      );
      const loadPayload = readToolPayload(loadResult);
      const savePayload = readToolPayload(saveResult);

      expect((loadResult as { isError?: boolean }).isError).toBe(true);
      expect((saveResult as { isError?: boolean }).isError).toBe(true);
      expect(loadPayload.error).toBe(
        "planId-only execute_checkpoint load is no longer supported; canonicalPlan is required."
      );
      expect(savePayload.error).toBe(
        "planId-only execute_checkpoint save is no longer supported; canonicalPlan is required."
      );
    });
  });

  it("stamps dangerous-action approvals that lack canonicalPlanHash", async () => {
    await withTempDir(async (cwd) => {
      const runtime = createMockPiRuntime();
      executeExtension(runtime.pi as never);
      const canonicalPlan = "Dangerous canonical plan";
      const canonicalPlanHash = hashCanonicalPlan(canonicalPlan);

      const savePayload = readToolPayload(
        await runExecuteCheckpointTool(
          runtime,
          cwd,
          {
            op: "save",
            canonicalPlan,
            checkpoint: {
              status: "running",
              normalizedSummary: "Run migration",
              tasks: [{ id: "1", subject: "Migrate", status: "pending" }],
              dangerousActionApproval: {
                approved: true,
                approvedAt: "2026-04-17T00:00:00.000Z",
                reason: "User approved.",
              },
            },
          },
          "call-13"
        )
      );
      const written = JSON.parse(
        readFileSync(savePayload.path as string, "utf8")
      );

      expect(written.dangerousActionApproval).toEqual({
        approved: true,
        approvedAt: "2026-04-17T00:00:00.000Z",
        reason: "User approved.",
        canonicalPlanHash,
      });
    });
  });

  it("rejects dangerous-action approvals bound to another canonicalPlanHash", async () => {
    await withTempDir(async (cwd) => {
      const runtime = createMockPiRuntime();
      executeExtension(runtime.pi as never);
      const saveResult = await runExecuteCheckpointTool(
        runtime,
        cwd,
        {
          op: "save",
          canonicalPlan: "New dangerous canonical plan",
          checkpoint: {
            status: "running",
            normalizedSummary: "Run migration",
            tasks: [{ id: "1", subject: "Migrate", status: "pending" }],
            dangerousActionApproval: {
              approved: true,
              approvedAt: "2026-04-17T00:00:00.000Z",
              reason: "User approved old plan.",
              canonicalPlanHash: hashCanonicalPlan("Old dangerous plan"),
            },
          },
        },
        "call-14"
      );
      const savePayload = readToolPayload(saveResult);

      expect((saveResult as { isError?: boolean }).isError).toBe(true);
      expect(savePayload.error).toBe(
        "Invalid execute checkpoint: dangerousActionApproval.canonicalPlanHash must match canonicalPlanHash."
      );
      expect(existsSync(join(cwd, ".pi", "execute"))).toBe(false);
    });
  });

  it("chooses the newest duplicate same-hash v1 file and warns with paths", async () => {
    await withTempDir(async (cwd) => {
      const runtime = createMockPiRuntime();
      executeExtension(runtime.pi as never);
      const checkpointDir = join(cwd, ".pi", "execute");
      const canonicalPlan = "Duplicate canonical plan";
      const canonicalPlanHash = hashCanonicalPlan(canonicalPlan);
      const olderPath = join(
        checkpointDir,
        "execute-v1-11111111-1111-4111-8111-111111111111.json"
      );
      const newerPath = join(
        checkpointDir,
        "execute-v1-22222222-2222-4222-8222-222222222222.json"
      );
      mkdirSync(checkpointDir, { recursive: true });
      writeJsonFile(olderPath, {
        version: 1,
        id: "11111111-1111-4111-8111-111111111111",
        canonicalPlanHash,
        status: "running",
        createdAt: "2026-04-17T00:00:00.000Z",
        updatedAt: "2026-04-17T00:00:00.000Z",
        normalizedSummary: "Older",
        tasks: [],
      });
      writeJsonFile(newerPath, {
        version: 1,
        id: "22222222-2222-4222-8222-222222222222",
        canonicalPlanHash,
        status: "running",
        createdAt: "2026-04-17T00:00:00.000Z",
        updatedAt: "2026-04-18T00:00:00.000Z",
        normalizedSummary: "Newer",
        tasks: [],
      });

      const payload = readToolPayload(
        await runExecuteCheckpointTool(
          runtime,
          cwd,
          { op: "load", canonicalPlan },
          "call-14"
        )
      );

      expect(payload.found).toBe(true);
      expect(payload.path).toBe(newerPath);
      expect(
        (payload.checkpoint as { normalizedSummary: string }).normalizedSummary
      ).toBe("Newer");
      expect((payload.warnings as string[])[0]).toContain(canonicalPlanHash);
      expect((payload.warnings as string[])[0]).toContain(newerPath);
      expect((payload.warnings as string[])[0]).toContain(olderPath);

      const savePayload = readToolPayload(
        await runExecuteCheckpointTool(
          runtime,
          cwd,
          {
            op: "save",
            canonicalPlan,
            checkpoint: {
              status: "running",
              normalizedSummary: "Saved newest",
              tasks: [],
            },
          },
          "call-15"
        )
      );
      expect((savePayload.warnings as string[])[0]).toContain(olderPath);
    });
  });
});
