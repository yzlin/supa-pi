import { describe, expect, it } from "bun:test";

import reviewExtension from "./review";

type SessionEntry = {
  type: string;
  message?: {
    role: string;
    content: string | Array<{ type?: string; text?: string }>;
  };
};

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
  options: { idle?: boolean } = {}
) {
  const notifications: Array<{ message: string; level: string }> = [];

  return {
    notifications,
    ctx: {
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
      },
    },
  };
}

function createMockPiRuntime() {
  const commands = new Map<
    string,
    {
      handler: (args: string, ctx: unknown) => Promise<void> | void;
    }
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
      on() {},
      appendEntry() {},
      sendUserMessage(content: string, options?: unknown) {
        sentUserMessages.push({ content, options });
      },
    },
  };
}

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
