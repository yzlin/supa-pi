import { afterEach, beforeAll, expect, test } from "bun:test";
import { stripVTControlCharacters } from "node:util";

import {
  highlightCode,
  initTheme,
  keyHint,
} from "@earendil-works/pi-coding-agent";
import { visibleWidth } from "@earendil-works/pi-tui";

import {
  defaultToolDisplayConfig,
  getToolDisplayPresetConfig,
  loadToolDisplayConfigFromLayers,
} from "./config";
import {
  cleanupToolDisplayTimers,
  type PresentationState,
  renderCompanionToolCall,
  renderCompanionToolResult,
  renderGenericToolResult,
} from "./presentation";

const tokens: Array<[string, string]> = [];
const theme = {
  fg(token: string, text: string) {
    tokens.push([token, text]);
    return text;
  },
  bg: (_token: string, text: string) => text.trimEnd(),
  bold: (text: string) => text,
};
beforeAll(() => {
  initTheme("dark", false);
});
afterEach(() => {
  cleanupToolDisplayTimers();
  tokens.length = 0;
});
const clean = (rows: string[]) => rows.map(stripVTControlCharacters);
const header = "Script completed\nWall time 1.234 seconds\nOutput:\n";
function setup(code = "const value = 1;", collapsed = true) {
  const state: PresentationState = {
    toolDisplayPresentation: { startedAt: Date.now() - 2500 },
  };
  const context = { args: { code }, state, invalidate() {} };
  const output = { ...defaultToolDisplayConfig().output.codemode, collapsed };
  const call = renderCompanionToolCall(
    "codemode",
    context.args,
    theme,
    context,
  );
  const result = (
    calls: unknown[],
    expanded = false,
    isPartial = false,
    isError = false,
    content = [
      { type: "text", text: header },
      { type: "text", text: "OUTPUT ONLY" },
    ],
  ) =>
    renderCompanionToolResult(
      "codemode",
      { content, details: { calls }, isError },
      { expanded, isPartial },
      theme,
      context,
      output,
    );
  return { context, output, call, result };
}
const nested = (
  status: "running" | "ok" | "error" | "cancelled",
  name = "read",
) => ({ id: name, name, args: '{"path":"a"}', status, durationMs: 1234 });

test("codemode top row updates pending live counts and settled bytes without duplicate summary", () => {
  const s = setup();
  expect(clean(s.call.render(150))[0]).toContain("codemode → running 2s");
  const partial = s.result([nested("running"), nested("ok")], false, true);
  expect(clean(s.call.render(150))[0]).toContain(
    "codemode 2 tool calls → running 2s",
  );
  expect(clean(partial.render(150)).join("\n")).not.toContain("bytes");
  const settled = s.result([nested("ok")]);
  const rows = clean([...s.call.render(150), ...settled.render(150)]);
  expect(rows[0]).toContain(
    `codemode 1 tool call · ${Buffer.byteLength(`${header}OUTPUT ONLY`)} bytes → done in 2s`,
  );
  expect(rows.filter((row) => row.includes("tool call ·"))).toHaveLength(1);
  expect(rows.every((row) => row.startsWith("┊"))).toBe(true);
  expect(rows.join("\n")).not.toContain("OUTPUT ONLY");
  s.result([], false, false, true);
  expect(clean(s.call.render(150))[0]).toContain("→ error in 2s");
  expect(clean(s.call.render(150))[0]).toStartWith("┊ ✗ 🧩 codemode");
  expect(tokens).toContainEqual(["error", "✗"]);
  expect(tokens).toContainEqual(["thinkingXhigh", "🧩"]);
  expect(visibleWidth("🧩")).toBe(2);
});

test("script is highlighted, normalized and capped at ten visual lines with public expansion hint", () => {
  const code = `${Array.from({ length: 12 }, (_, i) => `\tconst x${i} = ${i};\r`).join("\n")}\n\n`;
  const s = setup(code);
  const rows = s.call.render(120);
  expect(rows).toHaveLength(12);
  expect(clean(rows).at(-1)).toContain(
    `… (2 more lines, ${stripVTControlCharacters(keyHint("app.tools.expand", "to expand"))})`,
  );
  expect(rows[1]).toContain(
    highlightCode("    const x0 = 0;", "javascript")[0],
  );
  expect(rows.join("\n")).not.toContain("\r");
  const wrapped = setup(`const long = "${"x".repeat(500)}";`).call.render(24);
  expect(wrapped).toHaveLength(12);
  expect(clean(wrapped).at(-1)).toContain("…");
  expect(wrapped.every((row) => visibleWidth(row) <= 24)).toBe(true);
});

test("compact nested calls retain last eight, status colors and duration under width fitting", () => {
  const s = setup();
  const calls = Array.from({ length: 10 }, (_, i) =>
    nested(
      (["ok", "error", "running", "cancelled"] as const)[i % 4],
      `tool${i}`,
    ),
  );
  calls[9] = {
    ...calls[9],
    args: `\u001b[31m${"long ".repeat(50)}TAIL\n\t`,
    durationMs: 42,
  };
  const rows = clean(s.result(calls).render(40));
  expect(rows).toHaveLength(9);
  expect(rows[0]).toContain("2 earlier calls");
  expect(rows.join("\n")).not.toContain("tool0");
  expect(rows.at(-1)).toContain("TAIL 42ms");
  expect(rows.every((row) => visibleWidth(row) <= 40)).toBe(true);
  for (const entry of [
    ["success", "✓"],
    ["error", "✗"],
    ["warning", "…"],
    ["muted", "⊘"],
  ]) {
    expect(tokens).toContainEqual(entry);
  }
  expect(tokens).toContainEqual(["toolTitle", "tool9"]);
});

