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

const EMPTY_SUMMARY_REVIEW_REPORT = `## Review Scope
- current branch

## Verdict
- code looks good

## Findings
- none

## Fix Queue
- empty

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
      if (args.join(" ") === "status --porcelain --untracked-files=all") {
        return {
          stdout: " M extensions/review/index.ts\n?? docs/review.md\n",
          code: 0,
        };
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
      "Use the `review-orchestration` skill behavior as canonical."
    );
    expect(message).toContain("Review invocation packet:");
    expect(message).toContain(
      "- Changed paths:\n  - extensions/review/index.ts\n  - docs/review.md"
    );
    expect(message).toContain("git status --porcelain --untracked-files=all");
    expect(message).toContain("git diff --cached");
    expect(message).toContain("git diff");
    expect(message).toContain("read untracked paths directly");
    expect(message).not.toContain(
      "Do not emit the final report while any review task is pending or in_progress."
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

    const message = String(runtime.sentUserMessages[0]?.content);
    expect(message).toContain("Run `git diff abc123`");
    expect(message).toContain("- Changed paths:\n  - supabase/schema.sql");
    expect(message).toContain("git diff abc123");
    expect(message).toContain("git log abc123..HEAD --oneline");
    expect(message).toContain("- database-reviewer");
  });

  it("includes commit preflight metadata in direct commit targets", async () => {
    const runtime = createMockPiRuntime((_command, args) => {
      if (args.join(" ") === "rev-parse def456^{commit}") {
        return { stdout: "def456\n", code: 0 };
      }
      if (
        args.join(" ") ===
        "diff-tree --root --no-commit-id --name-only -r def456"
      ) {
        return { stdout: "src/commit.ts\n", code: 0 };
      }
      return { stdout: "", code: 0 };
    });
    const { ctx } = createMockCtx();

    reviewExtension(runtime.pi as never);
    const handler = runtime.commands.get("review")?.handler;

    expect(handler).toBeDefined();
    await handler?.(
      "commit def456 Fix metadata --reviewers code-reviewer",
      ctx as never
    );

    const message = String(runtime.sentUserMessages[0]?.content);
    expect(message).toContain('commit def456 ("Fix metadata")');
    expect(message).toContain("- Changed paths:\n  - src/commit.ts");
    expect(message).toContain("git show --stat --patch --find-renames def456");
  });

  it("includes pull request preflight metadata when direct PR review succeeds", async () => {
    const runtime = createMockPiRuntime((command, args) => {
      if (command === "gh" && args.join(" ") === "--version") {
        return { stdout: "gh version 2.0.0\n", code: 0 };
      }
      if (command === "gh" && args.join(" ") === "auth status") {
        return { stdout: "Logged in\n", code: 0 };
      }
      if (
        command === "gh" &&
        args.join(" ") === "pr view 42 --json baseRefName,title,headRefName"
      ) {
        return {
          stdout: JSON.stringify({
            baseRefName: "main",
            title: "Add review metadata",
            headRefName: "feature/review-metadata",
          }),
          code: 0,
        };
      }
      if (command === "gh" && args.join(" ") === "pr checkout 42") {
        return { stdout: "checked out\n", code: 0 };
      }
      if (command === "git" && args.join(" ") === "status --porcelain") {
        return { stdout: "", code: 0 };
      }
      if (
        command === "git" &&
        args.join(" ") === "rev-parse --abbrev-ref main@{upstream}"
      ) {
        return { stdout: "origin/main\n", code: 0 };
      }
      if (
        command === "git" &&
        args.join(" ") === "merge-base HEAD origin/main"
      ) {
        return { stdout: "base789\n", code: 0 };
      }
      if (command === "git" && args.join(" ") === "diff --name-only base789") {
        return { stdout: "extensions/review/index.ts\n", code: 0 };
      }
      if (
        command === "git" &&
        args.join(" ") === "log base789..HEAD --oneline"
      ) {
        return { stdout: "abc123 Add review metadata\n", code: 0 };
      }
      return { stdout: "", code: 0 };
    });
    const { ctx } = createMockCtx();

    reviewExtension(runtime.pi as never);
    const handler = runtime.commands.get("review")?.handler;

    expect(handler).toBeDefined();
    await handler?.("pr 42 --auto-reviewers", ctx as never);

    const message = String(runtime.sentUserMessages[0]?.content);
    expect(message).toContain(
      'Review pull request #42 ("Add review metadata")'
    );
    expect(message).toContain("- Changed paths:\n  - extensions/review/index.ts");
    expect(message).toContain("git diff base789");
    expect(message).toContain("git log base789..HEAD --oneline");
    expect(message).toContain("- Commit list:\n  - abc123 Add review metadata");
  });

  it("accepts the performance reviewer in direct reviewer flags", async () => {
    const runtime = createMockPiRuntime((_command, args) => {
      if (args.join(" ") === "status --porcelain --untracked-files=all") {
        return { stdout: " M src/perf.ts\n", code: 0 };
      }
      return { stdout: "", code: 0 };
    });
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
    expect(message).toContain("- Selected reviewers:\n  - performance-reviewer");
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

  it("fails fast before sending when changed paths are empty", async () => {
    const runtime = createMockPiRuntime((_command, args) => {
      if (args.join(" ") === "status --porcelain --untracked-files=all") {
        return { stdout: "", code: 0 };
      }
      return { stdout: "", code: 0 };
    });
    const { ctx, notifications } = createMockCtx();

    reviewExtension(runtime.pi as never);
    const handler = runtime.commands.get("review")?.handler;

    expect(handler).toBeDefined();
    await handler?.("uncommitted --reviewers code-reviewer", ctx as never);

    expect(runtime.sentUserMessages).toEqual([]);
    expect(notifications).toContainEqual({
      message: "No changed paths found for review target",
      level: "error",
    });
  });

  it("reports git failures before sending when changed paths cannot be resolved", async () => {
    const runtime = createMockPiRuntime((_command, args) => {
      if (args.join(" ") === "status --porcelain --untracked-files=all") {
        return { stdout: "fatal: not a git repository\n", code: 128 };
      }
      return { stdout: "", code: 0 };
    });
    const { ctx, notifications } = createMockCtx();

    reviewExtension(runtime.pi as never);
    const handler = runtime.commands.get("review")?.handler;

    expect(handler).toBeDefined();
    await handler?.("uncommitted --reviewers code-reviewer", ctx as never);

    expect(runtime.sentUserMessages).toEqual([]);
    expect(notifications).toContainEqual({
      message:
        "Could not resolve changed paths: git status --porcelain --untracked-files=all",
      level: "error",
    });
  });

  it("fails fast before sending when branch merge base is missing", async () => {
    const runtime = createMockPiRuntime((_command, args) => {
      if (args.join(" ") === "rev-parse --abbrev-ref missing@{upstream}") {
        return { stdout: "", code: 1 };
      }
      if (args.join(" ") === "merge-base HEAD missing") {
        return { stdout: "", code: 1 };
      }
      return { stdout: "", code: 0 };
    });
    const { ctx, notifications } = createMockCtx();

    reviewExtension(runtime.pi as never);
    const handler = runtime.commands.get("review")?.handler;

    expect(handler).toBeDefined();
    await handler?.("branch missing --reviewers code-reviewer", ctx as never);

    expect(runtime.sentUserMessages).toEqual([]);
    expect(notifications).toContainEqual({
      message: "Could not resolve merge base for 'missing'",
      level: "error",
    });
  });

  it("fails fast before sending when PR merge base is missing", async () => {
    const runtime = createMockPiRuntime((command, args) => {
      if (command === "gh" && args.join(" ") === "--version") {
        return { stdout: "gh version 2.0.0\n", code: 0 };
      }
      if (command === "gh" && args.join(" ") === "auth status") {
        return { stdout: "Logged in\n", code: 0 };
      }
      if (
        command === "gh" &&
        args.join(" ") === "pr view 43 --json baseRefName,title,headRefName"
      ) {
        return {
          stdout: JSON.stringify({
            baseRefName: "missing",
            title: "Broken base",
            headRefName: "feature/broken-base",
          }),
          code: 0,
        };
      }
      if (command === "gh" && args.join(" ") === "pr checkout 43") {
        return { stdout: "checked out\n", code: 0 };
      }
      if (command === "git" && args.join(" ") === "status --porcelain") {
        return { stdout: "", code: 0 };
      }
      if (
        command === "git" &&
        args.join(" ") === "rev-parse --abbrev-ref missing@{upstream}"
      ) {
        return { stdout: "", code: 1 };
      }
      if (command === "git" && args.join(" ") === "merge-base HEAD missing") {
        return { stdout: "", code: 1 };
      }
      return { stdout: "", code: 0 };
    });
    const { ctx, notifications } = createMockCtx();

    reviewExtension(runtime.pi as never);
    const handler = runtime.commands.get("review")?.handler;

    expect(handler).toBeDefined();
    await handler?.("pr 43 --reviewers code-reviewer", ctx as never);

    expect(runtime.sentUserMessages).toEqual([]);
    expect(notifications).toContainEqual({
      message: "Could not resolve merge base for 'missing'",
      level: "error",
    });
  });

  it("fails fast before sending when commit is invalid", async () => {
    const runtime = createMockPiRuntime((_command, args) => {
      if (args.join(" ") === "rev-parse badsha^{commit}") {
        return { stdout: "", code: 1 };
      }
      return { stdout: "", code: 0 };
    });
    const { ctx, notifications } = createMockCtx();

    reviewExtension(runtime.pi as never);
    const handler = runtime.commands.get("review")?.handler;

    expect(handler).toBeDefined();
    await handler?.("commit badsha --reviewers code-reviewer", ctx as never);

    expect(runtime.sentUserMessages).toEqual([]);
    expect(notifications).toContainEqual({
      message: "Invalid commit 'badsha'",
      level: "error",
    });
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
    const message = String(runtime.sentUserMessages[0]?.content);

    for (const expectedText of [
      "Use the `review-fix` skill behavior as canonical.",
      "Review-fix invocation packet:",
      "Source: latest review summary/Fix Queue when present; otherwise latest raw review report fallback.",
      "SUMMARY finding",
      "<untrusted_review_report>",
      "</untrusted_review_report>",
    ]) {
      expect(message).toContain(expectedText);
    }

    for (const forbiddenText of ["<review_report>", "</review_report>"]) {
      expect(message).not.toContain(forbiddenText);
    }
  });

  it("falls back to the latest raw report for /review-fix when no summary exists", async () => {
    const runtime = createMockPiRuntime();
    const { ctx } = createMockCtx([
      {
        type: "message",
        message: { role: "assistant", content: RAW_REVIEW_REPORT },
      },
    ]);

    reviewExtension(runtime.pi as never);
    const handler = runtime.commands.get("review-fix")?.handler;

    expect(handler).toBeDefined();
    await handler?.("", ctx as never);

    const message = String(runtime.sentUserMessages[0]?.content);
    expect(message).toContain("RAW finding");
    expect(message).toContain(
      "Source: latest review summary/Fix Queue when present; otherwise latest raw review report fallback."
    );
  });

  it("instructs /review-fix not to call executor for empty findings", async () => {
    const runtime = createMockPiRuntime();
    const { ctx } = createMockCtx([
      {
        type: "message",
        message: { role: "assistant", content: EMPTY_SUMMARY_REVIEW_REPORT },
      },
    ]);

    reviewExtension(runtime.pi as never);
    const handler = runtime.commands.get("review-fix")?.handler;

    expect(handler).toBeDefined();
    await handler?.("", ctx as never);

    const message = String(runtime.sentUserMessages[0]?.content);
    expect(message).toContain(
      "Use the `review-fix` skill behavior as canonical."
    );
    expect(message).toContain("code looks good");
  });

  it("keeps /review-fix extra instructions subordinate to delegation rules", async () => {
    const runtime = createMockPiRuntime();
    const { ctx } = createMockCtx([
      {
        type: "message",
        message: { role: "assistant", content: SUMMARY_REVIEW_REPORT },
      },
    ]);

    reviewExtension(runtime.pi as never);
    const handler = runtime.commands.get("review-fix")?.handler;

    expect(handler).toBeDefined();
    await handler?.("only run unit tests", ctx as never);

    const message = String(runtime.sentUserMessages[0]?.content);
    expect(message).toContain(
      "Use the `review-fix` skill behavior as canonical."
    );
    expect(message).toContain("- Additional instruction:\nonly run unit tests");
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
