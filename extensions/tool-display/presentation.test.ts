import { describe, expect, test } from "bun:test";
import { setTimeout as sleep } from "node:timers/promises";

import { visibleWidth } from "@earendil-works/pi-tui";
import { Type } from "typebox";

import {
  cleanupToolDisplayTimers,
  composeReasonedTool,
  formatToolDuration,
  type PresentationState,
  renderBashToolCall,
  renderOwnedToolCall,
  renderOwnedToolResult,
  toolResultBody,
} from "./presentation";

const plainTheme = {
  bg: (_token: string, text: string) => text.trimEnd(),
  bold: (text: string) => text,
  fg: (_token: string, text: string) => text,
};

describe("reasoned tool composition", () => {
  test("prepends required reasoning, appends guidelines, and strips only reasoning", async () => {
    let delegated: unknown;
    const base = {
      name: "sample",
      label: "sample",
      description: "sample",
      parameters: Type.Object({ path: Type.String() }),
      promptGuidelines: ["Keep existing guidance"],
      execute(_id: string, params: { path: string }) {
        delegated = params;
        return Promise.resolve({ content: [] });
      },
    };
    const tool = composeReasonedTool(base as never, {
      reasoningDescription:
        "State short present-tense goal in 12 words or fewer",
      promptGuidelines: ["Give sample a short reasoning goal"],
    });

    expect(Object.keys(tool.parameters.properties)).toEqual([
      "reasoning",
      "path",
    ]);
    expect(tool.parameters.required as string[]).toEqual(["reasoning", "path"]);
    expect(tool.promptGuidelines).toEqual([
      "Keep existing guidance",
      "Give sample a short reasoning goal",
    ]);
    await tool.execute(
      "id",
      { reasoning: "Inspect configuration", path: "a.ts" },
      undefined,
      undefined,
      { cwd: "." } as never
    );
    expect(delegated).toEqual({ path: "a.ts" });
  });
});