test("expanded view shows full code, every call, indented errors and output without exact first-block header", () => {
  const s = setup(
    Array.from({ length: 12 }, (_, i) => `line${i}();`).join("\n"),
  );
  const calls = Array.from({ length: 10 }, (_, i) => ({
    ...nested("error", `tool${i}`),
    error: "first error\nsecond error",
  }));
  const result = s.result(calls, true);
  // The result updates expansion in shared state so retained call components redraw too.
  const rows = clean([...s.call.render(120), ...result.render(120)]);
  const text = rows.join("\n");
  expect(text).toContain("line11();");
  expect(text).toContain("tool0");
  expect(text).toContain("┊       second error");
  expect(text).toContain("OUTPUT ONLY");
  expect(text).not.toContain("Wall time");
  expect(text).not.toContain("more lines");
  expect(rows.every((row) => row.startsWith("┊"))).toBe(true);
  expect(
    clean(s.result(calls, true, true).render(120)).join("\n"),
  ).not.toContain("OUTPUT ONLY");
  expect(
    clean(
      s
        .result([], true, false, false, [
          { type: "text", text: `${header}inline` },
        ])
        .render(120),
    ).join("\n"),
  ).toContain("Wall time");
  expect(
    clean(setup("code();", false).result([], false).render(120)).join("\n"),
  ).toContain("OUTPUT ONLY");
});

const injectedControls = [
  "\u0007",
  "\u0008",
  "\u0000",
  "\u007f",
  "\u0085",
  "\u001b]52;c;SGVsbG8=\u0007",
  "\u001b]52;c;SGVsbG8=\u001b\\",
  "\u001b[31m",
  "\u001b7",
];
const unsafeText = injectedControls.join("");
function expectSafeRows(rows: string[]) {
  const text = rows.join("\n");
  for (const control of injectedControls) {
    expect(text).not.toContain(control);
  }
  expect(text).not.toContain("SGVsbG8=");
}

test("codemode sanitizes script before highlighting in compact and expanded rows", () => {
  const s = setup(`\t// before${unsafeText}after\n\tconst safe = 1;`);
  for (const expanded of [false, true]) {
    s.result([], expanded);
    const rows = s.call.render(120);
    expectSafeRows(rows);
    expect(rows[1]).toContain(
      highlightCode("    // beforeafter", "javascript")[0],
    );
    expect(clean(rows)[2]).toContain("    const safe = 1;");
  }
});

test("codemode sanitizes expanded output before styling and preserves line indentation", () => {
  const s = setup();
  const rows = s
    .result([], true, false, false, [
      { type: "text", text: header },
      { type: "text", text: `before${unsafeText}after\n\tindented output` },
    ])
    .render(120);
  expectSafeRows(rows);
  expect(clean(rows).join("\n")).toContain(
    "beforeafter\n┊       indented output",
  );
  expect(tokens).toContainEqual([
    "toolOutput",
    "beforeafter\n    indented output",
  ]);
});

test("codemode sanitizes nested errors, names and args before styling", () => {
  const s = setup();
  const rows = s
    .result(
      [
        {
          ...nested("error", `before${unsafeText}after`),
          args: `arg${unsafeText}value`,
          error: `before${unsafeText}after\n\tindented error`,
        },
      ],
      true,
    )
    .render(120);
  expectSafeRows(rows);
  expect(clean(rows).join("\n")).toContain("beforeafter argvalue");
  expect(clean(rows).join("\n")).toContain("┊           indented error");
  expect(tokens).toContainEqual(["toolTitle", "beforeafter"]);
  expect(tokens).toContainEqual(["muted", "argvalue"]);
  expect(tokens).toContainEqual(["error", "    indented error"]);
});

test("missing calls still uses generic result and malformed nested entries do not throw", () => {
  const s = setup();
  const result = { content: [{ type: "text", text: "legacy" }], details: {} };
  expect(
    renderCompanionToolResult(
      "codemode",
      result,
      {},
      theme,
      s.context,
      s.output,
    ).render(120),
  ).toEqual(
    renderGenericToolResult(
      "codemode",
      result,
      {},
      theme,
      s.context,
      defaultToolDisplayConfig().output.fallback,
    ).render(120),
  );
  expect(() => s.result([null, {}, nested("ok")]).render(30)).not.toThrow();
});

test("codemode config has only enabled/collapsed, ignores stale previewLines with warnings across layers and presets", () => {
  const config = loadToolDisplayConfigFromLayers(
    {
      output: {
        codemode: { enabled: false, collapsed: false, previewLines: 3 },
      },
    },
    { output: { codemode: { enabled: true, previewLines: 2 } } },
  );
  expect(config.output.codemode).toEqual({ enabled: true, collapsed: false });
  expect(JSON.stringify(config)).toContain(
    "output.codemode.previewLines ignored",
  );
  for (const preset of ["compact", "verbose", "off"] as const) {
    expect(
      Object.keys(getToolDisplayPresetConfig(preset).output.codemode).sort(),
    ).toEqual(["collapsed", "enabled"]);
  }
});
