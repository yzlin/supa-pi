import { afterEach, beforeAll, describe, expect, test } from "bun:test";
import { stripVTControlCharacters } from "node:util";

import { Type } from "@earendil-works/pi-ai";
import type {
  AgentToolResult,
  ToolDefinition,
} from "@earendil-works/pi-coding-agent";
import { Text, visibleWidth } from "@earendil-works/pi-tui";

import { ToolExecutionComponent } from "../../node_modules/@earendil-works/pi-coding-agent/dist/modes/interactive/components/tool-execution.js";
import {
  initTheme,
  theme,
} from "../../node_modules/@earendil-works/pi-coding-agent/dist/modes/interactive/theme/theme.js";
import {
  cleanupToolDisplayTimers,
  type PresentationState,
  renderBashToolCall,
  renderBashToolResult,
  renderOwnedToolCall,
  renderOwnedToolResult,
  toolResultBody,
} from "./presentation";

const ui = {
  requestRender() {
    // Deterministic smoke renders synchronously.
  },
};

const fixtureSchema = Type.Object({
  reasoning: Type.String(),
  path: Type.String(),
});

interface FixtureDetails {
  toolDisplay?: {
    durationMs?: number;
    fullRead?: boolean;
    targetName?: string;
    ignoredLimit?: number;
  };
}

interface BashFixtureDetails {
  rtkCompaction?: {
    savedChars: number;
    originalChars: number;
    finalChars: number;
  };
}

function fixtureDefinition(): ToolDefinition<
  typeof fixtureSchema,
  FixtureDetails,
  PresentationState
> {
  return {
    name: "read",
    label: "read",
    description: "fixture",
    parameters: fixtureSchema,
    renderShell: "self",
    execute: async () => ({ content: [], details: {} }),
    renderCall: (args, activeTheme, context) =>
      renderOwnedToolCall("read", args, activeTheme, context),
    renderResult: (result, options, activeTheme, context) =>
      renderOwnedToolResult(
        "read",
        result,
        options,
        activeTheme,
        context,
        options.expanded
          ? toolResultBody(new Text("expanded-one\nexpanded-two", 0, 0))
          : undefined
      ),
  };
}

function createFixture(reasoning: string) {
  return new ToolExecutionComponent(
    "read",
    "smoke-call",
    {
      reasoning,
      path: "packages/deeply/nested/path/ending-in-important-📦-target.ts",
    },
    {},
    fixtureDefinition(),
    ui as never,
    process.cwd()
  );
}

function contentRows(component: ToolExecutionComponent, width: number) {
  return component.render(width).slice(1);
}

function expectRowsFit(rows: string[], width: number): void {
  expect(rows.every((line) => visibleWidth(line) === width)).toBe(true);
}

beforeAll(() => {
  initTheme("dark", false);
});

afterEach(() => {
  cleanupToolDisplayTimers();
});

