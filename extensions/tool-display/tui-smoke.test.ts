import { afterEach, beforeAll, describe, expect, test } from "bun:test";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { setTimeout as sleep } from "node:timers/promises";
import { stripVTControlCharacters } from "node:util";

import type {
  ExtensionAPI,
  ToolRenderers,
} from "@earendil-works/pi-coding-agent";
import { visibleWidth } from "@earendil-works/pi-tui";

import { ToolExecutionComponent } from "../../node_modules/@earendil-works/pi-coding-agent/dist/modes/interactive/components/tool-execution.js";
import {
  initTheme,
  theme,
} from "../../node_modules/@earendil-works/pi-coding-agent/dist/modes/interactive/theme/theme.js";
import { companionFixtures } from "./companion-fixtures";
import toolDisplayExtension from "./index";
import { cleanupToolDisplayTimers } from "./presentation";

const ui = {
  requestRender() {
    // Deterministic smoke renders synchronously.
  },
};

function resolvedRenderers(name: string): ToolRenderers | undefined {
  let resolver: Parameters<ExtensionAPI["registerToolRenderer"]>[0] | undefined;
  const pi = Object.create(null) as ExtensionAPI;
  Object.assign(pi, {
    on() {},
    registerCommand() {},
    registerTool() {},
    registerToolRenderer(
      value: Parameters<ExtensionAPI["registerToolRenderer"]>[0],
    ) {
      resolver = value;
    },
  });
  toolDisplayExtension(pi);
  return resolver?.(name, () => undefined);
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
    resolvedRenderers("read"),
    ui as never,
    process.cwd(),
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
        pending.every((line) =>
          line.includes(theme.getBgAnsi("toolPendingBg")),
        ),
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
      false,
    );
    const settled = contentRows(component, 64);
    expect(settled).toHaveLength(2);
    expect(settled.join("\n")).toContain("full read skills");
    expect(settled.join("\n")).toContain("[pagination ignored]");
    expect(
      settled.every((line) => line.includes(theme.getBgAnsi("toolSuccessBg"))),
    ).toBe(true);
    expectRowsFit(settled, 64);

    component.setExpanded(true);
    const expanded = contentRows(component, 37);
    expect(expanded.slice(0, 2)).toHaveLength(2);
    expect(
      expanded.slice(2).map(stripVTControlCharacters).join("\n"),
    ).toContain("one");
    expect(
      expanded.slice(2).map(stripVTControlCharacters).join("\n"),
    ).toContain("two");
    expectRowsFit(expanded, 37);
  });

  test("keeps bash and file tools pending across partial results, then settles final", () => {
    const read = createFixture("Stream file");
    read.updateResult(
      { content: [{ type: "text", text: "one" }], isError: false },
      true,
    );
    expect(contentRows(read, 64)).toHaveLength(3);
    expect(contentRows(read, 64).join("\n")).toContain("📖");
    expect(
      contentRows(read, 64).every((line) =>
        line.includes(theme.getBgAnsi("toolPendingBg")),
      ),
    ).toBe(true);
    read.updateResult(
      { content: [{ type: "text", text: "one\ntwo" }], isError: false },
      false,
    );
    expect(contentRows(read, 64)).toHaveLength(2);
    expect(
      contentRows(read, 64).every((line) =>
        line.includes(theme.getBgAnsi("toolSuccessBg")),
      ),
    ).toBe(true);

    const bash = new ToolExecutionComponent(
      "bash",
      "bash-call",
      {
        reasoning: "Stream command",
        command: "printf one\nsleep 20\necho hidden-tail",
      },
      {},
      resolvedRenderers("bash"),
      ui as never,
      process.cwd(),
    );
    bash.updateResult(
      { content: [{ type: "text", text: "one" }], isError: false },
      true,
    );
    const pendingBashRows = contentRows(bash, 64);
    const pendingBashText = pendingBashRows.join("\n");
    expect(pendingBashRows).toHaveLength(2);
    expect(pendingBashText).toContain("⚡");
    expect(pendingBashText).toContain("printf one (+2 lines)");
    expect(pendingBashText).not.toContain("hidden-tail");
    expect(
      pendingBashRows.every((line) =>
        line.includes(theme.getBgAnsi("toolPendingBg")),
      ),
    ).toBe(true);
    bash.updateResult(
      { content: [{ type: "text", text: "done" }], isError: false },
      false,
    );
    const settledBashRows = contentRows(bash, 64);
    expect(settledBashRows).toHaveLength(2);
    expect(
      settledBashRows.every((line) =>
        line.includes(theme.getBgAnsi("toolSuccessBg")),
      ),
    ).toBe(true);
  });

  test("sanitizes multiline and terminal-control bash headers", () => {
    const bash = new ToolExecutionComponent(
      "bash",
      "control-call",
      {
        reasoning: "Compare\nupstream\ticon\u0007",
        command:
          "node \u001b[31m- <<'NODE'\u001b[0m\nconsole.log('\\u001b[31mred\\u001b[0m')\r\nNODE\t\u001b[31munsafe\u001b[0m",
      },
      {},
      resolvedRenderers("bash"),
      ui as never,
      process.cwd(),
    );

    const rows = contentRows(bash, 100);
    expect(rows).toHaveLength(2);
    const forbidden = ["\n", "\r", "\t", "\u0007", "\u001b[31m"];
    expect(
      rows.every((line) =>
        forbidden.every((character) => !line.includes(character)),
      ),
    ).toBe(true);
    const plain = rows.map(stripVTControlCharacters);
    expect(plain[0]).toContain("Compare upstream icon");
    expect(plain[1]).toContain("node - <<'NODE' (+2 lines)");
    expect(plain[1]).not.toContain("unsafe");
  });

  test("renders strict edit planned preview then replaces it with final diff", async () => {
    const cwd = join(
      import.meta.dir,
      `.tmp-tui-edit-${Date.now()}-${Math.random()}`,
    );
    mkdirSync(cwd, { recursive: true });
    writeFileSync(join(cwd, "target.txt"), "old\n");
    try {
      const component = new ToolExecutionComponent(
        "edit",
        "edit-call",
        { text: "[target.txt]\n@REPLACE\n-old\n+planned" },
        {},
        resolvedRenderers("edit"),
        ui as never,
        cwd,
      );
      component.setArgsComplete();
      component.setExpanded(true);
      await sleep(30);
      const planned = contentRows(component, 64);
      expect(planned.join("\n")).toContain("Apply row edit · 1 file");
      expect(planned.join("\n")).toContain("planned diff");
      expectRowsFit(planned, 64);

      component.updateResult(
        {
          content: [{ type: "text", text: "done" }],
          details: {
            diff: "--- target.txt\n+++ target.txt\n@@ -1 +1 @@\n-old\n+FINAL",
            files: ["target.txt"],
            toolDisplay: { durationMs: 50 },
          },
          isError: false,
        },
        false,
      );
      const final = contentRows(component, 64);
      expect(final.join("\n")).toContain("FINAL");
      expect(final.join("\n")).not.toContain("planned diff");
      expect(
        final.every((line) => line.includes(theme.getBgAnsi("toolSuccessBg"))),
      ).toBe(true);
      expectRowsFit(final, 64);
    } finally {
      rmSync(cwd, { force: true, recursive: true });
    }
  });

  test("draws the remaining owned names without execution registrations", () => {
    for (const [name, icon] of [
      ["grep", "🔍"],
      ["find", "🔍"],
      ["ls", "📁"],
      ["write", "📄"],
    ]) {
      const component = new ToolExecutionComponent(
        name,
        `${name}-call`,
        { path: "a.ts", pattern: "needle", content: "new\n" },
        {},
        resolvedRenderers(name),
        ui as never,
        process.cwd(),
      );
      expect(contentRows(component, 64)).toHaveLength(2);
      expect(contentRows(component, 64)[0]).toContain(icon);
      for (const width of [16, 28, 64]) {
        expectRowsFit(contentRows(component, width), width);
      }
      component.updateResult(
        {
          content: [
            { type: "text", text: name === "grep" ? "a.ts:1:needle" : "a.ts" },
          ],
          details: {
            toolDisplay: {
              writeDiff: "--- a.ts\n+++ a.ts\n@@ -1 +1 @@\n-old\n+new",
            },
          },
          isError: false,
        },
        false,
      );
      const rows = contentRows(component, 64);
      expect(rows).toHaveLength(2);
      expectRowsFit(rows, 64);
      expect(rows.join("\n")).toContain(name);
      component.setExpanded(true);
      expect(contentRows(component, 64).length).toBeGreaterThan(2);
    }
  });

  test("renders an unregistered MCP tool through the fallback resolver", () => {
    const component = new ToolExecutionComponent(
      "mcp__figma__get_file",
      "resumed-call",
      { key: "abc" },
      {},
      resolvedRenderers("mcp__figma__get_file"),
      ui as never,
      process.cwd(),
    );
    const pending = contentRows(component, 64);
    expect(pending).toHaveLength(2);
    expectRowsFit(pending, 64);
    expect(pending.join("\n")).toContain("mcp__figma__get_file");
    expect(pending.join("\n")).not.toContain("undefined");
    component.updateResult(
      {
        content: [{ type: "text", text: "file body" }],
        details: { toolDisplay: { durationMs: 1200 } },
        isError: false,
      },
      false,
    );
    const settled = contentRows(component, 64);
    expect(settled.join("\n")).toContain("file body");
    expect(settled.join("\n")).toContain("1s");
    expectRowsFit(settled, 64);
    expect(
      settled.every((line) => line.includes(theme.getBgAnsi("toolSuccessBg"))),
    ).toBe(true);
    component.setExpanded(true);
    expect(contentRows(component, 37).join("\n")).toContain("file body");
  });

  test("uses Pi error context and error theme background", () => {
    const component = createFixture("Read broken target");
    component.updateResult(
      {
        content: [{ type: "text", text: "permission denied" }],
        details: { toolDisplay: { durationMs: 30 } },
        isError: true,
      },
      false,
    );

    const rows = contentRows(component, 42);
    expect(rows).toHaveLength(2);
    expect(rows.join("\n")).toContain("permission denied");
    expect(stripVTControlCharacters(rows[0])).toStartWith("┊ ✗ 📖 read");
    expect(
      rows.every((line) => line.includes(theme.getBgAnsi("toolErrorBg"))),
    ).toBe(true);
    expectRowsFit(rows, 42);
  });
});

