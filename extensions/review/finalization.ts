import { Buffer } from "node:buffer";

import {
  applyPortableDeterministicReportFields,
  buildPortableCandidateFindings,
  buildPortableCorrectReviewResult,
  buildPortableReviewerCoverage,
  collectPortableHumanReviewerCallouts,
  parsePortableSynthesizerOutput,
  validatePortableReviewer,
  validatePortableVerifier,
} from "./portable-core";
import type { PublicReviewWorkflowInput } from "./public-workflow";
import type {
  ReviewCandidateFindingContract,
  ReviewerJsonContract,
  ReviewRunOutcome,
  ReviewWorkflowCoverage,
  ReviewWorkflowResult,
  SynthesizedClusterContract,
  VerifierJsonContract,
} from "./workflow";

const MAX_RAW_BYTES = 1_048_576;
const MAX_STRING_LENGTH = 16_384;
const MAX_ARRAY_LENGTH = 256;
const MAX_DEPTH = 16;
const JOURNAL_KEY_PATTERN = /^[a-f0-9]{32}$/u;

function invalidRaw(): never {
  throw new Error("Invalid raw review result.");
}

function record(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return invalidRaw();
  }
  return value as Record<string, unknown>;
}

function closed(value: Record<string, unknown>, keys: string[]): void {
  if (Object.keys(value).some((key) => !keys.includes(key))) {
    invalidRaw();
  }
}

function boundJson(value: unknown, depth = 0): void {
  if (depth > MAX_DEPTH) {
    invalidRaw();
  }
  if (typeof value === "string" && value.length > MAX_STRING_LENGTH) {
    invalidRaw();
  }
  if (Array.isArray(value)) {
    if (value.length > MAX_ARRAY_LENGTH) {
      invalidRaw();
    }
    for (const item of value) {
      boundJson(item, depth + 1);
    }
  } else if (value && typeof value === "object") {
    const entries = Object.entries(value);
    if (entries.length > 32) {
      invalidRaw();
    }
    for (const [key, item] of entries) {
      if (key.length > 128) {
        invalidRaw();
      }
      boundJson(item, depth + 1);
    }
  }
}

function parseRaw(rawJson: string): Record<string, unknown> {
  if (
    typeof rawJson !== "string" ||
    rawJson.length > MAX_RAW_BYTES ||
    Buffer.byteLength(rawJson, "utf8") > MAX_RAW_BYTES
  ) {
    return invalidRaw();
  }
  let value: unknown;
  try {
    value = JSON.parse(rawJson);
  } catch {
    return invalidRaw();
  }
  boundJson(value);
  const result = record(value);
  closed(result, ["reviewerRuns", "synthesizerOutput", "verifierOutput"]);
  return result;
}

function validateRuns(
  prepared: PublicReviewWorkflowInput,
  raw: Record<string, unknown>,
): ReviewRunOutcome[] {
  const expected = prepared.reviewers.flatMap((reviewer) =>
    prepared.reviewerPanel.map((entry) => ({ reviewer, ...entry })),
  );
  const runs = raw.reviewerRuns;
  if (!Array.isArray(runs) || runs.length !== expected.length) {
    return invalidRaw();
  }
  return expected.map((job, index): ReviewRunOutcome => {
    const run = record(runs[index]);
    closed(run, ["reviewer", "model", "thinkingLevel", "status", "output"]);
    if (
      run.reviewer !== job.reviewer ||
      run.model !== job.model ||
      run.thinkingLevel !== job.thinkingLevel ||
      (run.status !== "succeeded" && run.status !== "failed")
    ) {
      return invalidRaw();
    }
    if (run.status === "failed") {
      if (Object.hasOwn(run, "output")) {
        return invalidRaw();
      }
      return { ...job, status: "failed", error: "Agent run failed." };
    }
    const parsed = validatePortableReviewer(run.output);
    // This assertion is after shared semantic validation, never caller metadata.
    if (parsed.ok) {
      const output = parsed.value as ReviewerJsonContract;
      if (output.reviewer === job.reviewer) {
        return { ...job, status: "succeeded", output };
      }
    }
    return {
      ...job,
      status: "failed",
      error: "Invalid structured output after native schema retry.",
    };
  });
}

function parseJournalJson(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    // Syntax errors may quote provider output; never propagate that payload.
    throw new Error("Invalid review journal JSON.");
  }
}

