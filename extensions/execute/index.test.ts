import { describe, expect, it } from "bun:test";
import { readFileSync } from "node:fs";
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

function createMockCtx(
  branchEntries: Array<{
    type: string;
    message?: {
      role: string;
      content: string | Array<{ type?: string; text?: string }>;
    };
  }> = [],
) {
  const notifications: Array<{ message: string; level: string }> = [];

  return {
    notifications,
    ctx: {
      isIdle: () => true,
      sessionManager: {
        getSessionId: () => "session",
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
  const tools = new Map<string, unknown>();
  const hooks = new Map<string, unknown>();
  const entries: Array<{ type: string; customType: string; data: unknown }> =
    [];
  const sentUserMessages: Array<{ content: string; options?: unknown }> = [];

  return {
    entries,
    commands,
    tools,
    hooks,
    sentUserMessages,
    pi: {
      appendEntry(customType: string, data: unknown) {
        entries.push({ type: "custom", customType, data });
      },
      registerCommand(
        name: string,
        definition: {
          handler: (args: string, ctx: unknown) => Promise<void> | void;
        },
      ) {
        commands.set(name, definition);
      },
      registerTool(definition: { name: string }) {
        tools.set(definition.name, definition);
      },
      on(event: string, handler: unknown) {
        hooks.set(event, handler);
      },
      sendUserMessage(content: string, options?: unknown) {
        sentUserMessages.push({ content, options });
      },
    },
  };
}

function invocationSuffix(
  runtime: ReturnType<typeof createMockPiRuntime>,
): string {
  const suffix = runtime.sentUserMessages[0]?.content.match(
    /\n\nExecution checkpoint invocationId: [a-f0-9-]{36}$/,
  )?.[0];
  if (!suffix) {
    throw new Error("Expected session-scoped invocation token");
  }
  return suffix;
}

async function runExecuteCommand(
  runtime: ReturnType<typeof createMockPiRuntime>,
  args: string,
  ctx: unknown,
): Promise<void> {
  const handler = runtime.commands.get("execute")?.handler;

  if (!handler) {
    throw new Error("Expected execute command handler");
  }

  await handler(args, ctx);
}

describe("execute command", () => {
  it("preserves image-bearing parent input while synthesizing requirements instead of forwarding history", async () => {
    const runtime = createMockPiRuntime();
    const imageMessage = {
      role: "user",
      content: [
        { type: "image" },
        { type: "text", text: "Implement the pictured UI" },
      ],
    };
    const branch = [
      {
        type: "message",
        message: { role: "assistant", content: EXECUTION_BRIEF },
      },
      { type: "message", message: imageMessage },
    ];
    const before = structuredClone(branch);
    const { ctx } = createMockCtx(branch);
    executeExtension(runtime.pi as never);
    await runExecuteCommand(runtime, "", ctx);
    expect(runtime.sentUserMessages[0]?.content).toBe(
      `${EXECUTE_SYNTHESIS_MESSAGE}${invocationSuffix(runtime)}`,
    );
    expect(runtime.sentUserMessages[0]?.content).toContain("attached images");
    expect(branch).toEqual(before);
    expect(runtime.hooks.has("input")).toBe(false);
  });

  it("ignores incomplete briefs and non-text content", async () => {
    for (const content of [
      EXECUTION_BRIEF.replace("## Verification", "## Not Verification"),
      [{ type: "image" }],
      [{ type: "text" }],
    ]) {
      const runtime = createMockPiRuntime();
      const { ctx } = createMockCtx([
        { type: "message", message: { role: "assistant", content } },
      ]);
      executeExtension(runtime.pi as never);
      await runExecuteCommand(runtime, "", ctx);
      expect(runtime.sentUserMessages[0]?.content).toBe(
        `${EXECUTE_SYNTHESIS_MESSAGE}${invocationSuffix(runtime)}`,
      );
    }
  });

  it("sends an explicit plan packet immediately when idle", async () => {
    const runtime = createMockPiRuntime();
    const { ctx, notifications } = createMockCtx();

    executeExtension(runtime.pi as never);
    await runExecuteCommand(runtime, "implement @plan.md", ctx);

    expect(runtime.sentUserMessages).toEqual([
      {
        content: `${EXECUTE_INVOCATION_PREAMBLE}\n\n<plan>\nimplement @plan.md\n</plan>${invocationSuffix(runtime)}`,
        options: undefined,
      },
    ]);
    expect(runtime.sentUserMessages[0]?.content).toContain(
      "This explicit `/execute` invocation authorizes blocking `subagent` calls",
    );
    expect(notifications).toEqual([]);
  });

  it("queues the same packet as a follow-up when busy", async () => {
    const runtime = createMockPiRuntime();
    const { ctx, notifications } = createMockCtx();

    executeExtension(runtime.pi as never);
    await runExecuteCommand(runtime, "implement @plan.md", {
      ...ctx,
      isIdle: () => false,
    });

    expect(runtime.sentUserMessages).toEqual([
      {
        content: `${EXECUTE_INVOCATION_PREAMBLE}\n\n<plan>\nimplement @plan.md\n</plan>${invocationSuffix(runtime)}`,
        options: { deliverAs: "followUp" },
      },
    ]);
    expect(notifications).toEqual([
      { message: "Queued /execute as a follow-up", level: "info" },
    ]);
  });

  it("reuses the latest fresh assistant Execution Brief", async () => {
    const runtime = createMockPiRuntime();
    const { ctx } = createMockCtx([
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
        content: `${EXECUTE_INVOCATION_PREAMBLE}\n\n<plan>\n${EXECUTION_BRIEF}\n</plan>${invocationSuffix(runtime)}`,
        options: undefined,
      },
    ]);
  });

  it("synthesizes when a later user message makes the brief stale", async () => {
    const runtime = createMockPiRuntime();
    const { ctx } = createMockCtx([
      {
        type: "message",
        message: { role: "assistant", content: EXECUTION_BRIEF },
      },
      {
        type: "message",
        message: { role: "user", content: "Actually, include settings too" },
      },
    ]);

    executeExtension(runtime.pi as never);
    await runExecuteCommand(runtime, "   ", ctx);

    expect(runtime.sentUserMessages[0]?.content).toBe(
      `${EXECUTE_SYNTHESIS_MESSAGE}${invocationSuffix(runtime)}`,
    );
  });

  it("synthesizes when no usable brief exists", async () => {
    const runtime = createMockPiRuntime();
    const { ctx } = createMockCtx();

    executeExtension(runtime.pi as never);
    await runExecuteCommand(runtime, "   ", ctx);

    expect(runtime.sentUserMessages[0]?.content).toBe(
      `${EXECUTE_SYNTHESIS_MESSAGE}${invocationSuffix(runtime)}`,
    );
  });

  it("registers only the narrow checkpoint and branch lifecycle hooks", () => {
    const runtime = createMockPiRuntime();

    executeExtension(runtime.pi as never);

    expect([...runtime.commands.keys()]).toEqual(["execute"]);
    expect([...runtime.tools.keys()]).toEqual(["execute_checkpoint"]);
    expect(runtime.hooks.has("session_start")).toBe(true);
    expect(runtime.hooks.has("session_tree")).toBe(true);
  });
});

describe("execute documentation contract", () => {
  it("documents native workflow dispatch and main-session verification", () => {
    const skill = readFileSync(
      join(import.meta.dir, "../../skills/execute/SKILL.md"),
      "utf8",
    );

    expect(skill).toContain("subagent({");
    expect(skill).toContain("execute_checkpoint");
    expect(skill).toContain("StructuredOutput");
    expect(skill).toContain("conservative danger preflight");
    expect(skill).toContain("explicit user approval");
    expect(skill).toContain(
      "main session still performs independent verification",
    );
    expect(skill).not.toMatch(
      /SubagentWorkflow|TaskCreate|TaskUpdate|@tintinweb/,
    );
  });
});
