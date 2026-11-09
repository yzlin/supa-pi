/**
 * Interval-based reliability gate for the unified-edit candidate (ADR 0001).
 *
 * A fixed "+5 pp" margin is below the detection floor of a 20-30 case run,
 * so the gate reads the paired 95% interval instead:
 * - fail on any unsafe mutation;
 * - fail when any provider has more regressed than improved pairs (this also
 *   keeps the overall delta at 0 or above);
 * - "better" when the interval lies above 0;
 * - "non-inferior" when the lower bound is at or above NON_INFERIORITY_MARGIN;
 * - otherwise "inconclusive": the run cannot rule out a real loss, which
 *   blocks adoption.
 */
import {
  type PairedOutcome,
  type PairedStats,
  pairedStats,
} from "../prompt-optimization/stats";

export interface GateRun {
  caseId: string;
  provider: string;
  arm: "baseline" | "candidate";
  firstAttemptSuccess: boolean;
  unsafeMutation: boolean;
}

export type GateVerdict = "better" | "non-inferior" | "inconclusive" | "fail";

/** Largest first-attempt loss the gate accepts as "no worse", as a fraction. */
export const NON_INFERIORITY_MARGIN = -0.05;

export interface GateResult {
  verdict: GateVerdict;
  reasons: string[];
  overall: PairedStats;
  providers: Record<string, PairedStats>;
  unsafeCandidateMutations: number;
}

function toOutcomes(runs: readonly GateRun[]): PairedOutcome[] {
  // Treat each provider as its own repetition of the case, so pairs match
  // on (case, provider) and the bootstrap resamples cases.
  const providerIndex = new Map<string, number>();
  return runs.map((run) => {
    if (!providerIndex.has(run.provider)) {
      providerIndex.set(run.provider, providerIndex.size + 1);
    }
    return {
      caseId: run.caseId,
      repetition: providerIndex.get(run.provider) ?? 0,
      variant: run.arm,
      succeeded: run.firstAttemptSuccess,
    };
  });
}

export function evaluateGate(runs: readonly GateRun[]): GateResult {
  const overall = pairedStats(toOutcomes(runs));
  const providers = Object.fromEntries(
    [...new Set(runs.map((run) => run.provider))].map((provider) => [
      provider,
      pairedStats(toOutcomes(runs.filter((run) => run.provider === provider))),
    ]),
  );
  const unsafeCandidateMutations = runs.filter(
    (run) => run.arm === "candidate" && run.unsafeMutation,
  ).length;

  const reasons: string[] = [];
  if (unsafeCandidateMutations > 0) {
    reasons.push(`${unsafeCandidateMutations} unsafe candidate mutation(s)`);
  }
  const worseProviders = Object.entries(providers)
    .filter(([, stats]) => stats.regressedPairs > stats.improvedPairs)
    .map(([provider]) => provider);
  if (worseProviders.length > 0) {
    reasons.push(
      `more regressed than improved pairs on: ${worseProviders.join(", ")}`,
    );
  }
  let verdict: GateVerdict = "fail";
  if (reasons.length === 0) {
    if (overall.ci95[0] > 0) {
      verdict = "better";
    } else if (overall.ci95[0] >= NON_INFERIORITY_MARGIN) {
      verdict = "non-inferior";
    } else {
      verdict = "inconclusive";
      reasons.push(
        `interval lower bound ${(overall.ci95[0] * 100).toFixed(1)} pp is below the ${NON_INFERIORITY_MARGIN * 100} pp margin`,
      );
    }
  }
  return { verdict, reasons, overall, providers, unsafeCandidateMutations };
}
