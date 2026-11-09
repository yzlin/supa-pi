import { describe, expect, it } from "bun:test";

import {
  detectionFloorMessage,
  intervalExcludesZero,
  type PairedOutcome,
  pairedStats,
  pairedSummaryLine,
  worstCaseDetectionFloor,
} from "./stats";

function outcomes(
  rows: Array<
    [caseId: string, repetition: number, base: boolean, cand: boolean]
  >,
): PairedOutcome[] {
  return rows.flatMap(([caseId, repetition, base, cand]) => [
    { caseId, repetition, variant: "baseline" as const, succeeded: base },
    { caseId, repetition, variant: "candidate" as const, succeeded: cand },
  ]);
}

describe("pairedStats", () => {
  it("counts improved and regressed pairs that a flat delta hides", () => {
    const stats = pairedStats(
      outcomes([
        ["a", 1, false, true],
        ["b", 1, true, false],
        ["c", 1, true, true],
      ]),
    );
    expect(stats.passRateDelta).toBe(0);
    expect(stats.improvedPairs).toBe(1);
    expect(stats.regressedPairs).toBe(1);
    expect(intervalExcludesZero(stats)).toBe(false);
  });

  it("reports pass^k per case across repetitions", () => {
    const stats = pairedStats(
      outcomes([
        ["a", 1, true, true],
        ["a", 2, false, true],
        ["b", 1, true, true],
        ["b", 2, true, true],
      ]),
    );
    expect(stats.cases).toBe(2);
    expect(stats.pairs).toBe(4);
    expect(stats.baselineAllPassCases).toBe(1);
    expect(stats.candidateAllPassCases).toBe(2);
  });

  it("does not call a two-of-nine gap a win", () => {
    // The plain-report Astra run: +22 pp from two runs in nine.
    const stats = pairedStats(
      outcomes([
        ["a", 1, false, true],
        ["a", 2, true, true],
        ["a", 3, true, true],
        ["b", 1, false, true],
        ["b", 2, true, true],
        ["b", 3, true, true],
        ["c", 1, true, true],
        ["c", 2, true, true],
        ["c", 3, true, true],
      ]),
    );
    expect(stats.passRateDelta).toBeCloseTo(2 / 9);
    expect(stats.ci95[0]).toBeLessThanOrEqual(0);
    expect(intervalExcludesZero(stats)).toBe(false);
  });

  it("separates a consistent improvement across many cases from zero", () => {
    const rows: Array<[string, number, boolean, boolean]> = [];
    for (let index = 0; index < 30; index += 1) {
      rows.push([`case-${index}`, 1, index % 3 === 0, true]);
    }
    const stats = pairedStats(outcomes(rows));
    expect(stats.passRateDelta).toBeCloseTo(20 / 30);
    expect(stats.ci95[0]).toBeGreaterThan(0);
    expect(intervalExcludesZero(stats)).toBe(true);
  });

  it("is deterministic for the same input", () => {
    const input = outcomes([
      ["a", 1, false, true],
      ["b", 1, true, false],
      ["c", 1, false, true],
      ["d", 1, true, true],
    ]);
    expect(pairedStats(input).ci95).toEqual(pairedStats(input).ci95);
  });

  it("excludes unpaired runs and rejects duplicates", () => {
    const stats = pairedStats([
      ...outcomes([["a", 1, true, true]]),
      { caseId: "b", repetition: 1, variant: "baseline", succeeded: true },
    ]);
    expect(stats.pairs).toBe(1);
    expect(stats.unpaired).toBe(1);
    expect(() =>
      pairedStats([
        ...outcomes([["a", 1, true, true]]),
        { caseId: "a", repetition: 1, variant: "candidate", succeeded: false },
      ]),
    ).toThrow("duplicate candidate run");
  });
});

describe("worstCaseDetectionFloor", () => {
  it("shrinks with the square root of the case count", () => {
    expect(worstCaseDetectionFloor(1)).toBeCloseTo(1.96);
    expect(worstCaseDetectionFloor(60)).toBeCloseTo(0.253, 3);
    expect(() => worstCaseDetectionFloor(0)).toThrow();
  });

  it("says too few cases cannot resolve any delta", () => {
    expect(detectionFloorMessage(1)).toContain("cannot separate");
    expect(detectionFloorMessage(72)).toContain("±23.1 pp");
  });
});

describe("pairedSummaryLine", () => {
  it("states the interval, verdict, regressions, and pass^k", () => {
    const line = pairedSummaryLine(
      pairedStats(
        outcomes([
          ["a", 1, false, true],
          ["b", 1, true, false],
        ]),
      ),
    );
    expect(line).toContain("95% CI [");
    expect(line).toContain("no measurable difference");
    expect(line).toContain("improved 1, regressed 1");
    expect(line).toContain("Pass^k");
  });
});
