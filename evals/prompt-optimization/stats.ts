/**
 * Paired statistics for baseline-vs-candidate eval runs.
 *
 * Runs are paired by (caseId, repetition). Repetitions of one case are
 * correlated, so the bootstrap resamples whole cases (cluster bootstrap),
 * not individual runs.
 */

export interface PairedOutcome {
  caseId: string;
  repetition: number;
  variant: "baseline" | "candidate";
  succeeded: boolean;
}

export interface PairedStats {
  /** Number of matched (case, repetition) pairs. */
  pairs: number;
  /** Runs without a matching run in the other arm; excluded from all stats. */
  unpaired: number;
  cases: number;
  /** Mean of candidate minus baseline over pairs, in [-1, 1]. */
  passRateDelta: number;
  /** 95% case-clustered bootstrap percentile interval for passRateDelta. */
  ci95: [number, number];
  /** Pairs where baseline failed and candidate passed. */
  improvedPairs: number;
  /** Pairs where baseline passed and candidate failed. */
  regressedPairs: number;
  /** Cases where every paired repetition passed, per arm (pass^k). */
  baselineAllPassCases: number;
  candidateAllPassCases: number;
}

export const BOOTSTRAP_ITERATIONS = 2000;

const PARK_MILLER_MODULUS = 2_147_483_647;

/**
 * Deterministic Park–Miller PRNG so the same records always produce the same
 * interval. Products stay below 2^53, so float arithmetic is exact.
 */
function parkMiller(seed: number): () => number {
  let state = (Math.abs(Math.trunc(seed)) % (PARK_MILLER_MODULUS - 1)) + 1;
  return () => {
    state = (state * 48_271) % PARK_MILLER_MODULUS;
    return (state - 1) / (PARK_MILLER_MODULUS - 1);
  };
}

function percentile(sorted: number[], fraction: number): number {
  const index = Math.min(
    sorted.length - 1,
    Math.max(0, Math.round(fraction * (sorted.length - 1))),
  );
  return sorted[index];
}

export function pairedStats(
  outcomes: readonly PairedOutcome[],
  iterations = BOOTSTRAP_ITERATIONS,
): PairedStats {
  const byKey = new Map<
    string,
    { caseId: string; baseline?: boolean; candidate?: boolean }
  >();
  for (const outcome of outcomes) {
    const key = JSON.stringify([outcome.caseId, outcome.repetition]);
    const entry = byKey.get(key) ?? { caseId: outcome.caseId };
    if (entry[outcome.variant] !== undefined) {
      throw new Error(
        `duplicate ${outcome.variant} run for ${outcome.caseId} repetition ${outcome.repetition}`,
      );
    }
    entry[outcome.variant] = outcome.succeeded;
    byKey.set(key, entry);
  }

  const differencesByCase = new Map<string, number[]>();
  const allPass = new Map<string, { baseline: boolean; candidate: boolean }>();
  let unpaired = 0;
  let improvedPairs = 0;
  let regressedPairs = 0;
  for (const entry of byKey.values()) {
    if (entry.baseline === undefined || entry.candidate === undefined) {
      unpaired += 1;
      continue;
    }
    const difference = Number(entry.candidate) - Number(entry.baseline);
    if (difference > 0) {
      improvedPairs += 1;
    }
    if (difference < 0) {
      regressedPairs += 1;
    }
    const differences = differencesByCase.get(entry.caseId) ?? [];
    differences.push(difference);
    differencesByCase.set(entry.caseId, differences);
    const caseAllPass = allPass.get(entry.caseId) ?? {
      baseline: true,
      candidate: true,
    };
    caseAllPass.baseline &&= entry.baseline;
    caseAllPass.candidate &&= entry.candidate;
    allPass.set(entry.caseId, caseAllPass);
  }

  const clusters = [...differencesByCase.values()];
  const pairs = clusters.reduce((sum, cluster) => sum + cluster.length, 0);
  if (pairs === 0) {
    throw new Error("paired stats require at least one matched pair");
  }
  const meanOf = (selected: number[][]): number => {
    let sum = 0;
    let count = 0;
    for (const cluster of selected) {
      for (const difference of cluster) {
        sum += difference;
      }
      count += cluster.length;
    }
    return sum / count;
  };

  const random = parkMiller(pairs * 7919 + clusters.length);
  const samples: number[] = [];
  for (let iteration = 0; iteration < iterations; iteration += 1) {
    const resampled = clusters.map(
      () => clusters[Math.floor(random() * clusters.length)],
    );
    samples.push(meanOf(resampled));
  }
  samples.sort((left, right) => left - right);

  const caseAllPass = [...allPass.values()];
  return {
    pairs,
    unpaired,
    cases: clusters.length,
    passRateDelta: meanOf(clusters),
    ci95: [percentile(samples, 0.025), percentile(samples, 0.975)],
    improvedPairs,
    regressedPairs,
    baselineAllPassCases: caseAllPass.filter((entry) => entry.baseline).length,
    candidateAllPassCases: caseAllPass.filter((entry) => entry.candidate)
      .length,
  };
}

/**
 * Worst-case 95% half-width of a case-clustered paired pass-rate delta.
 * Each case's mean difference lies in [-1, 1], so its variance is at most 1.
 * Real runs with few discordant pairs resolve finer than this bound.
 */
export function worstCaseDetectionFloor(caseCount: number): number {
  if (caseCount <= 0) {
    throw new Error("case count must be positive");
  }
  return 1.96 / Math.sqrt(caseCount);
}

export function detectionFloorMessage(caseCount: number): string {
  const floor = worstCaseDetectionFloor(caseCount);
  if (floor >= 1) {
    return `${caseCount} case(s) cannot separate any pass-rate delta from noise; add cases before comparing arms`;
  }
  return `±${(floor * 100).toFixed(1)} pp worst-case 95% pass-rate delta (${caseCount} case(s)); smaller effects may be noise`;
}

export function intervalExcludesZero(stats: PairedStats): boolean {
  return stats.ci95[0] > 0 || stats.ci95[1] < 0;
}

function signedPercent(value: number): string {
  const percent = value * 100;
  return `${percent >= 0 ? "+" : ""}${percent.toFixed(1)}`;
}

export function pairedSummaryLine(paired: PairedStats): string {
  const [low, high] = paired.ci95;
  const verdict = intervalExcludesZero(paired)
    ? "interval excludes 0"
    : "interval includes 0: no measurable difference";
  const unpaired =
    paired.unpaired > 0 ? `; ${paired.unpaired} unpaired run(s) excluded` : "";
  return [
    `Delta ${signedPercent(paired.passRateDelta)} pp, 95% CI [${signedPercent(low)}, ${signedPercent(high)}] pp (case-clustered bootstrap, ${paired.cases} case(s), ${paired.pairs} pair(s)${unpaired}); ${verdict}.`,
    `Pairs improved ${paired.improvedPairs}, regressed ${paired.regressedPairs}. Pass^k (all repetitions pass): baseline ${paired.baselineAllPassCases}/${paired.cases}, candidate ${paired.candidateAllPassCases}/${paired.cases} case(s).`,
  ].join("\n");
}
