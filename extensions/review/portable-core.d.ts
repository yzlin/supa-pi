export type PortableValidationResult =
  | { ok: true; value: unknown }
  | { ok: false; error: string };

export function runPortableReviewCore(
  operation: string,
  input: unknown
): unknown;
export function validatePortableFinding(
  value: unknown,
  rejectUnknownFields?: boolean
): PortableValidationResult;
export function validatePortableFindings(
  value: unknown
): PortableValidationResult;
export function validatePortableReviewer(
  value: unknown
): PortableValidationResult;
export function collectPortableHumanReviewerCallouts(
  reviewerOutputs: unknown[]
): string[];
export function buildPortableReviewerCoverage(
  reviewers: unknown[]
): Record<string, "used" | "not used">;
export function buildPortableCorrectReviewResult(
  workflowInput: unknown,
  args: unknown
): unknown;
export function buildPortableCandidateFindings(runs: unknown[]): unknown[];
export function distinctPortableLocations(candidates: unknown[]): unknown[];
export function parsePortableSynthesizerOutput(
  value: unknown,
  candidates: unknown[]
): PortableValidationResult;
export function validatePortableVerifier(
  value: unknown,
  candidateFindings: unknown[]
): PortableValidationResult;
export function applyPortableDeterministicReportFields(
  verifier: unknown,
  candidateFindings: unknown[],
  coverage: unknown,
  deterministicReportFields: unknown
): unknown;