/** Decode the public, version-sensitive agent-call journal, never notification previews. */
export function deriveJournalReviewResult(
  prepared: PublicReviewWorkflowInput,
  journal: string,
): Omit<ReviewWorkflowResult, "report"> {
  if (Buffer.byteLength(journal) > MAX_RAW_BYTES || !journal.endsWith("\n")) {
    throw new Error("Unsupported or incomplete review journal capture.");
  }
  const lines = journal.slice(0, -1).split("\n");
  const jobs = prepared.reviewers.flatMap((reviewer) =>
    prepared.reviewerPanel.map((entry) => ({ reviewer, ...entry })),
  );
  if (lines.length < jobs.length || lines.length > jobs.length + 2) {
    throw new Error("Unexpected agent calls in review journal.");
  }
  const keys = new Set<string>();
  // Native calls append on completion, not dispatch. Unique indices bounded by
  // record count guarantee dense coverage; sort only after validating every row.
  const indices = new Set<number>();
  const calls = lines
    .map((line) => {
      const entry = record(parseJournalJson(line));
      closed(entry, ["index", "key", "ok", "text"]);
      if (
        typeof entry.index !== "number" ||
        !Number.isInteger(entry.index) ||
        entry.index < 0 ||
        entry.index >= lines.length ||
        indices.has(entry.index) ||
        typeof entry.key !== "string" ||
        !JOURNAL_KEY_PATTERN.test(entry.key) ||
        keys.has(entry.key) ||
        typeof entry.ok !== "boolean" ||
        (entry.ok
          ? typeof entry.text !== "string"
          : Object.hasOwn(entry, "text"))
      ) {
        throw new Error("Unsupported or invalid review journal record/index.");
      }
      keys.add(entry.key);
      indices.add(entry.index);
      return entry.ok
        ? {
            index: entry.index,
            ok: true,
            output: parseJournalJson(entry.text as string),
          }
        : { index: entry.index, ok: false };
    })
    .sort((a, b) => a.index - b.index);
  const raw = {
    reviewerRuns: jobs.map((job, index) => ({
      ...job,
      status: calls[index].ok ? "succeeded" : "failed",
      ...(calls[index].ok ? { output: calls[index].output } : {}),
    })),
  };
  // Bound nested output before shared semantic validation.
  const runs = validateRuns(prepared, parseRaw(JSON.stringify(raw)));
  const candidates = buildPortableCandidateFindings(runs);
  if (lines.length !== jobs.length + (candidates.length ? 2 : 0)) {
    throw new Error("Incomplete or unexpected downstream review calls.");
  }
  const downstream = calls.slice(jobs.length);
  if (downstream.some((call) => !call.ok)) {
    throw new Error("Downstream review agent failed.");
  }
  return derivePreparedReviewResult(
    prepared,
    JSON.stringify({
      ...raw,
      ...(candidates.length
        ? {
            synthesizerOutput: downstream[0].output,
            verifierOutput: downstream[1].output,
          }
        : {}),
    }),
  );
}

/**
 * Data validation only, not publication authorization. The caller must supply an
 * immutable locally prepared plan, authenticate the complete raw payload against
 * the accepted native workflow, and check session/cwd, cancellation and freshness.
 * Never use a notification preview or assistant-authored derived fields here.
 */
export function derivePreparedReviewResult(
  prepared: PublicReviewWorkflowInput,
  rawJson: string,
): Omit<ReviewWorkflowResult, "report"> {
  const raw = parseRaw(rawJson);
  const runs = validateRuns(prepared, raw);
  if (
    !prepared.reviewers.length ||
    prepared.reviewers.some(
      (reviewer) =>
        !runs.some(
          (run) => run.reviewer === reviewer && run.status === "succeeded",
        ),
    )
  ) {
    throw new Error(
      "No successful model run for every selected reviewer role.",
    );
  }
  const reviewerOutputs = runs.flatMap((run) =>
    run.output ? [run.output] : [],
  );
  const candidates = buildPortableCandidateFindings(
    runs,
  ) as ReviewCandidateFindingContract[];
  const coverage: ReviewWorkflowCoverage = {
    configuredPanelSize: prepared.reviewerPanel.length,
    degraded: runs.some((run) => run.status === "failed"),
    runs,
    callPlan: {
      reviewerRuns: runs.map(({ reviewer, model, thinkingLevel }) => ({
        reviewer,
        model,
        thinkingLevel,
      })),
      ...(candidates.length
        ? {
            synthesizer: {
              model: prepared.synthesizerModel,
              thinkingLevel: "medium",
            },
            verifier: {
              model: prepared.verifierModel,
              thinkingLevel: "medium",
            },
          }
        : {}),
    },
  };
  const deterministicReportFields = {
    humanReviewerCallouts:
      collectPortableHumanReviewerCallouts(reviewerOutputs),
    reviewerCoverage: buildPortableReviewerCoverage([...prepared.reviewers]),
  };
  if (!candidates.length) {
    if (
      Object.hasOwn(raw, "synthesizerOutput") ||
      Object.hasOwn(raw, "verifierOutput")
    ) {
      return invalidRaw();
    }
    return {
      reviewerOutputs,
      candidates,
      coverage,
      clusters: [],
      verifier: buildPortableCorrectReviewResult(
        prepared,
        deterministicReportFields,
      ) as VerifierJsonContract,
    };
  }
  const parsedClusters = parsePortableSynthesizerOutput(
    raw.synthesizerOutput,
    candidates,
  );
  if (!parsedClusters.ok) {
    throw new Error("Invalid synthesizer output.");
  }
  const parsedVerifier = validatePortableVerifier(
    raw.verifierOutput,
    candidates,
  );
  if (!parsedVerifier.ok) {
    throw new Error("Invalid verifier output.");
  }
  return {
    reviewerOutputs,
    candidates,
    coverage,
    clusters: parsedClusters.value as SynthesizedClusterContract[],
    verifier: applyPortableDeterministicReportFields(
      parsedVerifier.value,
      candidates,
      coverage,
      deterministicReportFields,
    ) as VerifierJsonContract,
  };
}
