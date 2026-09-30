import { describe, expect, it } from "bun:test";

import {
  deriveJournalReviewResult,
  derivePreparedReviewResult,
} from "./finalization";
import type { PublicReviewWorkflowInput } from "./public-workflow";

const prepared: PublicReviewWorkflowInput = {
  scopeHint: "src snapshot",
  invocationPacket: "Review src",
  reviewers: ["code-reviewer"],
  reviewerPanel: [
    { model: "test/alpha", thinkingLevel: "medium" },
    { model: "test/beta", thinkingLevel: "high" },
  ],
  synthesizerModel: "test/synthesizer",
  verifierModel: "test/verifier",
};
const finding = {
  priority: "P1",
  title: "Unsafe default",
  file: "src/example.ts",
  line: 7,
  why: "Invalid state is accepted.",
  change: "Reject invalid state.",
};
function raw(findings = [finding]) {
  return {
    reviewerRuns: prepared.reviewerPanel.map((entry) => ({
      reviewer: "code-reviewer",
      ...entry,
      status: "succeeded",
      output: {
        reviewer: "code-reviewer",
        verdict: findings.length ? "needs attention" : "correct",
        findings,
        humanReviewerCallouts: ["Check rollout"],
      },
    })),
    ...(findings.length
      ? {
          synthesizerOutput: {
            clusters: [
              {
                memberIds: ["candidate-0001", "candidate-0002"],
                title: finding.title,
                why: finding.why,
                change: finding.change,
              },
            ],
          },
          verifierOutput: {
            reviewScope: ["src snapshot"],
            verdict: "needs attention",
            findings: [
              {
                memberIds: ["candidate-0001", "candidate-0002"],
                priority: "P1",
                title: finding.title,
                why: finding.why,
                change: finding.change,
                confidence: "high",
                reason: "The changed code accepts invalid state.",
                consensusEffect: "raised-one-level",
              },
            ],
          },
        }
      : {}),
  };
}
function derive(value: unknown, plan = prepared) {
  return derivePreparedReviewResult(plan, JSON.stringify(value));
}

describe("prepared review raw result derivation", () => {
  it("recomputes candidate IDs, provenance, coverage and support", () => {
    const result = derive(raw());
    expect(result.candidates.map((candidate) => candidate.candidateId)).toEqual(
      ["candidate-0001", "candidate-0002"],
    );
    expect(result.verifier.findings[0]?.supportingModels).toEqual([
      "test/alpha",
      "test/beta",
    ]);
    expect(result.verifier.findings[0]?.supportCount).toBe(2);
    expect(result.coverage.degraded).toBe(false);
    expect(result.coverage.callPlan.synthesizer?.model).toBe(
      "test/synthesizer",
    );
  });

  it("skips downstream stages for a clean review", () => {
    const result = derive(raw([]));
    expect(result.verifier.verdict).toBe("correct");
    expect(result.verifier.reviewScope).toEqual(["src snapshot"]);
    expect(result.clusters).toEqual([]);
    expect(result.coverage.callPlan.synthesizer).toBeUndefined();
    expect(result.coverage.callPlan.verifier).toBeUndefined();
    expect(() =>
      derive({ ...raw([]), synthesizerOutput: { clusters: [] } }),
    ).toThrow();
  });

  it("allows degraded coverage but requires success for each selected role", () => {
    const value = raw([]);
    value.reviewerRuns[0].status = "failed";
    Reflect.deleteProperty(value.reviewerRuns[0], "output");
    const result = derive(value);
    expect(result.coverage.degraded).toBe(true);
    expect(result.reviewerOutputs).toHaveLength(1);
    value.reviewerRuns[1].status = "failed";
    Reflect.deleteProperty(value.reviewerRuns[1], "output");
    expect(() => derive(value)).toThrow("No successful model run");
  });

  it("revalidates raw reviewer semantics and suppresses provider errors", () => {
    const value = raw([]);
    value.reviewerRuns[0].output.reviewer = "security-reviewer";
    expect(derive(value).coverage.degraded).toBe(true);
    const injected = {
      ...value,
      reviewerRuns: value.reviewerRuns.map((run) => ({
        ...run,
        status: "failed",
        error: "provider secret token",
      })),
    };
    try {
      derive(injected);
      throw new Error("Expected rejection");
    } catch (error) {
      expect(String(error)).not.toContain("provider secret token");
      expect(String(error)).toContain("Invalid raw review result");
    }
  });

  it("rejects missing, extra, reordered and misidentified role/model runs", () => {
    const value = raw([]);
    for (const reviewerRuns of [
      value.reviewerRuns.slice(1),
      [...value.reviewerRuns, value.reviewerRuns[0]],
      [...value.reviewerRuns].reverse(),
      value.reviewerRuns.map((run) => ({
        ...run,
        reviewer: "security-reviewer",
      })),
      value.reviewerRuns.map((run) => ({ ...run, thinkingLevel: "off" })),
    ]) {
      expect(() => derive({ reviewerRuns })).toThrow();
    }
  });

  it("rejects caller-derived fields rather than accepting report authority", () => {
    for (const key of [
      "candidates",
      "coverage",
      "verifier",
      "report",
      "verdict",
    ]) {
      expect(() => derive({ ...raw(), [key]: [] })).toThrow(
        "Invalid raw review result",
      );
    }
  });

  it("rejects invalid, repeated and lossy downstream IDs without retries", () => {
    for (const memberIds of [
      [],
      ["invented"],
      ["candidate-0001"],
      ["candidate-0001", "candidate-0001"],
    ]) {
      const value = raw();
      if (value.synthesizerOutput) {
        value.synthesizerOutput.clusters[0].memberIds = memberIds;
      }
      expect(() => derive(value)).toThrow("Invalid synthesizer output");
    }
    for (const memberIds of [
      ["invented"],
      ["candidate-0001", "candidate-0001"],
    ]) {
      const value = raw();
      if (value.verifierOutput) {
        value.verifierOutput.findings[0].memberIds = memberIds;
      }
      expect(() => derive(value)).toThrow("Invalid verifier output");
    }
    const missing = raw();
    Reflect.deleteProperty(missing, "verifierOutput");
    expect(() => derive(missing)).toThrow("Invalid verifier output");
  });

  it("bounds payload bytes, nested data, arrays and strings", () => {
    for (const json of [
      "{",
      " ".repeat(1_048_577),
      JSON.stringify({ reviewerRuns: new Array(257).fill(null) }),
    ]) {
      expect(() => derivePreparedReviewResult(prepared, json)).toThrow(
        "Invalid raw review result",
      );
    }
    expect(() => derive({ ...raw([]), extra: "x".repeat(16_385) })).toThrow();
    let nested: unknown = {};
    for (let index = 0; index < 20; index++) {
      nested = { nested };
    }
    expect(() => derive({ ...raw([]), extra: nested })).toThrow();
  });
});

