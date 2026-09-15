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
  const tools = new Map<string, unknown>();
  const hooks = new Map<string, unknown>();
  const sentUserMessages: Array<{ content: string; options?: unknown }> = [];

  return {
    commands,
    tools,
    hooks,
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

describe("execute command", () => {
  it("sends an explicit plan packet immediately when idle", async () => {
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
    expect(runtime.sentUserMessages[0]?.content).toContain(
      "This explicit `/execute` invocation authorizes the main session to call `SubagentWorkflow`"
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
        content: `${EXECUTE_INVOCATION_PREAMBLE}\n\n<plan>\nimplement @plan.md\n</plan>`,
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
        content: `${EXECUTE_INVOCATION_PREAMBLE}\n\n<plan>\n${EXECUTION_BRIEF}\n</plan>`,
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
      EXECUTE_SYNTHESIS_MESSAGE
    );
  });

  it("synthesizes when no usable brief exists", async () => {
    const runtime = createMockPiRuntime();
    const { ctx } = createMockCtx();

    executeExtension(runtime.pi as never);
    await runExecuteCommand(runtime, "   ", ctx);

    expect(runtime.sentUserMessages[0]?.content).toBe(
      EXECUTE_SYNTHESIS_MESSAGE
    );
  });

  it("registers no retired execute tools or lifecycle hooks", () => {
    const runtime = createMockPiRuntime();

    executeExtension(runtime.pi as never);

    expect([...runtime.commands.keys()]).toEqual(["execute"]);
    expect(runtime.tools.size).toBe(0);
    expect(runtime.hooks.size).toBe(0);
  });
});

describe("execute documentation contract", () => {
  it("documents native workflow dispatch and main-session verification", () => {
    const skill = readFileSync(
      join(import.meta.dir, "../../skills/execute/SKILL.md"),
      "utf8"
    );

    expect(skill).toContain("SubagentWorkflow");
    expect(skill).toContain("@tintinweb/pi-tasks");
    expect(skill).toContain("StructuredOutput");
    expect(skill).toContain("conservative danger preflight");
    expect(skill).toContain("explicit user approval");
    expect(skill).toContain(
      "main session still performs independent verification"
    );
    expect(skill).toContain("Upstream workflow journals");
    expect(skill).toContain(
      "explicit `/execute` invocation is the user's opt-in to this workflow"
    );
    expect(skill).toContain("parent/main-session stop does not cancel");
    expect(skill).toContain("`null` or missing result");
    expect(skill).toContain("has no `blocked` task status");
    expect(skill).not.toContain("execute_tasks");
    expect(skill).not.toContain("execute_checkpoint");
    expect(skill).not.toContain("tddShape");
  });
});