describe("real Pi ToolExecutionComponent smoke", () => {
  test("composes self shell through pending, success, expansion, and resize", () => {
    const component = createFixture("Inspect emoji 📖 renderer behavior");

    for (const width of [28, 64, 37]) {
      const pending = contentRows(component, width);
      expect(pending).toHaveLength(2);
      expectRowsFit(pending, width);
      expect(
        pending.every((line) => line.includes(theme.getBgAnsi("toolPendingBg")))
      ).toBe(true);
    }
    expect(contentRows(component, 64).join("\n")).toContain("📖");
    expect(contentRows(component, 37)[1]).toContain("target.ts");

    component.updateResult(
      {
        content: [{ type: "text", text: "one\ntwo" }],
        details: {
          toolDisplay: {
            durationMs: 1200,
            fullRead: true,
            targetName: "skills",
            ignoredLimit: 1,
          },
        },
        isError: false,
      },
      false
    );
    const settled = contentRows(component, 64);
    expect(settled).toHaveLength(2);
    expect(settled.join("\n")).toContain("full read skills");
    expect(settled.join("\n")).toContain("[pagination ignored]");
    expect(
      settled.every((line) => line.includes(theme.getBgAnsi("toolSuccessBg")))
    ).toBe(true);
    expectRowsFit(settled, 64);

    component.setExpanded(true);
    const expanded = contentRows(component, 37);
    expect(expanded.slice(0, 2)).toHaveLength(2);
    expect(expanded.join("\n")).toContain("expanded-one");
    expect(expanded.join("\n")).toContain("expanded-two");
    expectRowsFit(expanded, 37);
  });

  test("keeps bash and file tools pending across partial results, then settles final", () => {
    const read = createFixture("Stream file");
    read.updateResult(
      { content: [{ type: "text", text: "one" }], isError: false },
      true
    );
    expect(contentRows(read, 64)).toHaveLength(3);
    expect(contentRows(read, 64).join("\n")).toContain("📖");
    expect(
      contentRows(read, 64).every((line) =>
        line.includes(theme.getBgAnsi("toolPendingBg"))
      )
    ).toBe(true);
    read.updateResult(
      { content: [{ type: "text", text: "one\ntwo" }], isError: false },
      false
    );
    expect(contentRows(read, 64)).toHaveLength(2);
    expect(
      contentRows(read, 64).every((line) =>
        line.includes(theme.getBgAnsi("toolSuccessBg"))
      )
    ).toBe(true);

    const bashSchema = Type.Object({
      reasoning: Type.String(),
      command: Type.String(),
    });
    const bashDefinition: ToolDefinition<
      typeof bashSchema,
      BashFixtureDetails,
      PresentationState
    > = {
      name: "bash",
      label: "bash",
      description: "fixture",
      parameters: bashSchema,
      renderShell: "self",
      execute: async (): Promise<AgentToolResult<BashFixtureDetails>> => ({
        content: [],
        details: {},
      }),
      renderCall: (args, activeTheme, context) =>
        renderBashToolCall(args, activeTheme, context),
      renderResult: (result, options, activeTheme, context) =>
        renderBashToolResult(result, options, activeTheme, context),
    };
    const bash = new ToolExecutionComponent(
      "bash",
      "bash-call",
      {
        reasoning: "Stream command",
        command: "printf one\nsleep 20\necho hidden-tail",
      },
      {},
      bashDefinition,
      ui as never,
      process.cwd()
    );
    bash.updateResult(
      { content: [{ type: "text", text: "one" }], isError: false },
      true
    );
    const pendingBashRows = contentRows(bash, 64);
    const pendingBashText = pendingBashRows.join("\n");
    expect(pendingBashRows).toHaveLength(2);
    expect(pendingBashText).toContain("⚡");
    expect(pendingBashText).toContain("printf one (+2 lines)");
    expect(pendingBashText).not.toContain("hidden-tail");
    expect(
      pendingBashRows.every((line) =>
        line.includes(theme.getBgAnsi("toolPendingBg"))
      )
    ).toBe(true);
    bash.updateResult(
      { content: [{ type: "text", text: "done" }], isError: false },
      false
    );
    const settledBashRows = contentRows(bash, 64);
    expect(settledBashRows).toHaveLength(2);
    expect(
      settledBashRows.every((line) =>
        line.includes(theme.getBgAnsi("toolSuccessBg"))
      )
    ).toBe(true);
  });

  test("sanitizes multiline and terminal-control bash headers", () => {
    const bashSchema = Type.Object({
      reasoning: Type.String(),
      command: Type.String(),
    });
    const bashDefinition: ToolDefinition<
      typeof bashSchema,
      BashFixtureDetails,
      PresentationState
    > = {
      name: "bash",
      label: "bash",
      description: "fixture",
      parameters: bashSchema,
      renderShell: "self",
      execute: async (): Promise<AgentToolResult<BashFixtureDetails>> => ({
        content: [],
        details: {},
      }),
      renderCall: (args, activeTheme, context) =>
        renderBashToolCall(args, activeTheme, context),
      renderResult: (result, options, activeTheme, context) =>
        renderBashToolResult(result, options, activeTheme, context),
    };
    const bash = new ToolExecutionComponent(
      "bash",
      "control-call",
      {
        reasoning: "Compare\nupstream\ticon\u0007",
        command:
          "node \u001b[31m- <<'NODE'\u001b[0m\nconsole.log('\\u001b[31mred\\u001b[0m')\r\nNODE\t\u001b[31munsafe\u001b[0m",
      },
      {},
      bashDefinition,
      ui as never,
      process.cwd()
    );

    const rows = contentRows(bash, 100);
    expect(rows).toHaveLength(2);
    const forbidden = ["\n", "\r", "\t", "\u0007", "\u001b[31m"];
    expect(
      rows.every((line) =>
        forbidden.every((character) => !line.includes(character))
      )
    ).toBe(true);
    const plain = rows.map(stripVTControlCharacters);
    expect(plain[0]).toContain("Compare upstream icon");
    expect(plain[1]).toContain("node - <<'NODE' (+2 lines)");
    expect(plain[1]).not.toContain("unsafe");
  });

  test("uses Pi error context and error theme background", () => {
    const component = createFixture("Read broken target");
    component.updateResult(
      {
        content: [{ type: "text", text: "permission denied" }],
        details: { toolDisplay: { durationMs: 30 } },
        isError: true,
      },
      false
    );

    const rows = contentRows(component, 42);
    expect(rows).toHaveLength(2);
    expect(rows.join("\n")).toContain("permission denied");
    expect(
      rows.every((line) => line.includes(theme.getBgAnsi("toolErrorBg")))
    ).toBe(true);
    expectRowsFit(rows, 42);
  });
});
