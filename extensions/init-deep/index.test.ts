import { describe, expect, it } from "bun:test";
import path from "node:path";

import {
  buildInitDeepMessage,
  default as initDeepExtension,
  getInitDeepArgumentCompletions,
} from "./index";

function createHarness() {
  const commands = new Map<
    string,
    {
      handler: (...args: any[]) => unknown;
      getArgumentCompletions?: (prefix: string) => unknown;
    }
  >();
  const sentUserMessages: Array<{ content: unknown; options?: unknown }> = [];

  const pi = {
    registerCommand(
      name: string,
      options: {
        handler: (...args: any[]) => unknown;
        getArgumentCompletions?: (prefix: string) => unknown;
      }
    ) {
      commands.set(name, options);
    },
    sendUserMessage(content: unknown, options?: unknown) {
      sentUserMessages.push({ content, options });
    },
  };

  const notifications: Array<{ message: string; level: string }> = [];
  const ctx = {
    isIdle: () => true,
    ui: {
      notify(message: string, level: string) {
        notifications.push({ message, level });
      },
    },
  };

  initDeepExtension(pi as never);

  return {
    command: commands.get("init-deep"),
    sentUserMessages,
    notifications,
    ctx,
  };
}

describe("init-deep command", () => {
  it("sends a normalized prompt immediately when idle", async () => {
    const harness = createHarness();

    expect(harness.command?.handler).toBeDefined();
    await harness.command?.handler(
      "./extensions --create-new --max-depth=2 -- focus on extension boundaries",
      harness.ctx as never
    );

    expect(harness.sentUserMessages).toHaveLength(1);
    expect(harness.sentUserMessages[0]?.options).toBeUndefined();
    expect(String(harness.sentUserMessages[0]?.content)).toContain(
      "Resolved command input:"
    );
    expect(String(harness.sentUserMessages[0]?.content)).toContain(
      `target root: ${path.join(process.cwd(), "extensions")}`
    );
    expect(String(harness.sentUserMessages[0]?.content)).toContain(
      "mode: create-new"
    );
    expect(String(harness.sentUserMessages[0]?.content)).toContain(
      "max depth: 2"
    );
    expect(String(harness.sentUserMessages[0]?.content)).toContain(
      "instruction: focus on extension boundaries"
    );
    expect(harness.notifications).toEqual([]);
  });

  it("queues a follow-up prompt when the agent is busy", async () => {
    const harness = createHarness();

    await harness.command?.handler("./extensions", {
      ...harness.ctx,
      isIdle: () => false,
    } as never);

    expect(harness.sentUserMessages).toHaveLength(1);
    expect(harness.sentUserMessages[0]?.options).toEqual({
      deliverAs: "followUp",
    });
    expect(harness.notifications).toEqual([
      {
        message: "Queued /init-deep as a follow-up",
        level: "info",
      },
    ]);
  });

  it("warns and does not send a message for invalid input", async () => {
    const harness = createHarness();

    await harness.command?.handler("./extensions extra", harness.ctx as never);

    expect(harness.sentUserMessages).toEqual([]);
    expect(harness.notifications).toEqual([
      {
        message:
          "Ambiguous arguments. Use '/init-deep <target> -- <instruction>' to pass freeform instructions.",
        level: "warning",
      },
    ]);
  });
});

describe("init-deep prompt builder", () => {
  it("builds a normalized command prelude", () => {
    const message = buildInitDeepMessage({
      targetRoot: path.join(process.cwd(), "extensions"),
      targetLabel: "./extensions",
      instruction: null,
      createNew: false,
      maxDepth: 3,
      dryRun: true,
    });

    expect(message).toContain(
      "instruction: default hierarchical AGENTS.md generation for the target codebase"
    );
    expect(message).toContain("dry run: true");
    expect(message).toContain("Use TaskCreate and TaskUpdate for phase tracking.");
  });
});

describe("init-deep completions", () => {
  const cwd = process.cwd();

  it("registers argument completions on the command", () => {
    const harness = createHarness();

    expect(harness.command?.getArgumentCompletions).toBeFunction();
  });

  it("suggests flags and target paths at the root", () => {
    const completions = getInitDeepArgumentCompletions("", cwd);

    expect(completions).not.toBeNull();
    expect(completions).toContainEqual(
      expect.objectContaining({ value: "--create-new", label: "--create-new" })
    );
    expect(completions).toContainEqual(
      expect.objectContaining({ value: "extensions/", label: "extensions/" })
    );
  });

  it("filters flag suggestions by prefix", () => {
    const completions = getInitDeepArgumentCompletions("--m", cwd);

    expect(completions).toEqual([
      {
        value: "--max-depth ",
        label: "--max-depth",
        description: "Limit nested AGENTS.md generation depth",
      },
    ]);
  });

  it("suggests target path matches for the current token", () => {
    const completions = getInitDeepArgumentCompletions("./ext", cwd);

    expect(completions).toEqual([
      {
        value: "./extensions/",
        label: "./extensions/",
        description: "directory",
      },
    ]);
  });

  it("suggests only flags after a target is already present", () => {
    const completions = getInitDeepArgumentCompletions("./extensions ", cwd);

    expect(completions).toContainEqual(
      expect.objectContaining({ value: "--dry-run", label: "--dry-run" })
    );
    expect(completions).not.toContainEqual(
      expect.objectContaining({ value: "extensions/", label: "extensions/" })
    );
  });

  it("suggests depth values after --max-depth", () => {
    const completions = getInitDeepArgumentCompletions("--max-depth ", cwd);

    expect(completions).toContainEqual({
      value: "3",
      label: "3",
      description: "max depth 3",
    });
  });

  it("stops suggesting once freeform instruction text begins", () => {
    const completions = getInitDeepArgumentCompletions(
      "./extensions -- focus on command boundaries",
      cwd
    );

    expect(completions).toBeNull();
  });
});