describe("companion ToolExecutionComponent smoke", () => {
  test("companion tools keep themed states and expandable content", () => {
    for (const fixture of companionFixtures) {
      const component = new ToolExecutionComponent(
        fixture.name,
        `companion-${fixture.name}`,
        fixture.args,
        {},
        resolvedRenderers(fixture.name),
        ui as never,
        process.cwd(),
      );
      for (const width of [36, 120]) {
        const rows = contentRows(component, width);
        const icon = { mcp: "🔌", codemode: "🧩", web: "🌐" }[fixture.group];
        expect(rows[0]).toContain(icon);
        if (fixture.name === "codemode") {
          expect(rows.length).toBeGreaterThan(2);
        } else {
          expect(rows).toHaveLength(2);
        }
        expectRowsFit(rows, width);
        expect(
          rows.every((line) => line.includes(theme.getBgAnsi("toolPendingBg"))),
        ).toBe(true);
      }
      component.updateResult({ content: [], details: fixture.details }, true);
      if (fixture.name === "codemode") {
        expect(
          contentRows(component, 120)[0] &&
            stripVTControlCharacters(contentRows(component, 120)[0]),
        ).toContain("1 tool call → running");
      } else {
        expect(contentRows(component, 120)).toHaveLength(2);
      }
      component.updateResult(
        {
          content: [{ type: "text", text: fixture.text }],
          details: fixture.details,
        },
        false,
      );
      const settled = contentRows(component, 120);
      if (fixture.name === "codemode") {
        expect(settled.length).toBeGreaterThan(2);
        expect(stripVTControlCharacters(settled[0])).toContain(
          "codemode 1 tool call · 23 bytes → done",
        );
        expect(settled.map(stripVTControlCharacters).join("\n")).toContain(
          "✓ read",
        );
        expect(settled.map(stripVTControlCharacters).join("\n")).not.toContain(
          "Script completed",
        );
      } else {
        expect(settled).toHaveLength(2);
      }
      expectRowsFit(settled, 120);
      expect(
        settled.every((line) =>
          line.includes(theme.getBgAnsi("toolSuccessBg")),
        ),
      ).toBe(true);
      expect(settled.map(stripVTControlCharacters).join("\n")).toContain(
        fixture.summary,
      );
      component.setExpanded(true);
      const expanded = contentRows(component, 120);
      expect(expanded.length).toBeGreaterThan(2);
      expectRowsFit(expanded, 120);
      expect(expanded.map(stripVTControlCharacters).join("\n")).toContain(
        fixture.text.split("\n")[0],
      );
      if (fixture.name === "codemode") {
        expect(expanded.map(stripVTControlCharacters).join("\n")).toContain(
          "console.log(x)",
        );
      }
      component.updateResult(
        {
          content: [{ type: "text", text: "Failed" }],
          details: { error: "Failed" },
          isError: true,
        },
        false,
      );
      expect(
        contentRows(component, 120).every((line) =>
          line.includes(theme.getBgAnsi("toolErrorBg")),
        ),
      ).toBe(true);
    }
  });
});

