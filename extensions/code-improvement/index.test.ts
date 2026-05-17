import { describe, expect, it } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";

import codeImprovementExtension, {
  buildImproveCodebaseArchitectureCommandMessage,
  buildScopedSimplifyCommandMessage,
  buildSimplifyCommandMessage,
} from "./index";

function createMockCtx(
  isIdle = true,
  options: {
    hasUI?: boolean;
    confirm?: boolean;
    select?: string;
    editor?: string;
  } = {}
) {
  const notifications: Array<{ message: string; level: string }> = [];
  const confirmations: Array<{ title: string; message?: string }> = [];

  return {
    notifications,
    confirmations,
    ctx: {
      hasUI: options.hasUI ?? false,
      isIdle: () => isIdle,
      ui: {
        notify(message: string, level: string) {
          notifications.push({ message, level });
        },
        confirm: (title: string, message?: string) => {
          confirmations.push({ title, message });
          return Promise.resolve(options.confirm ?? true);
        },
        select: async () => options.select,
        editor: async () => options.editor ?? "",
      },
    },
  };
}

function createMockPiRuntime(
  exec: (
    command: string,
    args: string[]
  ) =>
    | Promise<{
        stdout: string;
        stderr?: string;
        code: number;
      }>
    | {
        stdout: string;
        stderr?: string;
        code: number;
      } = () => ({ stdout: "", code: 0 })
) {
  const commands = new Map<
    string,
    { handler: (args: string, ctx: unknown) => Promise<void> | void }
  >();
  const sentUserMessages: Array<{ content: string; options?: unknown }> = [];

  return {
    commands,
    sentUserMessages,
    pi: {
      exec,
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
    expect(buildSimplifyCommandMessage("   ")).toContain(
      "Do not set `max_turns` on the `code-simplifier` Agent call"
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

  it("keeps bare no-UI /simplify legacy recent-session fallback", async () => {
    const runtime = createMockPiRuntime();
    const { ctx, notifications } = createMockCtx();

    codeImprovementExtension(runtime.pi as never);
    const command = getRegisteredCommand(runtime.commands, "simplify");

    await command?.handler("", ctx as never);

    expect(runtime.sentUserMessages).toEqual([
      {
        content: buildSimplifyCommandMessage(""),
        options: undefined,
      },
    ]);
    expect(notifications).toEqual([]);
  });

  it("opens a selector for bare interactive /simplify", async () => {
    const runtime = createMockPiRuntime((_command, args) => {
      if (args[0] === "status") {
        return { stdout: " M package.json\n", code: 0 };
      }
      return { stdout: "", code: 0 };
    });
    const { ctx } = createMockCtx(true, { hasUI: true, select: "uncommitted" });

    codeImprovementExtension(runtime.pi as never);
    const command = getRegisteredCommand(runtime.commands, "simplify");

    await command?.handler("", ctx as never);

    expect(runtime.sentUserMessages[0]?.content).toContain("- package.json");
  });

  it("rejects freeform /simplify focus under strict grammar", async () => {
    const runtime = createMockPiRuntime();
    const { ctx, notifications } = createMockCtx();

    codeImprovementExtension(runtime.pi as never);
    const command = getRegisteredCommand(runtime.commands, "simplify");

    await command?.handler("focus here", ctx as never);

    expect(runtime.sentUserMessages).toEqual([]);
    expect(notifications[0]?.message).toContain("Usage: /simplify");
  });

  it("requires --yes for large no-UI /simplify scopes", async () => {
    const files = [
      "extensions/research/index.test.ts",
      "extensions/research/prompt.md",
      "extensions/research/index.ts",
      "extensions/btw/helper.test.ts",
      "extensions/btw/helper.ts",
      "extensions/btw/subagent.test.ts",
      "extensions/btw/index.ts",
      "extensions/btw/subagent.ts",
      "extensions/ast-grep/prompt.md",
      "extensions/ast-grep/index.ts",
      "extensions/context/analyze.ts",
      "extensions/context/content.test.ts",
      "extensions/context/analyze.test.ts",
      "extensions/context/content-view.ts",
      "extensions/context/content.ts",
      "extensions/context/view.ts",
      "extensions/context/render-text.ts",
      "extensions/context/index.ts",
      "extensions/core-prompt/prompt.md",
      "extensions/core-prompt/index.ts",
      "extensions/init-deep/index.test.ts",
    ].join("\n");
    const runtime = createMockPiRuntime((_command, args) => {
      if (args[0] === "diff") {
        return { stdout: files, code: 0 };
      }
      if (args[0] === "merge-base") {
        return { stdout: "base", code: 0 };
      }
      return { stdout: "", code: 0 };
    });
    const { ctx, notifications } = createMockCtx();

    codeImprovementExtension(runtime.pi as never);
    const command = getRegisteredCommand(runtime.commands, "simplify");

    await command?.handler("branch main", ctx as never);

    expect(runtime.sentUserMessages).toEqual([]);
    expect(notifications).toContainEqual({
      message: "Large no-UI /simplify scopes require --yes",
      level: "error",
    });
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

  it("queues scoped /simplify as a follow-up when busy and notifies", async () => {
    const runtime = createMockPiRuntime((_command, args) => {
      if (args[0] === "status") {
        return { stdout: " M package.json\n?? ../unsafe.ts\n", code: 0 };
      }
      return { stdout: "", code: 0 };
    });
    const { ctx, notifications } = createMockCtx(false);

    codeImprovementExtension(runtime.pi as never);
    const command = getRegisteredCommand(runtime.commands, "simplify");

    await command?.handler(
      'uncommitted --extra "prefer smaller functions" --yes',
      ctx as never
    );

    expect(runtime.sentUserMessages).toHaveLength(1);
    expect(runtime.sentUserMessages[0]?.options).toEqual({
      deliverAs: "followUp",
    });
    expect(runtime.sentUserMessages[0]?.content).toContain(
      "Delegate to code-simplifier. Do not select reviewers."
    );
    expect(runtime.sentUserMessages[0]?.content).toContain("- package.json");
    expect(runtime.sentUserMessages[0]?.content).toContain(
      "Unsupported changed files (1):\n- ../unsafe.ts"
    );
    expect(runtime.sentUserMessages[0]?.content).toContain(
      "Hard edit boundary: you may read files outside editable files for context, but only edit files in the editable files list above."
    );
    expect(runtime.sentUserMessages[0]?.content).toContain(
      "Extra guidance: prefer smaller functions"
    );
    expect(runtime.sentUserMessages[0]?.content).toContain(
      "Before delegating, re-resolve this scope and compare editable files only. Ignore lockfile drift. Stop if editable files changed. Stop if new unsupported non-lock files appeared"
    );
    expect(notifications).toContainEqual({
      message: "Queued /simplify as a follow-up",
      level: "info",
    });
  });

  it("states the scoped simplify three-section file contract", () => {
    const message = buildScopedSimplifyCommandMessage({
      targetLabel: "uncommitted changes",
      allowlist: ["package.json"],
      ignoredLockfiles: ["bun.lock"],
      unsupportedChangedFiles: ["image.png"],
    });

    expect(message).toContain("Editable files (1):\n- package.json");
    expect(message).toContain("Ignored lockfiles (read-only, 1):\n- bun.lock");
    expect(message).toContain("Unsupported changed files (1):\n- image.png");
    expect(message).toContain(
      "you may read files outside editable files for context, but only edit files in the editable files list above"
    );
    expect(message).toContain(
      "Do not edit ignored lockfiles or unsupported changed files. If needed edits fall outside editable files, stop and report the missing file path."
    );
  });

  it("filters scoped /simplify allowlists to safe existing text-like files", async () => {
    const runtime = createMockPiRuntime((_command, args) => {
      if (args[0] === "status") {
        return {
          stdout: [
            " M README.md",
            " M package.json",
            " M missing.ts",
            " M bun.lock",
            " M node_modules/blocked.ts",
            " M themes/nightowl.json",
            " M ../unsafe.ts",
          ].join("\n"),
          code: 0,
        };
      }
      return { stdout: "", code: 0 };
    });
    const { ctx } = createMockCtx();

    codeImprovementExtension(runtime.pi as never);
    const command = getRegisteredCommand(runtime.commands, "simplify");

    await command?.handler("uncommitted --yes", ctx as never);

    const content = runtime.sentUserMessages[0]?.content ?? "";
    expect(content).toContain("- README.md");
    expect(content).toContain("- package.json");
    expect(content).toContain("- themes/nightowl.json");
    expect(content).toContain("Ignored lockfiles (read-only, 1):\n- bun.lock");
    expect(content).toContain("Unsupported changed files (3):");
    expect(content).toContain("- missing.ts");
    expect(content).toContain("- node_modules/blocked.ts");
    expect(content).toContain("- ../unsafe.ts");
  });

  it("no-ops lockfile-only explicit folder simplify scope", async () => {
    const runtime = createMockPiRuntime();
    const { ctx, notifications } = createMockCtx();

    codeImprovementExtension(runtime.pi as never);
    const command = getRegisteredCommand(runtime.commands, "simplify");

    await command?.handler("folder bun.lock", ctx as never);

    expect(runtime.sentUserMessages).toEqual([]);
    expect(notifications).toContainEqual({
      message:
        "No editable files resolved for /simplify scope; ignored 1 lockfile(s).",
      level: "info",
    });
  });

  it("expands explicit folder simplify scope directories recursively", async () => {
    const runtime = createMockPiRuntime();
    const { ctx } = createMockCtx();

    codeImprovementExtension(runtime.pi as never);
    const command = getRegisteredCommand(runtime.commands, "simplify");

    await command?.handler(
      "folder extensions/code-improvement/__fixtures__/folder-scope --yes",
      ctx as never
    );

    const content = runtime.sentUserMessages[0]?.content ?? "";
    expect(content).toContain(
      "- extensions/code-improvement/__fixtures__/folder-scope/README.md"
    );
    expect(content).toContain(
      "Ignored lockfiles (read-only, 1):\n- extensions/code-improvement/__fixtures__/folder-scope/bun.lock"
    );
    expect(content).toContain(
      "- extensions/code-improvement/__fixtures__/folder-scope/src/good.ts"
    );
  });

  it("excludes unsafe, generated, vendor, build, and non-text files from expanded folder simplify scopes", async () => {
    const runtime = createMockPiRuntime();
    const { ctx } = createMockCtx();

    codeImprovementExtension(runtime.pi as never);
    const command = getRegisteredCommand(runtime.commands, "simplify");

    await command?.handler(
      "folder extensions/code-improvement/__fixtures__/folder-scope ../unsafe.ts node_modules --yes",
      ctx as never
    );

    const content = runtime.sentUserMessages[0]?.content ?? "";
    expect(content).toContain(
      "- extensions/code-improvement/__fixtures__/folder-scope/src/good.ts"
    );
    expect(content).not.toContain(
      "- extensions/code-improvement/__fixtures__/folder-scope/generated/ignored.ts"
    );
    expect(content).not.toContain(
      "- extensions/code-improvement/__fixtures__/folder-scope/node_modules/ignored.ts"
    );
    expect(content).not.toContain(
      "- extensions/code-improvement/__fixtures__/folder-scope/dist/ignored.ts"
    );
    expect(content).toContain("Unsupported changed files (3):");
    expect(content).toContain("- ../unsafe.ts");
    expect(content).toContain(
      "- extensions/code-improvement/__fixtures__/folder-scope/image.png"
    );
    expect(content).toContain("- node_modules");
  });

  it("stops no-UI folder /simplify with explicit unsafe paths unless --yes", async () => {
    const runtime = createMockPiRuntime();
    const { ctx, notifications } = createMockCtx();

    codeImprovementExtension(runtime.pi as never);
    const command = getRegisteredCommand(runtime.commands, "simplify");

    await command?.handler("folder package.json ../unsafe.ts", ctx as never);

    expect(runtime.sentUserMessages).toEqual([]);
    expect(notifications).toContainEqual({
      message:
        "Unsupported changed files in no-UI /simplify scope require --yes",
      level: "error",
    });
  });

  it("continues after UI confirmation for unsupported non-lock files", async () => {
    const runtime = createMockPiRuntime((_command, args) => {
      if (args[0] === "status") {
        return { stdout: " M package.json\n M image.png\n", code: 0 };
      }
      return { stdout: "", code: 0 };
    });
    const { ctx, confirmations } = createMockCtx(true, {
      hasUI: true,
      confirm: true,
    });

    codeImprovementExtension(runtime.pi as never);
    const command = getRegisteredCommand(runtime.commands, "simplify");

    await command?.handler("uncommitted", ctx as never);

    expect(confirmations).toEqual([
      {
        title: "Unsupported changed files",
        message:
          "Continue with 1 unsupported changed files excluded from editable files?",
      },
    ]);
    expect(runtime.sentUserMessages).toHaveLength(1);
    expect(runtime.sentUserMessages[0]?.content).toContain(
      "Unsupported changed files (1):\n- image.png"
    );
  });

  it("stops no-UI scoped /simplify with unsupported non-lock files unless --yes", async () => {
    const runtime = createMockPiRuntime((_command, args) => {
      if (args[0] === "status") {
        return { stdout: " M package.json\n M image.png\n", code: 0 };
      }
      return { stdout: "", code: 0 };
    });
    const { ctx, notifications } = createMockCtx();

    codeImprovementExtension(runtime.pi as never);
    const command = getRegisteredCommand(runtime.commands, "simplify");

    await command?.handler("uncommitted", ctx as never);

    expect(runtime.sentUserMessages).toEqual([]);
    expect(notifications).toContainEqual({
      message:
        "Unsupported changed files in no-UI /simplify scope require --yes",
      level: "error",
    });
  });

  it("continues no-UI scoped /simplify with unsupported non-lock files when --yes", async () => {
    const runtime = createMockPiRuntime((_command, args) => {
      if (args[0] === "status") {
        return { stdout: " M package.json\n M image.png\n", code: 0 };
      }
      return { stdout: "", code: 0 };
    });
    const { ctx, notifications } = createMockCtx();

    codeImprovementExtension(runtime.pi as never);
    const command = getRegisteredCommand(runtime.commands, "simplify");

    await command?.handler("uncommitted --yes", ctx as never);

    expect(notifications).toEqual([]);
    expect(runtime.sentUserMessages).toHaveLength(1);
    expect(runtime.sentUserMessages[0]?.content).toContain(
      "Unsupported changed files (1):\n- image.png"
    );
  });

  it("proceeds for diff scopes that include ignored lockfiles", async () => {
    const runtime = createMockPiRuntime((_command, args) => {
      if (args[0] === "diff") {
        return { stdout: "package.json\nbun.lock\n", code: 0 };
      }
      if (args[0] === "merge-base") {
        return { stdout: "base", code: 0 };
      }
      return { stdout: "", code: 0 };
    });
    const { ctx, notifications } = createMockCtx();

    codeImprovementExtension(runtime.pi as never);
    const command = getRegisteredCommand(runtime.commands, "simplify");

    await command?.handler("branch main --yes", ctx as never);

    expect(notifications).toEqual([]);
    expect(runtime.sentUserMessages).toHaveLength(1);
    expect(runtime.sentUserMessages[0]?.content).toContain(
      "Editable files (1):\n- package.json"
    );
    expect(runtime.sentUserMessages[0]?.content).toContain(
      "Ignored lockfiles (read-only, 1):\n- bun.lock"
    );
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
