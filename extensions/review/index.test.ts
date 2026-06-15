import { describe, expect, it } from "bun:test";

import reviewExtension from "./index";

interface SessionEntry {
  type: string;
  message?: {
    role: string;
    content: string | Array<{ type?: string; text?: string }>;
  };
}

const RAW_REVIEW_REPORT = `## Verdict
- needs attention

## Findings
- [P1] RAW finding

## Human Reviewer Callouts (Non-Blocking)
- (none)

## Reviewer Coverage
- code-reviewer: used / not used`;

const SUMMARY_REVIEW_REPORT = `## Review Scope
- current branch

## Verdict
- needs attention

## Findings
- [P1] SUMMARY finding

## Fix Queue
1. Fix it

## Human Reviewer Callouts (Non-Blocking)
- (none)

## Reviewer Coverage
- code-reviewer: used / not used`;

function createMockCtx(
  branchEntries: SessionEntry[] = [],
  options: {
    idle?: boolean;
    hasUI?: boolean;
    select?: (message: string, items: string[]) => Promise<string | null>;
    editor?: (message: string, value: string) => Promise<string | null>;
    custom?: <T>(renderer: unknown) => Promise<T>;
    cwd?: string;
  } = {}
) {
  const notifications: Array<{ message: string; level: string }> = [];

  return {
    notifications,
    ctx: {
      cwd: options.cwd ?? process.cwd(),
      hasUI: options.hasUI ?? true,
      isIdle: () => options.idle ?? true,
      sessionManager: {
        getBranch() {
          return branchEntries;
        },
        getEntries() {
          return branchEntries;
        },
      },
      ui: {
        notify(message: string, level: string) {
          notifications.push({ message, level });
        },
        select: options.select,
        editor: options.editor,
        custom: options.custom,
      },
    },
  };
}

function createMockPiRuntime(
  exec?: (
    command: string,
    args: string[]
  ) =>
    | { stdout: string; code: number; stderr?: string }
    | Promise<{ stdout: string; code: number; stderr?: string }>
) {
  const commands = new Map<
    string,
    {
      handler: (args: string, ctx: unknown) => Promise<void> | void;
    }
  >();
  const sentUserMessages: Array<{ content: string; options?: unknown }> = [];
  const execCalls: Array<{ command: string; args: string[] }> = [];

  return {
    commands,
    sentUserMessages,
    execCalls,
    pi: {
      async exec(command: string, args: string[]) {
        execCalls.push({ command, args });
        return (
          (await exec?.(command, args)) ?? { stdout: "", stderr: "", code: 0 }
        );
      },
      registerCommand(
        name: string,
        definition: {
          handler: (args: string, ctx: unknown) => Promise<void> | void;
        }
      ) {
        commands.set(name, definition);
      },
      on() {
        /* noop */
      },
      appendEntry() {
        /* noop */
      },
      sendUserMessage(content: string, options?: unknown) {
        sentUserMessages.push({ content, options });
      },
    },
  };
}