function journalRecords(findings = [finding]) {
  const value = raw(findings);
  const outputs: unknown[] = value.reviewerRuns.map((run) => run.output);
  if (findings.length) {
    outputs.push(value.synthesizerOutput, value.verifierOutput);
  }
  return outputs.map((output, index) => ({
    index,
    key: index.toString(16).padStart(32, "0"),
    ok: true,
    text: JSON.stringify(output),
  }));
}
function deriveJournal(records: unknown[], plan = prepared) {
  return deriveJournalReviewResult(
    plan,
    `${records.map((entry) => JSON.stringify(entry)).join("\n")}\n`,
  );
}

describe("native completion-order journal contracts", () => {
  it("reconstructs reviewer provenance and downstream results by call index", () => {
    const records = journalRecords();
    expect(deriveJournal(records.toReversed())).toEqual(deriveJournal(records));
    expect(
      deriveJournal(records.toReversed()).candidates.map(({ model }) => model),
    ).toEqual(["test/alpha", "test/beta"]);
  });
  it("accepts failed/skip records without text, with success for the same role", () => {
    const records = journalRecords([]);
    const failure = { index: 0, key: records[0].key, ok: false };
    const result = deriveJournal([records[1], failure]);
    expect(result.coverage.degraded).toBe(true);
    expect(result.coverage.runs[0].error).toBe("Agent run failed.");
    expect(result.coverage.runs[1].model).toBe("test/beta");
    expect(() =>
      deriveJournal(
        records.map(({ index, key }) => ({ index, key, ok: false })),
      ),
    ).toThrow("No successful model run");
  });
  it("requires success for every role, not just any successful model", () => {
    const records = journalRecords([]);
    expect(() =>
      deriveJournal(
        [records[0], { index: 1, key: records[1].key, ok: false }],
        {
          ...prepared,
          reviewers: ["code-reviewer", "security-reviewer"],
          reviewerPanel: [prepared.reviewerPanel[0]],
        },
      ),
    ).toThrow("No successful model run");
  });
  for (const index of [-1, 0, 0.5, 2, "1", null]) {
    it(`rejects duplicate, missing, noninteger or out-of-range index ${index}`, () => {
      const records = journalRecords([]);
      expect(() =>
        deriveJournal([records[0], { ...records[1], index }]),
      ).toThrow();
    });
  }
  it("rejects missing records, duplicate keys, successful records without JSON text and private error fields", () => {
    const records = journalRecords([]);
    for (const invalid of [
      [records[0]],
      [records[0], { ...records[1], key: records[0].key }],
      [records[0], { index: 1, key: records[1].key, ok: true }],
      [records[0], { ...records[1], text: "PRIVATE provider token" }],
      [
        records[0],
        {
          index: 1,
          key: records[1].key,
          ok: false,
          error: "PRIVATE provider token",
        },
      ],
    ]) {
      expect(() => deriveJournal(invalid)).toThrow();
      try {
        deriveJournal(invalid);
      } catch (error) {
        expect(String(error)).not.toContain("PRIVATE");
      }
    }
  });
  it("stops when downstream calls fail without text", () => {
    const records = journalRecords();
    const { index, key } = records[2];
    expect(() =>
      deriveJournal([
        records[0],
        records[1],
        { index, key, ok: false },
        records[3],
      ]),
    ).toThrow("Downstream review agent failed");
  });
});
