import { expect, test } from "bun:test";
import { stripVTControlCharacters } from "node:util";

import { visibleWidth } from "@earendil-works/pi-tui";

import {
  type CheckpointArgs,
  renderCheckpointCall,
  renderCheckpointResult,
} from "./render";
import type { Assignment, ExecutionLedger } from "./schema";

const theme = {
  bg: (_token: string, text: string) => text,
  bold: (text: string) => text,
  fg: (_token: string, text: string) => text,
};

function assignment(
  id: string,
  status: Assignment["status"],
  extra: Partial<Assignment> = {},
): Assignment {
  return {
    id,
    task: `Do ${id}`,
    scope: [`extensions/execute/${id}.ts`],
    dependencies: [],
    lineageId: id,
    repairCount: 0,
    supersededBy: null,
    status,
    attemptId: null,
    toolCallId: null,
    runId: null,
    report: null,
    evidence: [],
    blockers: [],
    ...extra,
  };
}

const ledger: ExecutionLedger = {
  version: 1,
  sessionId: "session",
  invocationId: "inv_1",
  plan: "1. schema\n2. render",
  approval: "approved",
  assignments: [
    assignment("schema", "completed", { evidence: ["types check"] }),
    assignment("render", "completed", {
      evidence: ["bun test (42 pass)", "diff reviewed"],
    }),
    assignment("ui", "running", { attemptId: "a1" }),
    assignment("docs", "pending", { dependencies: ["ui", "schema"] }),
    assignment("api", "blocked", { blockers: ["needs schema v2 decision"] }),
    assignment("old", "blocked", { supersededBy: "render" }),
  ],
};

function card(
  args: CheckpointArgs,
  result: Parameters<typeof renderCheckpointResult>[0],
  expanded = false,
  isError = false,
) {
  const context = { state: {}, args, isError };
  const call = renderCheckpointCall(args, theme, context);
  const body = renderCheckpointResult(result, { expanded }, theme, context);
  const lines = [...call.render(80), ...body.render(80)];
  return {
    lines,
    text: stripVTControlCharacters(lines.join("\n")),
  };
}
const ok = (dispatchPrefix: string | null = null) => ({
  content: [{ type: "text", text: JSON.stringify({ ledger, dispatchPrefix }) }],
});

test("pending call shows action and target", () => {
  const lines = renderCheckpointCall(
    { action: "start", assignmentId: "ui" },
    theme,
    { state: {} },
  ).render(80);
  expect(stripVTControlCharacters(lines.join("\n"))).toBe(
    `┊ • 🎯 checkpoint start ui → pending`.padEnd(80),
  );
});

test("collapsed verify is one line with outcome and effective progress", () => {
  const args: CheckpointArgs = {
    action: "verify",
    assignmentId: "render",
    passed: true,
    evidence: ["bun test (42 pass)"],
  };
  const { lines, text } = card(args, ok());
  expect(lines).toHaveLength(1);
  expect(text).toMatch(/✓ 🎯 checkpoint verify render → passed · 2\/5/u);
  expect(visibleWidth(lines[0] ?? "")).toBe(80);
});

test("expanded verify shows evidence and the ledger board", () => {
  const args: CheckpointArgs = {
    action: "verify",
    assignmentId: "render",
    passed: true,
    evidence: ["bun test (42 pass)", "diff reviewed"],
  };
  const { lines, text } = card(args, ok(), true);
  expect(text).toContain("┊   evidence: bun test (42 pass) · diff reviewed");
  expect(text).toMatch(
    /● render\s+extensions\/execute\/render\.ts\s+✓ bun test/u,
  );
  expect(text).toMatch(/◐ ui\s+\S+\s+attempt a1/u);
  expect(text).toMatch(/○ docs\s+\S+\s+needs: ui\s*$/mu);
  expect(text).toMatch(/✗ api\s+\S+\s+needs schema v2 decision/u);
  expect(text).not.toContain("old");
  expect(lines.map((line) => visibleWidth(line))).toEqual(lines.map(() => 80));
});

test("start, block and accept summarize their action", () => {
  expect(
    card({ action: "start", assignmentId: "ui" }, ok("[execute] prefix")).text,
  ).toContain("start ui → running · prefix issued · 2/5");
  expect(
    card({ action: "block", assignmentId: "api", blockers: ["needs v2"] }, ok())
      .text,
  ).toContain('block api → "needs v2" · 2/5');
  const accept = card(
    { action: "accept", assignments: [{}, {}], plan: ledger.plan ?? "" },
    ok(),
    true,
  ).text;
  expect(accept).toContain("accept 2 assignments → accepted · 2/5");
  expect(accept).toMatch(/┊ {3}plan: 1\. schema\s+┊ {3}2\. render/u);
});

test("structuredContent is preferred over content", () => {
  const { text } = card(
    { action: "inspect" },
    {
      content: [{ type: "text", text: "not json" }],
      structuredContent: { ledger, dispatchPrefix: null },
    },
  );
  expect(text).toContain("inspect → ledger · 2/5");
});

test("errors show the message even when collapsed", () => {
  const { text } = card(
    { action: "start", assignmentId: "ui" },
    { content: [{ type: "text", text: "Unauthorized checkpoint" }] },
    false,
    true,
  );
  expect(text).toContain("✗ 🎯 checkpoint start ui → failed");
  expect(text).toContain("┊   Unauthorized checkpoint");
});