describe("review direct targets", () => {
  it("reviews uncommitted changes from direct args without opening selector", async () => {
    const runtime = createMockPiRuntime((_command, args) => {
      if (args.join(" ") === "status --porcelain") {
        return { stdout: " M extensions/review/index.ts\n", code: 0 };
      }
      return { stdout: "", code: 0 };
    });
    const { ctx, notifications } = createMockCtx([], {
      select: () =>
        Promise.reject(
          new Error("selector should not open for direct --auto-reviewers")
        ),
    });

    reviewExtension(runtime.pi as never);
    const handler = runtime.commands.get("review")?.handler;

    expect(handler).toBeDefined();
    await handler?.("uncommitted --auto-reviewers", ctx as never);

    expect(runtime.sentUserMessages).toHaveLength(1);
    const message = String(runtime.sentUserMessages[0]?.content);
    expect(message).toContain("Review the current code changes");
    expect(message).toContain(
      "When delegating via the Agent tool, omit `max_turns` from reviewer Agent calls."
    );
    expect(notifications).toContainEqual({
      message: "Starting review: current changes [code-reviewer]",
      level: "info",
    });
  });

  it("rejects invalid direct reviewer flags", async () => {
    const runtime = createMockPiRuntime((_command, args) => {
      if (args.join(" ") === "rev-parse --git-dir") {
        return { stdout: ".git\n", code: 0 };
      }
      return { stdout: "", code: 0 };
    });
    const { ctx, notifications } = createMockCtx();

    reviewExtension(runtime.pi as never);
    const handler = runtime.commands.get("review")?.handler;

    expect(handler).toBeDefined();
    await handler?.("uncommitted --reviewers security-reviewr", ctx as never);

    expect(runtime.sentUserMessages).toEqual([]);
    expect(notifications).toContainEqual({
      message: "No valid reviewers in --reviewers",
      level: "error",
    });
  });

  it("preserves direct branch targets and merge-base prompts", async () => {
    const runtime = createMockPiRuntime((_command, args) => {
      if (args.join(" ") === "rev-parse --abbrev-ref main@{upstream}") {
        return { stdout: "origin/main\n", code: 0 };
      }
      if (args.join(" ") === "merge-base HEAD origin/main") {
        return { stdout: "abc123\n", code: 0 };
      }
      if (args.join(" ") === "diff --name-only abc123") {
        return { stdout: "supabase/schema.sql\n", code: 0 };
      }
      return { stdout: "", code: 0 };
    });
    const { ctx } = createMockCtx();

    reviewExtension(runtime.pi as never);
    const handler = runtime.commands.get("review")?.handler;

    expect(handler).toBeDefined();
    await handler?.("branch main --auto-reviewers", ctx as never);

    expect(String(runtime.sentUserMessages[0]?.content)).toContain(
      "Run `git diff abc123`"
    );
    expect(String(runtime.sentUserMessages[0]?.content)).toContain(
      "- database-reviewer"
    );
  });

  it("accepts the performance reviewer in direct reviewer flags", async () => {
    const runtime = createMockPiRuntime();
    const { ctx, notifications } = createMockCtx();

    reviewExtension(runtime.pi as never);
    const handler = runtime.commands.get("review")?.handler;

    expect(handler).toBeDefined();
    await handler?.(
      "uncommitted --reviewers performance-reviewer",
      ctx as never
    );

    const message = String(runtime.sentUserMessages[0]?.content);
    expect(message).toContain("- performance-reviewer");
    expect(message).toContain(
      "`performance-reviewer`: latency, throughput, memory, bundle size, rendering, and scalability regressions"
    );
    expect(message).toContain(
      "Source reviewer (`code-reviewer`, `security-reviewer`, `database-reviewer`, or `performance-reviewer`)"
    );
    expect(message).toContain("- performance-reviewer: used / not used");
    expect(notifications).toContainEqual({
      message: "Starting review: current changes [performance-reviewer]",
      level: "info",
    });
  });

  it("auto-selects the performance reviewer for performance-sensitive paths", async () => {
    const runtime = createMockPiRuntime((_command, args) => {
      if (args.join(" ") === "status --porcelain --untracked-files=all") {
        return { stdout: " M benchmarks/render.bench.ts\n", code: 0 };
      }
      return { stdout: "", code: 0 };
    });
    const { ctx } = createMockCtx();

    reviewExtension(runtime.pi as never);
    const handler = runtime.commands.get("review")?.handler;

    expect(handler).toBeDefined();
    await handler?.("uncommitted --auto-reviewers", ctx as never);

    expect(String(runtime.sentUserMessages[0]?.content)).toContain(
      "- performance-reviewer"
    );
  });

  it("preserves direct folder targets and extra instructions", async () => {
    const runtime = createMockPiRuntime();
    const { ctx } = createMockCtx();

    reviewExtension(runtime.pi as never);
    const handler = runtime.commands.get("review")?.handler;

    expect(handler).toBeDefined();
    await handler?.(
      'folder src "docs guides" --auto-reviewers --extra "check public API"',
      ctx as never
    );

    const message = String(runtime.sentUserMessages[0]?.content);
    expect(message).toContain(
      "Review the code in the following paths: src, docs guides"
    );
    expect(message).toContain("check public API");
  });

  it("keeps the default folder target as cwd instead of parent", async () => {
    const runtime = createMockPiRuntime();
    const { ctx } = createMockCtx([], {
      custom: async () => "folder" as never,
      editor: async (_message, value) => value,
    });

    reviewExtension(runtime.pi as never);
    const handler = runtime.commands.get("review")?.handler;

    expect(handler).toBeDefined();
    await handler?.("--auto-reviewers", ctx as never);

    const message = String(runtime.sentUserMessages[0]?.content);
    expect(message).toContain("Review the code in the following paths: .\n");
    expect(message).not.toContain("Review the code in the following paths: ..");
  });
});

