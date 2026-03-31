import { mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "bun:test";
import initTasksExtension from "../../../pi-tasks/src/index";

import {
  buildExecuteLiveStatus,
  buildExecuteProgressWidgetLines,
  buildExecuteSummaryRenderText,
  buildExecuteWorkerTask,
  chooseWaveConcurrency,
  executePlan,
  parsePlanDocumentItems,
  startExecutePlan,
  parsePlanItems,
  parseWorkerResult,
  summarizeExecuteStructuredResult,
  type ExecuteSummaryDetails,
} from "./index";

describe("parsePlanItems", () => {
  it("parses numbered multiline plans", () => {
    expect(
      parsePlanItems(`1. inspect auth flow\n2. fix refresh token bug\n3. add regression test`)
    ).toEqual(["inspect auth flow", "fix refresh token bug", "add regression test"]);
  });

  it("parses bullet plans", () => {
    expect(parsePlanItems(`- inspect prompt\n- inspect agent`)).toEqual([
      "inspect prompt",
      "inspect agent",
    ]);
  });

  it("keeps a single-line plan as one item unless semicolon-separated", () => {
    expect(parsePlanItems("inspect auth flow")).toEqual(["inspect auth flow"]);
    expect(parsePlanItems("inspect auth flow; add test")).toEqual([
      "inspect auth flow",
      "add test",
    ]);
  });
});

describe("parsePlanDocumentItems", () => {
  it("extracts markdown list items and ignores prose", () => {
    expect(
      parsePlanDocumentItems(`# Plan\n\nIntro paragraph.\n\n- inspect auth flow\n- fix refresh token bug\n\nClosing note.`)
    ).toEqual(["inspect auth flow", "fix refresh token bug"]);
  });

  it("falls back to plain multiline plans when no markdown list exists", () => {
    expect(parsePlanDocumentItems(`inspect auth flow\nfix refresh token bug`)).toEqual([
      "inspect auth flow",
      "fix refresh token bug",
    ]);
  });
});

describe("chooseWaveConcurrency", () => {
  it("uses parallelism for read-only looking work", () => {
    expect(chooseWaveConcurrency(["inspect prompt", "summarize agent"])).toBe(2);
  });

  it("falls back to serial execution for risky work", () => {
    expect(chooseWaveConcurrency(["fix refresh token bug"])).toBe(1);
  });
});

describe("buildExecuteWorkerTask", () => {
  it("frames worker tasks without sounding like deferred step scheduling", () => {
    const task = buildExecuteWorkerTask("inspect agents/execute-step.md and summarize its role", 1, 2);

    expect(task).toContain("Assigned atomic repo task:");
    expect(task).toContain("inspect agents/execute-step.md and summarize its role");
    expect(task).toContain("Batch position: 2/2.");
    expect(task).toContain("Complete only this assigned task.");
    expect(task).not.toContain("Execute plan step 2/2");
  });
});

describe("buildExecuteLiveStatus", () => {
  it("renders thinking and tool activity updates compactly", () => {
    expect(
      buildExecuteLiveStatus(1, "inspect prompt", {
        type: "assistant_text",
        text: "Thinking through the task",
      }),
    ).toBe("Wave 1: inspect prompt — thinking…");

    expect(
      buildExecuteLiveStatus(2, "inspect prompt", {
        type: "tool_start",
        toolName: "read",
      }),
    ).toBe("Wave 2: inspect prompt — read…");

    expect(
      buildExecuteLiveStatus(2, "inspect prompt", {
        type: "tool_update",
        toolName: "read",
        text: "opened extensions/execute/index.ts",
      }),
    ).toContain("read: opened extensions/execute/index.ts");

    expect(
      buildExecuteLiveStatus(2, "inspect prompt", {
        type: "tool_end",
        toolName: "read",
        isError: true,
        text: "file not found",
      }),
    ).toContain("read error: file not found");

    expect(
      buildExecuteLiveStatus(2, "inspect prompt", {
        type: "tool_end",
        toolName: "read",
        isError: false,
      }),
    ).toBe("Wave 2: inspect prompt — read done");

    expect(
      buildExecuteLiveStatus(2, "inspect prompt", {
        type: "tool_end",
        toolName: "bash",
        isError: false,
        text: JSON.stringify({
          content: [
            {
              type: "text",
              text: "src/global.css --- CSS\n1 1 @import 'tailwindcss';",
            },
          ],
        }),
      }),
    ).toContain("bash done: src/global.css --- CSS 1 1 @import 'tailwindcss';");

    expect(
      buildExecuteLiveStatus(2, "inspect prompt", {
        type: "tool_update",
        toolName: "bash",
        text: JSON.stringify({ content: [] }),
      }),
    ).toBe("Wave 2: inspect prompt — bash");

    expect(
      buildExecuteLiveStatus(2, "inspect prompt", {
        type: "tool_end",
        toolName: "bash",
        isError: false,
        text: '{"content":[{"type":"text","text":"src/global.css --- CSS\\n1 1 @import',
      }),
    ).toContain("bash done: src/global.css --- CSS 1 1 @import");

    expect(
      buildExecuteLiveStatus(2, "inspect prompt", {
        type: "tool_end",
        toolName: "grep",
        isError: false,
        text: JSON.stringify({
          content: [
            {
              type: "text",
              text: "contexts/theme.tsx-25- UnistylesRuntime.setTheme(theme)",
            },
          ],
        }),
      }),
    ).toContain("grep done: contexts/theme.tsx-25- UnistylesRuntime.setTheme(theme)");
  });
});

describe("buildExecuteProgressWidgetLines", () => {
  it("shows wave progress, current status, and recent worker activity", () => {
    const lines = buildExecuteProgressWidgetLines(
      ["inspect prompt", "inspect agent"],
      "Wave 2: inspect prompt — read done: opened extensions/execute/index.ts",
      [
        { status: "Executing 2 plan item(s)..." },
        { status: "Wave 1: 2 item(s)" },
        { status: "Wave 1 complete — 2/2 done, 0 errors, 0 follow-ups" },
        { status: "Wave 2: 1 item(s)" },
        { status: "Wave 2: inspect prompt — thinking…" },
        { status: "Wave 2: inspect prompt — read done: opened extensions/execute/index.ts" },
      ],
      {
        completedItems: 2,
        blockedItems: 0,
        remainingItems: 1,
        waves: [
          {
            wave: 1,
            jobId: "job_1",
            totalItems: 2,
            completedItems: 2,
            errorCount: 0,
            queuedFollowUps: 0,
          },
        ],
        activeWave: {
          wave: 2,
          totalItems: 1,
          completedItems: 0,
          errorCount: 0,
          queuedFollowUps: 0,
          activeItem: "inspect prompt",
        },
      },
      false,
      {
        headline: "Wave 2: inspect prompt",
        blockLabel: "tool result",
        metadata: ["read", "ok"],
        detail: "opened extensions/execute/index.ts",
        tone: "success",
      }
    );

    expect(lines[0]).toBe("/execute");
    expect(lines[1]).toContain("2 items — inspect prompt");
    expect(lines).toContain("Overall [███████░░░]  2 done  0 blocked  1 remaining");
    expect(lines).toContain("Waves");
    expect(lines).toContain("• Wave 1  [██████████]  2/2 done  ok  no follow-ups");
    expect(lines).toContain("• Wave 2  [░░░░░░░░░░]  0/1 done  running  no follow-ups");
    expect(lines).toContain("  active: inspect prompt");
    expect(lines).toContain("Current");
    expect(lines).toContain("• Wave 2: inspect prompt");
    expect(lines).toContain("  [tool result] read · ok");
    expect(lines).toContain("  ↳ opened extensions/execute/index.ts");
    expect(lines).toContain("Recent");
    expect(lines).toContain("• Wave 2: inspect prompt — thinking…");
    expect(lines).not.toContain("• Wave 2: inspect prompt — read done: opened extensions/execute/index.ts");
  });

  it("does not offer expansion when the structured current entry has no detail", () => {
    const lines = buildExecuteProgressWidgetLines(
      ["inspect prompt"],
      "Wave 1: Add semantic colors — this old detail should not keep the expand hint alive",
      [{ status: "Wave 1: Add semantic colors — thinking…" }],
      {
        completedItems: 0,
        blockedItems: 0,
        remainingItems: 1,
        waves: [],
        activeWave: {
          wave: 1,
          totalItems: 1,
          completedItems: 0,
          errorCount: 0,
          queuedFollowUps: 0,
          activeItem: "Add semantic colors",
        },
      },
      false,
      {
        headline: "Wave 1: Add semantic colors",
        blockLabel: "tool call",
        metadata: ["read"],
        detail: null,
        tone: "accent",
      }
    );

    expect(lines).not.toContain("ctrl+o expand current detail");
    expect(lines).toContain("  [tool call] read");
  });

  it("shows ctrl+o hint and expanded current detail for long status content", () => {
    const longDetail =
      "read done: if (selector.type === 'pseudo-class' && selector.kind === 'active') { applySemanticTokens(theme); return lightDarkCoreVars; }";

    const currentEntry = {
      headline: "Wave 1: Add semantic colors",
      blockLabel: "tool result",
      metadata: ["read", "ok"],
      detail: longDetail,
      tone: "success",
    } as const;

    const collapsed = buildExecuteProgressWidgetLines(
      ["inspect prompt"],
      `Wave 1: Add semantic colors — ${longDetail}`,
      [{ status: "Wave 1: Add semantic colors — thinking…" }],
      {
        completedItems: 0,
        blockedItems: 0,
        remainingItems: 1,
        waves: [],
        activeWave: {
          wave: 1,
          totalItems: 1,
          completedItems: 0,
          errorCount: 0,
          queuedFollowUps: 0,
          activeItem: "Add semantic colors",
        },
      },
      false,
      currentEntry
    );

    const expanded = buildExecuteProgressWidgetLines(
      ["inspect prompt"],
      `Wave 1: Add semantic colors — ${longDetail}`,
      [{ status: "Wave 1: Add semantic colors — thinking…" }],
      {
        completedItems: 0,
        blockedItems: 0,
        remainingItems: 1,
        waves: [],
        activeWave: {
          wave: 1,
          totalItems: 1,
          completedItems: 0,
          errorCount: 0,
          queuedFollowUps: 0,
          activeItem: "Add semantic colors",
        },
      },
      true,
      currentEntry
    );

    expect(collapsed).toContain("ctrl+o expand current detail");
    expect(collapsed.join("\n")).not.toContain(longDetail);
    expect(expanded).toContain("ctrl+o collapse current detail");
    expect(expanded.join("\n")).toContain(longDetail);
  });
});

describe("buildExecuteSummaryRenderText", () => {
  const details: ExecuteSummaryDetails = {
    planItems: ["inspect prompt", "inspect agent"],
    waves: [
      {
        wave: 1,
        jobId: "job_123",
        totalItems: 2,
        completedItems: 2,
        errorCount: 0,
        queuedFollowUps: 0,
      },
    ],
    completed: [
      {
        item: "inspect prompt",
        status: "done",
        summary: "Summarized prompt role",
      },
    ],
    blocked: [],
    filesTouched: ["scripts/fixtures/execute-orchestrator.md"],
    validation: ["read scripts/fixtures/execute-orchestrator.md"],
    remainingFollowUps: [],
  };

  it("renders a compact summary", () => {
    const text = buildExecuteSummaryRenderText(details, false, undefined, 90);

    expect(text).toContain("/execute");
    expect(text).toContain("Plan 2  Waves 1  Done 1  Blocked 0");
    expect(text).toContain("Waves");
    expect(text).toContain("Completed");
    expect(text).not.toContain("Files touched");
    expect(text).not.toContain("job_123");
    expect(text).toContain("✓ inspect prompt — Summarized prompt role");
    expect(text).toContain("↵ expand for job ids, full summaries, files, and follow-ups");
  });

  it("keeps plan items containing em dashes intact in fallback current status rendering", () => {
    const lines = buildExecuteProgressWidgetLines(
      ["inspect prompt"],
      "Wave 1: fix dark — light mode toggle — read done: opened theme.ts",
      [],
      {
        completedItems: 0,
        blockedItems: 0,
        remainingItems: 1,
        waves: [],
        activeWave: {
          wave: 1,
          totalItems: 1,
          completedItems: 0,
          errorCount: 0,
          queuedFollowUps: 0,
          activeItem: "fix dark — light mode toggle",
        },
      }
    );

    expect(lines).toContain("• Wave 1: fix dark — light mode toggle");
    expect(lines).toContain("  ↳ read done: opened theme.ts");
  });

  it("renders expanded sections and failures", () => {
    const expanded = buildExecuteSummaryRenderText(details, true);
    expect(expanded).toContain("Files touched");
    expect(expanded).toContain("• scripts/fixtures/execute-orchestrator.md");
    expect(expanded).toContain("job_123");
    expect(expanded).toContain("✓ inspect prompt");
    expect(expanded).toContain("  Summarized prompt role");
    expect(expanded).toContain("ok");

    const failed = buildExecuteSummaryRenderText({ error: "boom" }, false);
    expect(failed).toContain("/execute failed");
    expect(failed).toContain("! boom");
  });

  it("truncates compact lines to the provided width budget", () => {
    const narrow = buildExecuteSummaryRenderText(
      {
        ...details,
        completed: [
          {
            item: "inspect a very long file name and summarize its detailed role in the system",
            status: "done",
            summary:
              "This is an intentionally long summary that should be compacted into a shorter one-line preview in compact mode.",
          },
        ],
      },
      false,
      undefined,
      72
    );

    expect(narrow).toContain("…");
  });
});

describe("summarizeExecuteStructuredResult", () => {
  it("does not count blocked worker results as completed", () => {
    const summary = summarizeExecuteStructuredResult("inspect prompt", {
      status: "blocked",
      summary: "Need input",
      filesTouched: ["scripts/fixtures/execute-orchestrator.md"],
      validation: ["read scripts/fixtures/execute-orchestrator.md"],
      followUps: ["ask user for input"],
      blockers: ["Need user input"],
    });

    expect(summary.completed).toBeNull();
    expect(summary.blocked).toEqual({
      item: "inspect prompt",
      reason: "Need user input",
    });
    expect(summary.filesTouched).toEqual(["scripts/fixtures/execute-orchestrator.md"]);
    expect(summary.validation).toEqual(["read scripts/fixtures/execute-orchestrator.md"]);
    expect(summary.followUps).toEqual([]);
  });
});

describe("parseWorkerResult", () => {
  it("accepts the expected JSON shape", () => {
    expect(
      parseWorkerResult(
        JSON.stringify({
          status: "done",
          summary: "Completed the step",
          filesTouched: ["scripts/fixtures/execute-orchestrator.md"],
          validation: ["git diff --check"],
          followUps: [],
          blockers: [],
        })
      )
    ).toEqual({
      status: "done",
      summary: "Completed the step",
      filesTouched: ["scripts/fixtures/execute-orchestrator.md"],
      validation: ["git diff --check"],
      followUps: [],
      blockers: [],
    });
  });

  it("accepts fenced JSON output", () => {
    const payload = JSON.stringify({
      status: "done",
      summary: "Completed the step",
      filesTouched: [],
      validation: [],
      followUps: [],
      blockers: [],
    });

    expect(parseWorkerResult(["```json", payload, "```"].join("\n"))).toEqual({
      status: "done",
      summary: "Completed the step",
      filesTouched: [],
      validation: [],
      followUps: [],
      blockers: [],
    });
  });

  it("rejects invalid worker payloads", () => {
    expect(() => parseWorkerResult("not json")).toThrow("Worker returned invalid JSON");
    expect(() =>
      parseWorkerResult(
        JSON.stringify({
          status: "done",
          summary: "Missing arrays",
        })
      )
    ).toThrow("filesTouched");
  });
});

function createMockCtx() {
  const statuses: Array<{ key: string; value: string }> = [];
  const notifications: Array<{ message: string; level: string }> = [];
  const widgets: Array<{ key: string; widget: unknown; rawWidget: unknown; options?: unknown }> = [];
  const terminalInputHandlers: Array<(data: string) => { consume?: boolean; data?: string } | undefined> = [];
  const mockTheme = {
    fg: (_token: string, text: string) => text,
    bg: (_token: string, text: string) => text,
    bold: (text: string) => text,
    strikethrough: (text: string) => `~~${text}~~`,
  };

  return {
    statuses,
    notifications,
    widgets,
    terminalInputHandlers,
    ctx: {
      cwd: process.cwd(),
      sessionManager: {
        getSessionId: () => "execute-test",
        getEntries: () => [],
        getBranch: () => [],
      },
      ui: {
        notify(message: string, level: string) {
          notifications.push({ message, level });
        },
        onTerminalInput(handler: (data: string) => { consume?: boolean; data?: string } | undefined) {
          terminalInputHandlers.push(handler);
          return () => {
            const index = terminalInputHandlers.indexOf(handler);
            if (index >= 0) {
              terminalInputHandlers.splice(index, 1);
            }
          };
        },
        setStatus(key: string, value: string) {
          statuses.push({ key, value });
        },
        setWidget(key: string, widget: unknown, options?: unknown) {
          if (typeof widget === "function") {
            let component:
              | { render: (width: number) => string[]; dispose?: () => void }
              | undefined;
            const tui = {
              terminal: { columns: 160 },
              requestRender() {
                if (!component) {
                  return;
                }
                widgets.push({ key, widget: component.render(160), rawWidget: widget, options });
              },
            };
            component = (widget as (tui: unknown, theme: typeof mockTheme) => { render: (width: number) => string[]; dispose?: () => void })(
              tui,
              mockTheme
            );
            widgets.push({ key, widget: component.render(160), rawWidget: widget, options });
            return;
          }
          widgets.push({ key, widget, rawWidget: widget, options });
        },
      },
    },
  };
}

function createMockPiRuntime() {
  const lifecycleHandlers = new Map<string, Array<(...args: any[]) => unknown>>();
  const eventHandlers = new Map<string, Array<(data: unknown) => void>>();

  const pi = {
    registerTool() {},
    registerCommand() {},
    on(event: string, handler: (...args: any[]) => unknown) {
      if (!lifecycleHandlers.has(event)) {
        lifecycleHandlers.set(event, []);
      }
      lifecycleHandlers.get(event)?.push(handler);
    },
    events: {
      emit(channel: string, data: unknown) {
        for (const handler of eventHandlers.get(channel) ?? []) {
          handler(data);
        }
      },
      on(channel: string, handler: (data: unknown) => void) {
        if (!eventHandlers.has(channel)) {
          eventHandlers.set(channel, []);
        }
        eventHandlers.get(channel)?.push(handler);
        return () => {
          const handlers = eventHandlers.get(channel) ?? [];
          eventHandlers.set(
            channel,
            handlers.filter((entry) => entry !== handler)
          );
        };
      },
    },
  };

  return {
    pi,
    async fireLifecycle(event: string, ...args: any[]) {
      for (const handler of lifecycleHandlers.get(event) ?? []) {
        await handler(...args);
      }
    },
  };
}

describe("startExecutePlan", () => {
  it("launches execute work without awaiting completion", async () => {
    const { ctx, notifications } = createMockCtx();
    let resolvePending: (() => void) | undefined;
    const pending = new Promise<void>((resolve) => {
      resolvePending = resolve;
    });
    let started = false;
    let finished = false;

    startExecutePlan(
      {
        sendMessage() {},
      } as never,
      "inspect execute bridge",
      ctx as never,
      async () => {
        started = true;
        await pending;
        finished = true;
      }
    );

    expect(started).toBe(true);
    expect(finished).toBe(false);
    expect(notifications).toEqual([]);

    resolvePending?.();
    await pending;
    await Promise.resolve();

    expect(finished).toBe(true);
  });

  it("notifies on unexpected detached failures", async () => {
    const { ctx, notifications } = createMockCtx();

    startExecutePlan(
      {
        sendMessage() {},
      } as never,
      "inspect execute bridge",
      ctx as never,
      async () => {
        throw new Error("boom");
      }
    );

    await Promise.resolve();
    await Promise.resolve();

    expect(notifications).toContainEqual({
      message: "/execute failed: boom",
      level: "error",
    });
  });
});

describe("executePlan task bridge", () => {
  function createBridgeHarness() {
    let nextId = 0;
    const created: Array<Record<string, unknown>> = [];
    const updated: Array<Record<string, unknown>> = [];
    const active: Array<{ taskId: string; active: boolean }> = [];

    return {
      created,
      updated,
      active,
      bridge: {
        isAvailable: () => true,
        async createTask(input: {
          subject: string;
          description: string;
          activeForm?: string;
          metadata?: Record<string, unknown>;
        }) {
          const task = {
            id: String(++nextId),
            subject: input.subject,
            description: input.description,
            status: "pending",
            activeForm: input.activeForm,
            owner: undefined,
            metadata: input.metadata ?? {},
            blocks: [],
            blockedBy: [],
            createdAt: nextId,
            updatedAt: nextId,
          };
          created.push(task);
          return task;
        },
        async updateTask(input: Record<string, unknown>) {
          updated.push(input);
          return {
            task: input.taskId ? { id: input.taskId } : undefined,
            changedFields: Object.keys(input).filter((key) => key !== "taskId"),
            warnings: [],
          };
        },
        async setTaskActive(taskId: string, isActive: boolean) {
          active.push({ taskId, active: isActive });
          return true;
        },
      },
    };
  }

  it("digests file-backed plans before dispatch", async () => {
    const messages: unknown[] = [];
    const { ctx, statuses, widgets } = createMockCtx();
    const tempDir = await mkdtemp(path.join(os.tmpdir(), "execute-plan-"));
    const planPath = path.join(tempDir, "plan.md");
    const digestedItems = ["inspect execute bridge", "wire execute task digestion", "add regression test"];
    let capturedDigestInput:
      | {
          directive: string;
          sourceLabel: string;
          fallbackItems: string[];
        }
      | undefined;

    try {
      await writeFile(planPath, `# Plan\n\n- inspect execute bridge\n- wire task breakdown\n`, "utf8");

      await executePlan(
        {
          sendMessage(message: unknown) {
            messages.push(message);
          },
        } as never,
        "implement @plan.md",
        { ...ctx, cwd: tempDir } as never,
        {
          ensureRuntime: async () => ({}) as never,
          createTasksBridge: async () => null,
          digestPlanItems: async (input) => {
            capturedDigestInput = {
              directive: input.directive,
              sourceLabel: input.sourceLabel,
              fallbackItems: input.fallbackItems,
            };
            return digestedItems;
          },
          runWave: async (_ctx, _runtime, items) => ({
            summary: {
              wave: 1,
              jobId: "job_1",
              totalItems: items.length,
              completedItems: items.length,
              errorCount: 0,
              queuedFollowUps: 0,
            },
            results: items.map((item) => ({
              item,
              isError: false,
              structuredOutput: {
                status: "done",
                summary: `done: ${item}`,
                filesTouched: ["extensions/execute/index.ts"],
                validation: ["bun test extensions/execute/index.test.ts"],
                followUps: [],
                blockers: [],
              },
            })) as never,
          }),
          createExecutionId: () => "execute:test",
        }
      );
    } finally {
      await rm(tempDir, { recursive: true, force: true });
    }

    expect(capturedDigestInput).toEqual({
      directive: "implement",
      sourceLabel: "plan.md",
      fallbackItems: ["inspect execute bridge", "wire task breakdown"],
    });
    expect(statuses).toContainEqual({
      key: "execute",
      value: "Digesting plan.md into executable tasks...",
    });
    expect(statuses).toContainEqual({
      key: "execute",
      value: "Prepared 3 executable task(s)",
    });
    expect(widgets.some((entry) => Array.isArray(entry.widget) && entry.widget.join("\n").includes("Digesting plan.md into executable tasks..."))).toBe(true);
    expect((messages[0] as { details: ExecuteSummaryDetails }).details.completed).toEqual(
      digestedItems.map((item) => ({
        item,
        status: "done",
        summary: `done: ${item}`,
      }))
    );
  });

  it.each([
    {
      label: "throws",
      buildDigester: () => async () => {
        throw new Error("boom");
      },
      expectedWarning: "Unable to digest plan, using parsed items: boom",
    },
    {
      label: "returns no tasks",
      buildDigester: () => async () => [],
      expectedWarning: "Unable to digest plan, using parsed items: digester returned no tasks",
    },
  ])("falls back to parsed file-backed items when digestion $label", async ({ buildDigester, expectedWarning }) => {
    const messages: unknown[] = [];
    const { ctx, notifications, statuses, widgets } = createMockCtx();
    const tempDir = await mkdtemp(path.join(os.tmpdir(), "execute-plan-"));
    const planPath = path.join(tempDir, "plan.md");

    try {
      await writeFile(planPath, `# Plan\n\n- inspect execute bridge\n- add regression test\n`, "utf8");

      await executePlan(
        {
          sendMessage(message: unknown) {
            messages.push(message);
          },
        } as never,
        "@plan.md",
        { ...ctx, cwd: tempDir } as never,
        {
          ensureRuntime: async () => ({}) as never,
          createTasksBridge: async () => null,
          digestPlanItems: buildDigester(),
          runWave: async (_ctx, _runtime, items) => ({
            summary: {
              wave: 1,
              jobId: "job_1",
              totalItems: items.length,
              completedItems: items.length,
              errorCount: 0,
              queuedFollowUps: 0,
            },
            results: items.map((item) => ({
              item,
              isError: false,
              structuredOutput: {
                status: "done",
                summary: `done: ${item}`,
                filesTouched: ["extensions/execute/index.ts"],
                validation: ["bun test extensions/execute/index.test.ts"],
                followUps: [],
                blockers: [],
              },
            })) as never,
          }),
          createExecutionId: () => "execute:test",
        }
      );
    } finally {
      await rm(tempDir, { recursive: true, force: true });
    }

    expect(notifications).toContainEqual({
      message: expectedWarning,
      level: "warning",
    });
    expect(statuses).toContainEqual({
      key: "execute",
      value: "Digesting plan.md into executable tasks...",
    });
    expect(widgets.some((entry) => Array.isArray(entry.widget) && entry.widget.join("\n").includes("Digesting plan.md into executable tasks..."))).toBe(true);
    expect((messages[0] as { details: ExecuteSummaryDetails }).details.completed).toEqual([
      {
        item: "inspect execute bridge",
        status: "done",
        summary: "done: inspect execute bridge",
      },
      {
        item: "add regression test",
        status: "done",
        summary: "done: add regression test",
      },
    ]);
  });

  it("falls back cleanly when pi-tasks is unavailable", async () => {
    const messages: Array<{ message: unknown; options?: unknown }> = [];
    const { ctx, statuses, notifications, widgets } = createMockCtx();

    await executePlan(
      {
        sendMessage(message: unknown, options?: unknown) {
          messages.push({ message, options });
        },
      } as never,
      "inspect execute bridge",
      ctx as never,
      {
        ensureRuntime: async () => ({}) as never,
        createTasksBridge: async () => null,
        runWave: async (_ctx, _runtime, items) => ({
          summary: {
            wave: 1,
            jobId: "job_1",
            totalItems: items.length,
            completedItems: items.length,
            errorCount: 0,
            queuedFollowUps: 0,
          },
          results: items.map((item) => ({
            item,
            isError: false,
            structuredOutput: {
              status: "done",
              summary: `done: ${item}`,
              filesTouched: ["extensions/execute/index.ts"],
              validation: ["bun test extensions/execute/index.test.ts"],
              followUps: [],
              blockers: [],
            },
          })) as never,
        }),
        createExecutionId: () => "execute:test",
      }
    );

    expect(messages).toHaveLength(1);
    expect(messages[0]?.options).toEqual({ triggerTurn: false });
    expect((messages[0]?.message as { details: ExecuteSummaryDetails }).details.completed).toEqual([
      {
        item: "inspect execute bridge",
        status: "done",
        summary: "done: inspect execute bridge",
      },
    ]);
    expect(notifications).toContainEqual({
      message: "/execute: pi-tasks bridge unavailable — load pi-tasks to see live task progress",
      level: "info",
    });
    expect(widgets[0]).toMatchObject({
      key: expect.stringContaining("execute-"),
      options: { placement: "aboveEditor" },
    });
    expect(typeof widgets[0]?.rawWidget).toBe("function");
    expect(
      widgets.some(
        (entry) => Array.isArray(entry.widget) && entry.widget.join("\n").includes("Overall [██████████]  1 done  0 blocked  0 remaining")
      )
    ).toBe(true);
    expect(
      widgets.some(
        (entry) => Array.isArray(entry.widget) && entry.widget.join("\n").includes("• Wave 1  [██████████]  1/1 done  ok  no follow-ups")
      )
    ).toBe(true);
    expect(widgets.some((entry) => Array.isArray(entry.widget) && entry.widget.join("\n").includes("Recent"))).toBe(true);
    expect(statuses).toContainEqual({
      key: "execute",
      value: "Wave 1 complete — 1/1 done, 0 errors, 0 follow-ups",
    });
    expect(widgets.at(-1)).toMatchObject({ key: expect.stringContaining("execute-"), widget: undefined });
    expect(statuses.at(-1)).toEqual({ key: "execute", value: "" });
  });

  it("updates active wave counts in the widget as items finish", async () => {
    const { ctx, widgets } = createMockCtx();

    await executePlan(
      {
        sendMessage() {},
      } as never,
      ["inspect execute bridge", "summarize execute widget"].join("\n"),
      ctx as never,
      {
        ensureRuntime: async () => ({}) as never,
        createTasksBridge: async () => null,
        runWave: async (_ctx, _runtime, items, wave, onProgress, onItemComplete) => {
          onProgress?.({
            wave,
            item: items[0] ?? "inspect execute bridge",
            event: {
              type: "assistant_text",
              text: "Thinking through the task",
            },
          });
          onItemComplete?.({
            wave,
            item: items[0] ?? "inspect execute bridge",
            isError: false,
            followUpCount: 0,
          });

          return {
            summary: {
              wave,
              jobId: "job_1",
              totalItems: items.length,
              completedItems: items.length,
              errorCount: 0,
              queuedFollowUps: 0,
            },
            results: items.map((item) => ({
              item,
              isError: false,
              structuredOutput: {
                status: "done",
                summary: `done: ${item}`,
                filesTouched: [],
                validation: [],
                followUps: [],
                blockers: [],
              },
            })) as never,
          };
        },
        createExecutionId: () => "execute:test",
      }
    );

    expect(
      widgets.some(
        (entry) => Array.isArray(entry.widget) && entry.widget.join("\n").includes("Overall [█████░░░░░]  1 done  0 blocked  1 remaining")
      )
    ).toBe(true);
    expect(
      widgets.some(
        (entry) => Array.isArray(entry.widget) && entry.widget.join("\n").includes("• Wave 1  [█████░░░░░]  1/2 done  running  no follow-ups")
      )
    ).toBe(true);
  });

  it("toggles current detail expansion with ctrl+o while execute is running", async () => {
    const { ctx, widgets, terminalInputHandlers } = createMockCtx();
    const longDetail =
      "read done: if (selector.type === 'pseudo-class' && selector.kind === 'active') { applySemanticTokens(theme); return lightDarkCoreVars; }";

    let releaseWave: (() => void) | undefined;
    const wavePending = new Promise<void>((resolve) => {
      releaseWave = resolve;
    });

    const promise = executePlan(
      {
        sendMessage() {},
      } as never,
      "inspect execute bridge",
      ctx as never,
      {
        ensureRuntime: async () => ({}) as never,
        createTasksBridge: async () => null,
        runWave: async (_ctx, _runtime, items, wave, onProgress) => {
          onProgress?.({
            wave,
            item: items[0] ?? "inspect execute bridge",
            event: {
              type: "tool_end",
              toolName: "read",
              isError: false,
              text: longDetail,
            },
          });

          await wavePending;

          return {
            summary: {
              wave,
              jobId: "job_1",
              totalItems: items.length,
              completedItems: items.length,
              errorCount: 0,
              queuedFollowUps: 0,
            },
            results: items.map((item) => ({
              item,
              isError: false,
              structuredOutput: {
                status: "done",
                summary: `done: ${item}`,
                filesTouched: [],
                validation: [],
                followUps: [],
                blockers: [],
              },
            })) as never,
          };
        },
        createExecutionId: () => "execute:test",
      }
    );

    for (let attempt = 0; attempt < 4 && terminalInputHandlers.length === 0; attempt += 1) {
      await Promise.resolve();
    }
    for (
      let attempt = 0;
      attempt < 8 &&
      !widgets.some(
        (entry) => Array.isArray(entry.widget) && entry.widget.join("\n").includes("ctrl+o expand current detail")
      );
      attempt += 1
    ) {
      await Promise.resolve();
    }

    expect(terminalInputHandlers).toHaveLength(1);
    expect(
      widgets.some(
        (entry) => Array.isArray(entry.widget) && entry.widget.join("\n").includes("ctrl+o expand current detail")
      )
    ).toBe(true);
    expect(
      widgets.some(
        (entry) => Array.isArray(entry.widget) && entry.widget.join("\n").includes("applySemanticTokens(theme); return lightDarkCoreVars; }")
      )
    ).toBe(false);

    const result = terminalInputHandlers[0]?.("\u000f");
    expect(result).toEqual({ consume: true });
    for (
      let attempt = 0;
      attempt < 4 &&
      !widgets.some(
        (entry) => Array.isArray(entry.widget) && entry.widget.join("\n").includes("ctrl+o collapse current detail")
      );
      attempt += 1
    ) {
      await Promise.resolve();
    }
    expect(
      widgets.some(
        (entry) => Array.isArray(entry.widget) && entry.widget.join("\n").includes("ctrl+o collapse current detail")
      )
    ).toBe(true);
    expect(
      widgets.some(
        (entry) => Array.isArray(entry.widget) && entry.widget.join("\n").includes(longDetail)
      )
    ).toBe(true);

    releaseWave?.();
    await promise;
    expect(terminalInputHandlers).toHaveLength(0);
  });

  it("mirrors root, blocker, and follow-up lifecycle into tasks", async () => {
    const messages: unknown[] = [];
    const { ctx } = createMockCtx();
    const harness = createBridgeHarness();

    await executePlan(
      {
        sendMessage(message: unknown) {
          messages.push(message);
        },
      } as never,
      ["implement bridge", "handle blockers"].join("\n"),
      ctx as never,
      {
        ensureRuntime: async () => ({}) as never,
        createTasksBridge: async () => harness.bridge as never,
        runWave: async (_ctx, _runtime, items, wave) => {
          if (wave === 1) {
            return {
              summary: {
                wave,
                jobId: "job_1",
                totalItems: items.length,
                completedItems: 1,
                errorCount: 0,
                queuedFollowUps: 1,
              },
              results: [
                {
                  item: items[0],
                  isError: false,
                  structuredOutput: {
                    status: "needs_followup",
                    summary: "Bridge wired",
                    filesTouched: ["extensions/execute/index.ts"],
                    validation: ["bun test extensions/execute/index.test.ts"],
                    followUps: ["document bridge"],
                    blockers: [],
                  },
                },
                {
                  item: items[1],
                  isError: false,
                  structuredOutput: {
                    status: "blocked",
                    summary: "Need tasks rpc",
                    filesTouched: ["../pi-tasks/src/index.ts"],
                    validation: ["npm test"],
                    followUps: [],
                    blockers: ["Need tasks rpc"],
                  },
                },
              ] as never,
            };
          }

          return {
            summary: {
              wave,
              jobId: "job_2",
              totalItems: items.length,
              completedItems: items.length,
              errorCount: 0,
              queuedFollowUps: 0,
            },
            results: items.map((item) => ({
              item,
              isError: false,
              structuredOutput: {
                status: "done",
                summary: `Finished ${item}`,
                filesTouched: ["../pi-tasks/README.md"],
                validation: ["npm run test"],
                followUps: [],
                blockers: [],
              },
            })) as never,
          };
        },
        createExecutionId: () => "execute:test",
      }
    );

    expect(harness.created.map((task) => task.subject)).toEqual([
      "Execute plan",
      "implement bridge",
      "handle blockers",
      "document bridge",
      "Unblock: handle blockers",
    ]);

    expect(
      harness.updated.some(
        (update) =>
          update.taskId === "2" &&
          update.status === "completed" &&
          (update.metadata as Record<string, unknown>).resultStatus === "needs_followup",
      ),
    ).toBe(true);

    expect(
      harness.updated.some(
        (update) =>
          update.taskId === "3" &&
          update.status === "pending" &&
          Array.isArray(update.addBlockedBy) &&
          update.addBlockedBy.includes("5"),
      ),
    ).toBe(true);

    expect(
      harness.updated.some(
        (update) =>
          update.taskId === "1" &&
          update.status === "pending" &&
          Array.isArray(update.addBlockedBy) &&
          update.addBlockedBy.includes("5"),
      ),
    ).toBe(true);

    expect(harness.active).toContainEqual({ taskId: "1", active: true });
    expect(harness.active).toContainEqual({ taskId: "1", active: false });
    expect(harness.active).toContainEqual({ taskId: "2", active: true });
    expect(harness.active).toContainEqual({ taskId: "2", active: false });
    expect(harness.active).toContainEqual({ taskId: "4", active: true });
    expect(harness.active).toContainEqual({ taskId: "4", active: false });

    const details = (messages[0] as { details: ExecuteSummaryDetails }).details;
    expect(details.completed).toEqual([
      {
        item: "implement bridge",
        status: "needs_followup",
        summary: "Bridge wired",
      },
      {
        item: "document bridge",
        status: "done",
        summary: "Finished document bridge",
      },
    ]);
    expect(details.blocked).toEqual([
      {
        item: "handle blockers",
        reason: "Need tasks rpc",
      },
    ]);
    expect(details.remainingFollowUps).toEqual([]);
  });

  it("marks completed items done before the wave finishes through the real pi-tasks rpc bridge", async () => {
    const runtime = createMockPiRuntime();
    const { ctx, widgets } = createMockCtx();
    const tempDir = await mkdtemp(path.join(os.tmpdir(), "execute-pi-tasks-"));
    const previousCwd = process.cwd();
    let releaseWave: (() => void) | undefined;
    const wavePending = new Promise<void>((resolve) => {
      releaseWave = resolve;
    });
    let midWaveTaskSnapshots: string[][] = [];

    try {
      process.chdir(tempDir);
      initTasksExtension(runtime.pi as never);

      const promise = executePlan(
        {
          ...runtime.pi,
          sendMessage() {},
        } as never,
        ["finish first item", "finish second item"].join("\n"),
        { ...ctx, cwd: tempDir } as never,
        {
          ensureRuntime: async () => ({}) as never,
          runWave: async (_ctx, _runtime, items, wave, _onProgress, onItemComplete) => {
            await onItemComplete?.({
              wave,
              index: 0,
              jobId: "job_1",
              item: items[0] ?? "finish first item",
              result: {
                item: items[0] ?? "finish first item",
                isError: false,
                structuredOutput: {
                  status: "done",
                  summary: `Finished ${items[0] ?? "finish first item"}`,
                  filesTouched: ["extensions/execute/index.ts"],
                  validation: ["bun test extensions/execute/index.test.ts"],
                  followUps: [],
                  blockers: [],
                },
                stderr: "",
                exitCode: 0,
                errorMessage: null,
              } as never,
              isError: false,
              followUpCount: 0,
            });
            await Promise.resolve();

            midWaveTaskSnapshots = widgets
              .filter((entry) => entry.key === "tasks" && Array.isArray(entry.widget))
              .map((entry) => entry.widget as string[]);

            await wavePending;

            return {
              summary: {
                wave,
                jobId: "job_1",
                totalItems: items.length,
                completedItems: items.length,
                errorCount: 0,
                queuedFollowUps: 0,
              },
              results: items.map((item) => ({
                item,
                isError: false,
                structuredOutput: {
                  status: "done",
                  summary: `Finished ${item}`,
                  filesTouched: ["extensions/execute/index.ts"],
                  validation: ["bun test extensions/execute/index.test.ts"],
                  followUps: [],
                  blockers: [],
                },
              })) as never,
            };
          },
          createExecutionId: () => "execute:test",
        }
      );

      releaseWave?.();
      await promise;
    } finally {
      process.chdir(previousCwd);
      await rm(tempDir, { recursive: true, force: true });
    }

    expect(
      midWaveTaskSnapshots.some((lines) => lines.join("\n").includes("3 tasks (1 done, 2 in progress)"))
    ).toBe(true);
    expect(
      midWaveTaskSnapshots.some((lines) => lines.join("\n").includes("~~#2 finish first item~~"))
    ).toBe(true);
  });

  it("syncs final task statuses through the real pi-tasks rpc bridge", async () => {
    const runtime = createMockPiRuntime();
    const { ctx, widgets } = createMockCtx();
    const tempDir = await mkdtemp(path.join(os.tmpdir(), "execute-pi-tasks-"));
    const previousCwd = process.cwd();

    try {
      process.chdir(tempDir);
      initTasksExtension(runtime.pi as never);

      await executePlan(
        {
          ...runtime.pi,
          sendMessage() {},
        } as never,
        ["finish first item", "finish second item"].join("\n"),
        { ...ctx, cwd: tempDir } as never,
        {
          ensureRuntime: async () => ({}) as never,
          runWave: async (_ctx, _runtime, items, wave) => ({
            summary: {
              wave,
              jobId: "job_1",
              totalItems: items.length,
              completedItems: items.length,
              errorCount: 0,
              queuedFollowUps: 0,
            },
            results: items.map((item) => ({
              item,
              isError: false,
              structuredOutput: {
                status: "done",
                summary: `Finished ${item}`,
                filesTouched: ["extensions/execute/index.ts"],
                validation: ["bun test extensions/execute/index.test.ts"],
                followUps: [],
                blockers: [],
              },
            })) as never,
          }),
          createExecutionId: () => "execute:test",
        }
      );
    } finally {
      process.chdir(previousCwd);
      await rm(tempDir, { recursive: true, force: true });
    }

    const taskWidget = widgets
      .filter((entry) => entry.key === "tasks" && Array.isArray(entry.widget))
      .at(-1)?.widget as string[] | undefined;

    expect(taskWidget).toBeDefined();
    expect(taskWidget?.[0]).toContain("3 tasks");
    expect(taskWidget?.[0]).toContain("3 done");
    expect(taskWidget?.join("\n")).toContain("~~#1 Execute plan~~");
    expect(taskWidget?.join("\n")).toContain("~~#2 finish first item~~");
    expect(taskWidget?.join("\n")).toContain("~~#3 finish second item~~");
  });
});
