import { expect, setSystemTime, test } from "bun:test";

import type { AgentToolResult } from "@earendil-works/pi-agent-core";

import {
  REVIEW_PROGRESS_FLUSH_MS,
  ReviewProgress,
  type ReviewProgressDetails,
} from "./progress";
import { renderReviewRunResult, reviewProgressLines } from "./progress-render";

const theme = {
  bold: (text: string) => text,
  fg: (_token: string, text: string) => text,
};
const attach = (id: string) => `pi --attach-subagent ${id}`;
const running = (id: string, text: string) => ({
  runId: id,
  status: "running",
  text,
  attachCommand: attach(id),
});

function collect() {
  const updates: ReviewProgressDetails[] = [];
  const progress = new ReviewProgress((update: AgentToolResult<unknown>) => {
    updates.push(update.details as ReviewProgressDetails);
  });
  return { updates, progress };
}

test("one panel keeps every concurrent child and its attach command", () => {
  const { updates, progress } = collect();
  const a = progress.add("code-reviewer", "openai/gpt-5.5", "high");
  const b = progress.add("security-reviewer", "anthropic/opus", "medium");
  progress.childUpdate(a, running("aaa", "one\ntwo\nthree\nfour"));
  progress.childUpdate(b, running("bbb", "scan"));
  const last = updates.at(-1)?.reviewProgress ?? [];
  expect(last.map((row) => row.attachCommand)).toEqual([
    attach("aaa"),
    attach("bbb"),
  ]);
  expect(last[0]?.tail).toEqual(["two", "three", "four"]);
  progress.dispose();
});

test("pane churn is coalesced; status changes flush immediately", async () => {
  const { updates, progress } = collect();
  const a = progress.add("code-reviewer", "m", "high");
  progress.childUpdate(a, running("aaa", "start"));
  const afterStatus = updates.length;
  for (let index = 0; index < 20; index += 1) {
    progress.childUpdate(a, running("aaa", `tick ${index}`));
  }
  expect(updates.length).toBe(afterStatus);
  await Bun.sleep(REVIEW_PROGRESS_FLUSH_MS + 50);
  expect(updates.length).toBe(afterStatus + 1);
  expect(updates.at(-1)?.reviewProgress[0]?.tail).toEqual(["tick 19"]);
  progress.settle(a, false);
  expect(updates.at(-1)?.reviewProgress[0]).toMatchObject({
    status: "done",
    tail: [],
  });
  progress.dispose();
});

test("rendered rows hold a stable layout with copyable attach lines", () => {
  setSystemTime(new Date(10_000));
  const rows: ReviewProgressDetails["reviewProgress"] = [
    {
      agent: "code-reviewer",
      model: "openai/gpt-5.5",
      thinking: "high",
      status: "running",
      startedAt: 0,
      tail: ["read a.ts", "read b.ts", "thinking"],
      attachCommand: attach("aaa"),
    },
    {
      agent: "test-reviewer",
      model: "google/gemini",
      thinking: "high",
      status: "done",
      durationMs: 58_000,
      tail: [],
    },
    {
      agent: "style",
      model: "m",
      thinking: "low",
      status: "queued",
      tail: [],
    },
  ];
  const lines = reviewProgressLines(rows, 100, theme);
  expect(lines).toEqual([
    "3 children · 1 done · 1 running · 1 pending",
    "• code-reviewer  openai/gpt-5.5 high  → running 10s",
    "    │ read a.ts",
    "    │ read b.ts",
    "    │ thinking",
    `    ${attach("aaa")}`,
    "✓ test-reviewer  google/gemini high  → done in 58s",
    "· style          m low  → queued for a slot",
  ]);
  // Narrow terminals still show the full command, wrapped, never truncated.
  const narrow = reviewProgressLines(rows, 30, theme)
    .join("")
    .replace(/\s/g, "");
  expect(narrow).toContain(attach("aaa").replace(/\s/g, ""));
  setSystemTime();
});

test("final result keeps the panel above the completion text", () => {
  const state = {};
  const details: ReviewProgressDetails = {
    reviewProgress: [
      {
        agent: "code-reviewer",
        model: "m",
        thinking: "high",
        status: "done",
        durationMs: 2000,
        tail: [],
      },
    ],
  };
  const lines = renderReviewRunResult(
    { content: [{ type: "text", text: "Review run complete." }], details },
    { isPartial: false },
    theme,
    { state },
  ).render(80);
  expect(lines).toEqual([
    "1 children · 1 done · 0 running",
    "✓ code-reviewer  m high  → done in 2s",
    "Review run complete.",
  ]);
});
