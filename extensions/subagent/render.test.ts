import { expect, setSystemTime, test } from "bun:test";
import { stripVTControlCharacters } from "node:util";

import { visibleWidth } from "@earendil-works/pi-tui";

import { renderSubagentCall, renderSubagentResult } from "./render";
import { paneActivity } from "./runner";

const theme = {
  bg: (_token: string, text: string) => text,
  bold: (text: string) => text,
  fg: (_token: string, text: string) => text,
};
const args = {
  agent: "reviewer",
  task: "Review runner.ts\nfor races",
  thinking: "high",
};
const final = {
  runId: "3f9c2a71-8e4b-4d0a-9b7e-1c2d3e4f5a6b",
  provider: "anthropic",
  model: "claude-sonnet-5-5",
  thinking: "high",
  output: Array.from({ length: 8 }, (_, index) => `finding ${index + 1}`).join(
    "\n",
  ),
  resultPath: "/tmp/evidence/result.json",
  durationMs: 94_000,
};

function card(
  result: Parameters<typeof renderSubagentResult>[0],
  options = { expanded: false, isPartial: false },
  isError = false,
) {
  const context = { state: {}, isError };
  const call = renderSubagentCall(args, theme, context);
  const body = renderSubagentResult(result, options, theme, context);
  const lines = [...call.render(80), ...body.render(80)];
  return {
    lines,
    text: stripVTControlCharacters(lines.join("\n")),
  };
}

test("running card shows identity, task, newest pane lines, and attach", () => {
  const { lines, text } = card(
    {
      content: [],
      details: {
        runId: "run",
        status: "running",
        text: "one\n\ntwo\nthree\nfour",
        attachCommand: "pi --attach-subagent run",
      },
    },
    { expanded: false, isPartial: true },
  );
  expect(text).toMatch(/• 🤖 subagent reviewer · high → running <1s/u);
  expect(text).toContain("┊   Review runner.ts for races");
  expect(text).not.toContain("│ one");
  expect(text).toMatch(/│ two\s+│ three\s+│ four/u);
  expect(text).toContain("attach: pi --attach-subagent run");
  expect(lines.map((line) => visibleWidth(line))).toEqual(lines.map(() => 80));
});

test("queued card shows status without a body", () => {
  const { text } = card(
    { content: [], details: { runId: "run", status: "queued", text: "wait" } },
    { expanded: false, isPartial: true },
  );
  expect(text).toContain("→ queued for a slot");
  expect(text.split("\n")).toHaveLength(2);
});

test("done card shows the report first and metadata only when expanded", () => {
  const collapsed = card({ content: [], details: final }).text;
  expect(collapsed).toMatch(
    /✓ 🤖 subagent reviewer · claude-sonnet-5-5 high → done in 1m 34s/u,
  );
  expect(collapsed).toContain("finding 5");
  expect(collapsed).not.toContain("finding 6");
  expect(collapsed).toContain("… 3 more lines (Ctrl+O to expand)");
  expect(collapsed).not.toContain(final.runId);
  expect(collapsed).not.toContain(final.resultPath);

  const expanded = card(
    { content: [], details: final },
    { expanded: true, isPartial: false },
  ).text;
  expect(expanded).toContain("finding 8");
  expect(expanded).toContain(`run      ${final.runId}`);
  expect(expanded).toContain("anthropic/claude-sonnet-5-5 (high)");
  expect(expanded).toContain(`evidence ${final.resultPath}`);
});

test("expanded metadata preserves long paths at narrow widths", () => {
  const resultPath =
    "/Users/reviewer/.pi/agent/subagents/parent-session/run-with-long-identifier/result.json";
  const sessionFile =
    "/Users/reviewer/.pi/agent/subagents/parent-session/run-with-long-identifier/session/child-session.jsonl";
  const body = renderSubagentResult(
    { content: [], details: { ...final, resultPath, sessionFile } },
    { expanded: true, isPartial: false },
    theme,
    { state: {} },
  );
  const lines = body.render(40).map((row) => stripVTControlCharacters(row));
  const text = lines.join("").replace(/\s/gu, "");
  expect(text).toContain(resultPath);
  expect(text).toContain(sessionFile);
  for (const row of lines) {
    expect(row).not.toContain("…");
    expect(visibleWidth(row)).toBe(40);
  }
});

test("failed card shows the error text", () => {
  const { text } = card(
    { content: [{ type: "text", text: 'Unknown agent "reviewr"' }] },
    { expanded: false, isPartial: false },
    true,
  );
  expect(text).toMatch(/✗ 🤖 subagent reviewer · high → failed after/u);
  expect(text).toContain('Unknown agent "reviewr"');
});

test("failed card duration stays fixed after expansion", () => {
  try {
    setSystemTime(new Date("2026-01-01T00:00:00Z"));
    const context = { state: {}, isError: true };
    const call = renderSubagentCall(args, theme, context);
    const result = { content: [{ type: "text", text: "Subagent failed." }] };
    setSystemTime(new Date("2026-01-01T00:00:03Z"));
    renderSubagentResult(
      result,
      { expanded: false, isPartial: false },
      theme,
      context,
    );
    const header = stripVTControlCharacters(call.render(80)[0]);
    expect(header).toContain("failed after 3s");

    setSystemTime(new Date("2026-01-01T00:01:03Z"));
    renderSubagentResult(
      result,
      { expanded: true, isPartial: false },
      theme,
      context,
    );
    expect(stripVTControlCharacters(call.render(80)[0])).toBe(header);
  } finally {
    setSystemTime();
  }
});

test("pane activity drops the child's trailing editor box", () => {
  const capture = [
    " Hello there",
    " Red",
    "",
    "╭ │ Opus 5.5 │ think:med ──── 4.7% ╮",
    "│                                  │",
    "╰──────────────────────── tmp.abc ╯",
    "",
  ].join("\n");
  expect(paneActivity(capture)).toBe("Hello there\n Red");
  expect(paneActivity("a\n╭ not closed")).toBe("a\n╭ not closed");
  expect(
    paneActivity(Array.from({ length: 30 }, (_, i) => `l${i}`).join("\n")),
  ).toBe(Array.from({ length: 18 }, (_, i) => `l${i + 12}`).join("\n"));
});
