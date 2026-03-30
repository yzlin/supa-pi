import { describe, expect, it } from "bun:test";

import {
  buildExecuteSummaryRenderText,
  chooseWaveConcurrency,
  parsePlanItems,
  parseWorkerResult,
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

describe("chooseWaveConcurrency", () => {
  it("uses parallelism for read-only looking work", () => {
    expect(chooseWaveConcurrency(["inspect prompt", "summarize agent"])).toBe(2);
  });

  it("falls back to serial execution for risky work", () => {
    expect(chooseWaveConcurrency(["fix refresh token bug"])).toBe(1);
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
    filesTouched: ["prompts/execute.md"],
    validation: ["read prompts/execute.md"],
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

  it("renders expanded sections and failures", () => {
    const expanded = buildExecuteSummaryRenderText(details, true);
    expect(expanded).toContain("Files touched");
    expect(expanded).toContain("• prompts/execute.md");
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

describe("parseWorkerResult", () => {
  it("accepts the expected JSON shape", () => {
    expect(
      parseWorkerResult(
        JSON.stringify({
          status: "done",
          summary: "Completed the step",
          filesTouched: ["prompts/execute.md"],
          validation: ["git diff --check"],
          followUps: [],
          blockers: [],
        })
      )
    ).toEqual({
      status: "done",
      summary: "Completed the step",
      filesTouched: ["prompts/execute.md"],
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
