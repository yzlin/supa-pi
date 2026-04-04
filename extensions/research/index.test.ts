import { describe, expect, it } from "bun:test";

import researchExtension, { buildResearchCommandMessage } from "./index";

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

describe("research command", () => {
  it("builds a pi-tasks orchestration message for the researcher agent", () => {
    const message = buildResearchCommandMessage(
      "compare Bun and Node for CLI tooling"
    );

    expect(message).toContain("Run the requested research through pi-tasks");
    expect(message).toContain('agentType: "researcher"');
    expect(message).toContain(
      "Research request: compare Bun and Node for CLI tooling"
    );
  });

  it("sends the research orchestration prompt immediately when idle", async () => {
    const runtime = createMockPiRuntime();
    const { ctx, notifications } = createMockCtx();

    researchExtension(runtime.pi as never);
    const handler = runtime.commands.get("research")?.handler;

    expect(handler).toBeDefined();
    await handler?.("compare Bun and Node for CLI tooling", ctx as never);

    expect(runtime.sentUserMessages).toEqual([
      {
        content: buildResearchCommandMessage(
          "compare Bun and Node for CLI tooling"
        ),
        options: undefined,
      },
    ]);
    expect(notifications).toEqual([]);
  });

  it("queues the research orchestration prompt as a follow-up when busy", async () => {
    const runtime = createMockPiRuntime();
    const { ctx, notifications } = createMockCtx();

    researchExtension(runtime.pi as never);
    const handler = runtime.commands.get("research")?.handler;

    expect(handler).toBeDefined();
    await handler?.("compare Bun and Node for CLI tooling", {
      ...ctx,
      isIdle: () => false,
    } as never);

    expect(runtime.sentUserMessages).toEqual([
      {
        content: buildResearchCommandMessage(
          "compare Bun and Node for CLI tooling"
        ),
        options: { deliverAs: "followUp" },
      },
    ]);
    expect(notifications).toContainEqual({
      message: "Queued /research as a follow-up",
      level: "info",
    });
  });

  it("warns when /research is missing a topic", async () => {
    const runtime = createMockPiRuntime();
    const { ctx, notifications } = createMockCtx();

    researchExtension(runtime.pi as never);
    const handler = runtime.commands.get("research")?.handler;

    expect(handler).toBeDefined();
    await handler?.("   ", ctx as never);

    expect(runtime.sentUserMessages).toEqual([]);
    expect(notifications).toContainEqual({
      message: "Usage: /research <topic>",
      level: "warning",
    });
  });
});