test("codemode TUI shares a single live summary and expands fixed previews with clean output", () => {
  const code = Array.from({ length: 12 }, (_, i) => `const x${i} = ${i};`).join(
    "\n",
  );
  const calls = Array.from({ length: 10 }, (_, i) => ({
    id: `nested-${i}`,
    name: `tool${i}`,
    args: `{"path":"${"a".repeat(80)}tail"}`,
    status: i === 9 ? "error" : "ok",
    durationMs: 1234,
    ...(i === 9 ? { error: "first failure\nsecond failure" } : {}),
  }));
  const component = new ToolExecutionComponent(
    "codemode",
    "codemode-preview",
    { code },
    {},
    resolvedRenderers("codemode"),
    ui as never,
    process.cwd(),
  );
  component.updateResult({ content: [], details: { calls } }, true);
  let rows = contentRows(component, 120).map(stripVTControlCharacters);
  expect(rows[0]).toContain("codemode 10 tool calls → running");
  expect(rows.join("\n")).toContain("2 more lines");
  expect(rows.join("\n")).toContain("2 earlier calls");
  expect(rows.join("\n")).not.toContain("bytes");
  for (const width of [36, 120]) {
    const fitted = contentRows(component, width);
    expectRowsFit(fitted, width);
    expect(fitted.map(stripVTControlCharacters).join("\n")).toContain("1.2s");
  }
  const result = {
    content: [
      {
        type: "text" as const,
        text: "Script failed\nWall time 1.2 seconds\nOutput:\n",
      },
      { type: "text" as const, text: "unique full output" },
    ],
    details: { calls },
    isError: true,
  };
  component.updateResult(result, false);
  rows = contentRows(component, 120).map(stripVTControlCharacters);
  expect(rows[0]).toContain("→ error in");
  expect(rows[0]).toStartWith("┊ ✗ 🧩 codemode");
  expect(rows.filter((row) => row.includes("10 tool calls"))).toHaveLength(1);
  expect(rows.join("\n")).not.toContain("unique full output");
  component.setExpanded(true);
  rows = contentRows(component, 120).map(stripVTControlCharacters);
  expect(rows.join("\n")).toContain("const x11 = 11;");
  expect(rows.join("\n")).toContain("tool0");
  expect(rows.join("\n")).toContain("┊       second failure");
  expect(rows.join("\n")).toContain("unique full output");
  expect(rows.join("\n")).not.toContain("Wall time");
  expect(rows.every((row) => row.startsWith("┊"))).toBe(true);
});