describe("owned tool presentation", () => {
  test("renders stable two-line pending and settled headers with fallback", () => {
    const state = {};
    const context = {
      args: { path: "src/deep/target.ts" },
      state,
      invalidate() {
        return;
      },
    };
    const call = renderOwnedToolCall(
      "read",
      context.args,
      plainTheme,
      context as never
    );
    expect(call.render(80)).toEqual([
      "┊ • 📖 read Read file",
      "┊   src/deep/target.ts → <1s",
    ]);

    const result = renderOwnedToolResult(
      "read",
      { content: [{ type: "text", text: "one\ntwo" }] },
      {},
      plainTheme,
      context as never
    );
    expect(call.render(80)).toEqual(["┊ ✓ 📖 read Read file"]);
    expect(result.render(80)).toEqual(["┊   src/deep/target.ts → 2 lines"]);
  });

  test("summarizes successful image reads without counting text lines", () => {
    const context = {
      args: { path: "photo.png" },
      state: {},
      invalidate() {
        return;
      },
    };
    const result = renderOwnedToolResult(
      "read",
      {
        content: [{ type: "image" }],
        details: { truncation: { truncated: true } },
      },
      {},
      plainTheme,
      context as never
    );

    expect(result.render(80)).toEqual([
      "┊   photo.png → image loaded [truncated]",
    ]);
  });

  test("counts only grep match rows when native context output is present", () => {
    const context = {
      args: { pattern: "needle", path: "." },
      state: {},
      invalidate() {
        return;
      },
    };
    const result = renderOwnedToolResult(
      "grep",
      {
        content: [
          {
            type: "text",
            text: "a.ts-1-before\na.ts:2:needle\na.ts-3-after\n--\nb.ts:8:needle",
          },
        ],
      },
      {},
      plainTheme,
      context as never
    );

    expect(result.render(120).join(" ")).toContain("2 matches · 2 files");
  });

  test("uses validated patch headers as single and multi-file edit targets", () => {
    const renderTarget = (patch: string) => {
      const context = {
        args: { patch },
        state: {},
        invalidate() {
          return;
        },
      };
      renderOwnedToolCall("edit", context.args, plainTheme, context as never);
      return renderOwnedToolResult(
        "edit",
        { content: [{ type: "text", text: "done" }] },
        {},
        plainTheme,
        context as never
      )
        .render(120)
        .join(" ");
    };

    expect(
      renderTarget(
        "*** Begin Patch\n*** Update File: a.ts\n@@\n-old\n+new\n*** End Patch"
      )
    ).toContain("a.ts →");
    expect(
      renderTarget(
        "*** Begin Patch\n*** Update File: a.ts\n@@\n-old\n+new\n*** Add File: b.ts\n+new\n*** End Patch"
      )
    ).toContain("a.ts, b.ts →");
  });

  test("summarizes grep matches and files and clamps every line to width", () => {
    const context = {
      args: {
        reasoning: "Locate important configuration references",
        pattern: "configuration",
        path: "very/long/source/directory",
      },
      state: {},
      invalidate() {
        return;
      },
    };
    const call = renderOwnedToolCall(
      "grep",
      context.args,
      plainTheme,
      context as never
    );
    const result = renderOwnedToolResult(
      "grep",
      { content: [{ type: "text", text: "a.ts:1:x\na.ts:2:y\nb.ts:3:z" }] },
      {},
      plainTheme,
      context as never
    );
    expect(result.render(120).join(" ")).toContain("3 matches · 2 files");
    expect(
      [...call.render(24), ...result.render(24)].every(
        (line) => visibleWidth(line) <= 24
      )
    ).toBe(true);
  });

  test("invalidates pending rows no more than once per visible second", async () => {
    let invalidations = 0;
    renderOwnedToolCall("read", { path: "pending.ts" }, plainTheme, {
      state: {},
      invalidate() {
        invalidations += 1;
      },
    });
    await sleep(1250);
    cleanupToolDisplayTimers();
    expect(invalidations).toBeGreaterThanOrEqual(1);
    expect(invalidations).toBeLessThanOrEqual(2);
  });

  test("cleanup clears timer ownership and a restored row resubscribes", () => {
    const state: PresentationState = {};
    const context = {
      state,
      invalidate() {
        return;
      },
    };
    renderOwnedToolCall("read", { path: "pending.ts" }, plainTheme, context);
    const firstTimer = state.toolDisplayPresentation?.timer;
    expect(firstTimer).toBeDefined();

    cleanupToolDisplayTimers("file");
    expect(state.toolDisplayPresentation?.timer).toBeUndefined();
    renderOwnedToolCall("read", { path: "pending.ts" }, plainTheme, context);
    expect(state.toolDisplayPresentation?.timer).toBeDefined();
    expect(state.toolDisplayPresentation?.timer).not.toBe(firstTimer);
    cleanupToolDisplayTimers("file");
  });

  test("owner cleanup leaves other extension timers active", () => {
    const fileState: PresentationState = {};
    const rtkState: PresentationState = {};
    const context = {
      invalidate() {
        // Timer callback intentionally does no rendering in this unit test.
      },
    };
    renderOwnedToolCall("read", {}, plainTheme, {
      ...context,
      state: fileState,
    });
    renderBashToolCall({}, plainTheme, { ...context, state: rtkState });

    cleanupToolDisplayTimers("rtk");
    expect(rtkState.toolDisplayPresentation?.timer).toBeUndefined();
    expect(fileState.toolDisplayPresentation?.timer).toBeDefined();
    cleanupToolDisplayTimers("file");
  });

  test("expanded large bodies avoid slice, map, and iterator copies", () => {
    const lines = Array.from({ length: 4000 }, (_, index) => `line ${index}`);
    const guardedLines = new Proxy(lines, {
      get(target, property, receiver) {
        if (
          property === "slice" ||
          property === "map" ||
          property === Symbol.iterator
        ) {
          throw new Error(`large body copied with ${String(property)}`);
        }
        return Reflect.get(target, property, receiver);
      },
    });
    const body = toolResultBody(
      {
        invalidate() {
          // Static fixture has no cache to invalidate.
        },
        render() {
          return guardedLines;
        },
      },
      true
    );
    const result = renderOwnedToolResult(
      "read",
      { content: [{ type: "text", text: "done" }] },
      {},
      plainTheme,
      { args: { path: "large.ts" }, state: {} },
      body
    );

    const rendered = result.render(40);
    expect(rendered).toHaveLength(4000);
    expect(rendered[1]).toBe("line 1");
    expect(rendered.at(-1)).toBe("line 3999");
  });

  test("colors tool names by Tidy category", () => {
    const foregroundCalls: [string, string][] = [];
    const colorTheme = {
      bg: (_token: string, text: string) => text.trimEnd(),
      bold: (text: string) => text,
      fg: (token: string, text: string) => {
        foregroundCalls.push([token, text]);
        return text;
      },
    };
    const context = {
      state: {} as PresentationState,
      invalidate() {
        return;
      },
    };

    renderOwnedToolCall("read", {}, colorTheme, context).render(80);
    renderOwnedToolCall("edit", {}, colorTheme, context).render(80);
    renderBashToolCall({}, colorTheme, context).render(80);

    expect(foregroundCalls).toContainEqual(["accent", "📖"]);
    expect(foregroundCalls).toContainEqual(["accent", "read"]);
    expect(foregroundCalls).toContainEqual(["warning", "✏️"]);
    expect(foregroundCalls).toContainEqual(["warning", "edit"]);
    expect(foregroundCalls).toContainEqual(["thinkingXhigh", "⚡️"]);
    expect(foregroundCalls).toContainEqual(["thinkingXhigh", "bash"]);
    cleanupToolDisplayTimers();
  });

  test("formats elapsed durations", () => {
    expect(formatToolDuration(1)).toBe("<1s");
    expect(formatToolDuration(9100)).toBe("9s");
    expect(formatToolDuration(65_000)).toBe("1m 05s");
    expect(formatToolDuration(3_661_000)).toBe("1h 01m 01s");
  });
});
