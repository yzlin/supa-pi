import { describe, expect, it } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";

import codeImprovementExtension, {
  buildImproveCodebaseArchitectureCommandMessage,
  buildSimplifyCommandMessage,
} from "./index";

function createMockCtx(isIdle = true) {
  const notifications: Array<{ message: string; level: string }> = [];

  return {
    notifications,
    ctx: {
      isIdle: () => isIdle,
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

function getRegisteredCommand(
  commands: Map<
    string,
    { handler: (args: string, ctx: unknown) => Promise<void> | void }
  >,
  name: string
) {
  const command = commands.get(name);

  expect(command).toBeDefined();

  return command;
}

function readRepoFile(...parts: string[]): string {
  return readFileSync(join(process.cwd(), ...parts), "utf8").trim();
}

function readPackageJson(): { pi: { extensions: string[] } } {
  return JSON.parse(readRepoFile("package.json"));
}

describe("code-improvement commands", () => {
  it("registers the code-improvement extension in package.json without the old simplify extension", () => {
    const packageJson = readPackageJson();

    expect(packageJson.pi.extensions).toContain(
      "./extensions/code-improvement"
    );
    expect(packageJson.pi.extensions).not.toContain("./extensions/simplify");
  });

  it("registers /simplify and /improve-codebase-architecture", () => {
    const runtime = createMockPiRuntime();

    codeImprovementExtension(runtime.pi as never);

    expect([...runtime.commands.keys()].sort()).toEqual([
      "improve-codebase-architecture",
      "simplify",
    ]);
  });

  it("preserves /simplify default and focused prompt semantics", () => {
    const simplifyPrompt = readRepoFile(
      "extensions",
      "code-improvement",
      "SIMPLIFY.md"
    );

    expect(buildSimplifyCommandMessage("   ")).toBe(
      `${simplifyPrompt}\n\nFocus instruction: Simplify the recent feature implementation or recently modified code in this session.`
    );
    expect(buildSimplifyCommandMessage("  focus here  ")).toBe(
      `${simplifyPrompt}\n\nFocus instruction: focus here`
    );
  });

  it("builds the architecture review message with optional scope injection", () => {
    expect(buildImproveCodebaseArchitectureCommandMessage("   ")).toContain(
      "Scope instruction: No explicit scope provided. Start broad, then narrow based on explorer findings."
    );
    expect(
      buildImproveCodebaseArchitectureCommandMessage(
        "  extensions/context-docs  "
      )
    ).toContain("Scope instruction: extensions/context-docs");
  });

  it("composes the architecture prompt from uppercase support docs", () => {
    const message = buildImproveCodebaseArchitectureCommandMessage("   ");
    const supportDocs = ["LANGUAGE.md", "DEEPENING.md", "INTERFACE-DESIGN.md"];

    for (const supportDoc of supportDocs) {
      expect(message).toContain(
        readRepoFile("extensions", "code-improvement", supportDoc)
      );
    }
  });

  it("keeps the architecture prompt read-only", () => {
    const message =
      buildImproveCodebaseArchitectureCommandMessage("src/domain");

    expect(message).toContain(
      "Read-only by default. Do not edit files, implement code, create branches, commit, or run destructive commands."
    );
    expect(message).toContain(
      "Produce analysis and plans only. Do not implement."
    );
    expect(message).toContain(
      "Do not propose final Interfaces in the candidate report. Ask which candidate should be turned into an implementation plan."
    );
    expect(message).toContain("read-only plan, no code changes");
  });

  it("requires explorer-first architecture review", () => {
    const message =
      buildImproveCodebaseArchitectureCommandMessage("src/domain");

    expect(message).toContain(
      'The first substantive action must be an `Agent` call with `subagent_type: "explorer"`.'
    );
    expect(message).toContain(
      'Immediately use the `Agent` tool with `subagent_type: "explorer"` to inspect the requested scope.'
    );
    expect(message).toContain(
      "Use direct tool reads only after the explorer-first step, to verify specific findings."
    );
    expect(message).toContain(
      "architecture friction, shallow Modules, coupling across Seams, testing pain, domain vocabulary, and relevant ADR constraints"
    );
  });

  it("requires strict architecture vocabulary", () => {
    const message =
      buildImproveCodebaseArchitectureCommandMessage("src/domain");
    const terms = [
      "Module",
      "Interface",
      "Implementation",
      "Depth",
      "Seam",
      "Adapter",
      "Leverage",
      "Locality",
    ];

    expect(message).toContain(
      "Use the architecture terms in this document exactly: **Module**, **Interface**, **Implementation**, **Depth**, **Seam**, **Adapter**, **Leverage**, **Locality**."
    );
    expect(message).toContain(
      "Avoid substitute terms such as component, service, API, or boundary when describing architecture."
    );
    expect(message).toContain(
      "Each interface-design agent must use the strict architecture terms"
    );

    for (const term of terms) {
      expect(message).toContain(`**${term}**`);
    }
  });

  it("sends /simplify immediately when idle", async () => {
    const runtime = createMockPiRuntime();
    const { ctx, notifications } = createMockCtx();

    codeImprovementExtension(runtime.pi as never);
    const command = getRegisteredCommand(runtime.commands, "simplify");

    await command?.handler("focus here", ctx as never);

    expect(runtime.sentUserMessages).toEqual([
      {
        content: buildSimplifyCommandMessage("focus here"),
        options: undefined,
      },
    ]);
    expect(notifications).toEqual([]);
  });

  it("sends /improve-codebase-architecture immediately when idle", async () => {
    const runtime = createMockPiRuntime();
    const { ctx, notifications } = createMockCtx();

    codeImprovementExtension(runtime.pi as never);
    const command = getRegisteredCommand(
      runtime.commands,
      "improve-codebase-architecture"
    );

    await command?.handler("src/domain", ctx as never);

    expect(runtime.sentUserMessages).toEqual([
      {
        content: buildImproveCodebaseArchitectureCommandMessage("src/domain"),
        options: undefined,
      },
    ]);
    expect(notifications).toEqual([]);
  });

  it("queues /simplify as a follow-up when busy and notifies", async () => {
    const runtime = createMockPiRuntime();
    const { ctx, notifications } = createMockCtx(false);

    codeImprovementExtension(runtime.pi as never);
    const command = getRegisteredCommand(runtime.commands, "simplify");

    await command?.handler("src/domain", ctx as never);

    expect(runtime.sentUserMessages).toEqual([
      {
        content: buildSimplifyCommandMessage("src/domain"),
        options: { deliverAs: "followUp" },
      },
    ]);
    expect(notifications).toContainEqual({
      message: "Queued /simplify as a follow-up",
      level: "info",
    });
  });

  it("queues /improve-codebase-architecture as a follow-up when busy and notifies", async () => {
    const runtime = createMockPiRuntime();
    const { ctx, notifications } = createMockCtx(false);

    codeImprovementExtension(runtime.pi as never);
    const command = getRegisteredCommand(
      runtime.commands,
      "improve-codebase-architecture"
    );

    await command?.handler("src/domain", ctx as never);

    expect(runtime.sentUserMessages).toEqual([
      {
        content: buildImproveCodebaseArchitectureCommandMessage("src/domain"),
        options: { deliverAs: "followUp" },
      },
    ]);
    expect(notifications).toContainEqual({
      message: "Queued /improve-codebase-architecture as a follow-up",
      level: "info",
    });
  });
});
