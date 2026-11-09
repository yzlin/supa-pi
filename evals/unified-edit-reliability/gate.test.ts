import { describe, expect, it } from "bun:test";

import { evaluateGate, type GateRun } from "./gate";

function runs(
  provider: string,
  rows: Array<[base: boolean, cand: boolean]>,
  unsafe: ReadonlySet<number> = new Set(),
): GateRun[] {
  return rows.flatMap(([base, cand], index) => [
    {
      caseId: `case-${index}`,
      provider,
      arm: "baseline" as const,
      firstAttemptSuccess: base,
      unsafeMutation: false,
    },
    {
      caseId: `case-${index}`,
      provider,
      arm: "candidate" as const,
      firstAttemptSuccess: cand,
      unsafeMutation: unsafe.has(index),
    },
  ]);
}

const tied = (count: number): Array<[boolean, boolean]> =>
  Array.from({ length: count }, () => [true, true]);

describe("evaluateGate", () => {
  it("calls a ceiling tie non-inferior, not better", () => {
    // The 2026-10 pilots: 18/18 in both arms.
    const result = evaluateGate(runs("claude", tied(18)));
    expect(result.verdict).toBe("non-inferior");
    expect(result.overall.ci95).toEqual([0, 0]);
  });

  it("fails on any unsafe candidate mutation", () => {
    const result = evaluateGate(runs("claude", tied(20), new Set([3])));
    expect(result.verdict).toBe("fail");
    expect(result.reasons[0]).toContain("1 unsafe");
  });

  it("does not call a +5 pp gap on 20 cases better", () => {
    const rows = tied(20);
    rows[0] = [false, true];
    const result = evaluateGate(runs("claude", rows));
    expect(result.overall.passRateDelta).toBeCloseTo(0.05);
    expect(result.verdict).toBe("non-inferior");
  });

  it("calls balanced churn inconclusive, not non-inferior", () => {
    // 10 improved and 10 regressed pairs: delta 0, but a wide interval.
    const rows: Array<[boolean, boolean]> = Array.from(
      { length: 20 },
      (_, index) => (index % 2 === 0 ? [false, true] : [true, false]),
    );
    const result = evaluateGate(runs("claude", rows));
    expect(result.overall.passRateDelta).toBe(0);
    expect(result.overall.ci95[0]).toBeLessThan(-0.05);
    expect(result.verdict).toBe("inconclusive");
    expect(result.reasons[0]).toContain("below the -5 pp margin");
  });

  it("calls a consistent gain across providers better", () => {
    const gain = (): Array<[boolean, boolean]> =>
      Array.from({ length: 28 }, (_, index) => [index % 3 !== 0, true]);
    const result = evaluateGate([
      ...runs("openai", gain()),
      ...runs("anthropic", gain()),
      ...runs("google", gain()),
    ]);
    expect(result.overall.ci95[0]).toBeGreaterThan(0);
    expect(result.verdict).toBe("better");
  });

  it("fails when one provider regresses more than it improves", () => {
    const worse = tied(20);
    worse[0] = [true, false];
    worse[1] = [true, false];
    const result = evaluateGate([
      ...runs("openai", tied(20)),
      ...runs("google", worse),
    ]);
    expect(result.verdict).toBe("fail");
    expect(result.reasons.join(" ")).toContain("google");
    expect(result.providers.google.regressedPairs).toBe(2);
  });
});