describe("review follow-up helpers", () => {
  it("warns when /review-summary cannot find a review report", async () => {
    const runtime = createMockPiRuntime();
    const { ctx, notifications } = createMockCtx();

    reviewExtension(runtime.pi as never);
    const handler = runtime.commands.get("review-summary")?.handler;

    expect(handler).toBeDefined();
    await handler?.("", ctx as never);

    expect(runtime.sentUserMessages).toEqual([]);
    expect(notifications).toContainEqual({
      message: "No review report found in this session. Run /review first.",
      level: "warning",
    });
  });

  it("uses the latest raw review report for /review-summary", async () => {
    const runtime = createMockPiRuntime();
    const { ctx } = createMockCtx([
      {
        type: "message",
        message: { role: "assistant", content: RAW_REVIEW_REPORT },
      },
      {
        type: "message",
        message: { role: "assistant", content: SUMMARY_REVIEW_REPORT },
      },
    ]);

    reviewExtension(runtime.pi as never);
    const handler = runtime.commands.get("review-summary")?.handler;

    expect(handler).toBeDefined();
    await handler?.("keep it brief", ctx as never);

    expect(runtime.sentUserMessages).toHaveLength(1);
    expect(String(runtime.sentUserMessages[0]?.content)).toContain(
      "RAW finding"
    );
    expect(String(runtime.sentUserMessages[0]?.content)).not.toContain(
      "SUMMARY finding"
    );
    expect(String(runtime.sentUserMessages[0]?.content)).toContain(
      "Additional instruction:\nkeep it brief"
    );
  });

  it("prefers the latest summary report for /review-fix", async () => {
    const runtime = createMockPiRuntime();
    const { ctx } = createMockCtx([
      {
        type: "message",
        message: { role: "assistant", content: RAW_REVIEW_REPORT },
      },
      {
        type: "message",
        message: {
          role: "assistant",
          content: "some unrelated assistant note",
        },
      },
      {
        type: "message",
        message: { role: "assistant", content: SUMMARY_REVIEW_REPORT },
      },
    ]);

    reviewExtension(runtime.pi as never);
    const handler = runtime.commands.get("review-fix")?.handler;

    expect(handler).toBeDefined();
    await handler?.("", ctx as never);

    expect(runtime.sentUserMessages).toHaveLength(1);
    expect(String(runtime.sentUserMessages[0]?.content)).toContain(
      "SUMMARY finding"
    );
  });

  it("queues /review-fix as a follow-up when busy", async () => {
    const runtime = createMockPiRuntime();
    const { ctx, notifications } = createMockCtx(
      [
        {
          type: "message",
          message: { role: "assistant", content: SUMMARY_REVIEW_REPORT },
        },
      ],
      { idle: false }
    );

    reviewExtension(runtime.pi as never);
    const handler = runtime.commands.get("review-fix")?.handler;

    expect(handler).toBeDefined();
    await handler?.("", ctx as never);

    expect(runtime.sentUserMessages).toEqual([
      {
        content: expect.stringContaining("SUMMARY finding"),
        options: { deliverAs: "followUp" },
      },
    ]);
    expect(notifications).toContainEqual({
      message: "Queued /review-fix as a follow-up",
      level: "info",
    });
  });
});
