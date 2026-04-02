import { describe, expect, it } from "bun:test";
import path from "node:path";

import {
  getSmartDocsArgumentCompletions,
  default as smartDocsExtension,
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

  smartDocsExtension(pi as never);

  return {
    command: commands.get("smart-docs"),
    sentUserMessages,
    notifications,
    ctx,
  };
}

describe("smart-docs command", () => {
  it("sends a normalized prompt immediately when idle", async () => {
    const harness = createHarness();

    expect(harness.command?.handler).toBeDefined();
    await harness.command?.handler(
      "./extensions -- focus on command architecture",
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
      "instruction: focus on command architecture"
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
        message: "Queued /smart-docs as a follow-up",
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
          "Ambiguous arguments. Use '/smart-docs <target> -- <instruction>' to pass freeform instructions.",
        level: "warning",
      },
    ]);
  });
});

describe("smart-docs completions", () => {
  const cwd = process.cwd();

  it("registers argument completions on the command", () => {
    const harness = createHarness();

    expect(harness.command?.getArgumentCompletions).toBeFunction();
  });

  it("suggests flags and target paths at the root", () => {
    const completions = getSmartDocsArgumentCompletions("", cwd);

    expect(completions).not.toBeNull();
    expect(completions).toContainEqual(
      expect.objectContaining({ value: "--out ", label: "--out" })
    );
    expect(completions).toContainEqual(
      expect.objectContaining({ value: "extensions/", label: "extensions/" })
    );
  });

  it("filters flag suggestions by prefix", () => {
    const completions = getSmartDocsArgumentCompletions("--o", cwd);

    expect(completions).toEqual([
      {
        value: "--out ",
        label: "--out",
        description: "Write docs to a custom output directory",
      },
      {
        value: "--overview-only",
        label: "--overview-only",
        description: "Generate overview docs only",
      },
    ]);
  });

  it("suggests target path matches for the current token", () => {
    const completions = getSmartDocsArgumentCompletions("./ext", cwd);

    expect(completions).toEqual([
      {
        value: "./extensions/",
        label: "./extensions/",
        description: "directory",
      },
    ]);
  });

  it("suggests only flags after a target is already present", () => {
    const completions = getSmartDocsArgumentCompletions("./extensions ", cwd);

    expect(completions).toContainEqual(
      expect.objectContaining({ value: "--update", label: "--update" })
    );
    expect(completions).not.toContainEqual(
      expect.objectContaining({ value: "extensions/", label: "extensions/" })
    );
  });

  it("suggests output directory paths relative to the resolved target", () => {
    const completions = getSmartDocsArgumentCompletions(
      "./extensions --out s",
      cwd
    );

    expect(completions).toContainEqual(
      expect.objectContaining({ value: "smart-docs/", label: "smart-docs/" })
    );
  });

  it("stops suggesting once freeform instruction text begins", () => {
    const completions = getSmartDocsArgumentCompletions(
      "./extensions -- architecture",
      cwd
    );

    expect(completions).toBeNull();
  });
});
