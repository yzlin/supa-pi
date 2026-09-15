export {
  createPublicWorkflowSmokeScript,
  createReviewWorkflowScript,
  prepareReviewWorkflowScript,
} from "./public-workflow";

export const REVIEW_REPORT_MESSAGE_TYPE = "review-report";
export const REVIEWER_MODEL_POLICY_MODEL = "openai-codex/gpt-6-astra";
export const DEFAULT_SYNTHESIZER_MODEL = "openai-codex/gpt-6-astra";
export const DEFAULT_VERIFIER_MODEL = "openai-codex/gpt-6-astra";
export const REVIEW_WORKFLOW_CONCURRENCY = 4;

export type ReviewThinkingLevel =
  | "off"
  | "minimal"
  | "low"
  | "medium"
  | "high"
  | "xhigh";
export interface ReviewPanelEntry {
  model: string;
  thinkingLevel: ReviewThinkingLevel;
}
export const DEFAULT_REVIEWER_PANEL: readonly ReviewPanelEntry[] = [
  { model: REVIEWER_MODEL_POLICY_MODEL, thinkingLevel: "medium" },
];

export type ReviewPriority = "P0" | "P1" | "P2" | "P3";
export type ReviewVerdict = "correct" | "needs attention";
export type VerifierConfidence = "high" | "medium" | "low";
export type ReviewerAgent =
  | "code-reviewer"
  | "security-reviewer"
  | "database-reviewer"
  | "performance-reviewer";
export interface ReviewFindingContract {
  priority: ReviewPriority;
  title: string;
  file: string;
  line: number;
  why: string;
  change: string;
}
export interface ReviewerJsonContract {
  reviewer: ReviewerAgent;
  verdict: ReviewVerdict;
  findings: ReviewFindingContract[];
  humanReviewerCallouts: string[];
  notes?: string[];
}
export interface ReviewLocation {
  file: string;
  line: number;
}
export interface ReviewCandidateFindingContract extends ReviewFindingContract {
  candidateId: string;
  reviewer: ReviewerAgent;
  model: string;
  thinkingLevel: ReviewThinkingLevel;
}
export interface SynthesizedClusterContract {
  clusterId: string;
  memberIds: string[];
  title: string;
  why: string;
  change: string;
  reportedPriorities: ReviewPriority[];
  locations: ReviewLocation[];
}
interface VerifierFindingContract extends ReviewFindingContract {
  sourceReviewer: ReviewerAgent;
  confidence: VerifierConfidence;
  reason: string;
  consensusEffect?: "none" | "raised-one-level";
  memberIds?: string[];
  locations?: ReviewLocation[];
  supportingModels?: string[];
  modelReviewerRoles?: Record<string, ReviewerAgent[]>;
  eligibleModels?: string[];
  supportCount?: number;
  eligibleModelCount?: number;
}
export interface VerifierSubmissionJsonContract {
  reviewScope: string[];
  verdict: ReviewVerdict;
  findings: Array<{
    memberIds: string[];
    priority: ReviewPriority;
    title: string;
    why: string;
    change: string;
    confidence: VerifierConfidence;
    reason: string;
    consensusEffect: "none" | "raised-one-level";
  }>;
}
export interface VerifierJsonContract {
  reviewScope: string[];
  verdict: ReviewVerdict;
  findings: VerifierFindingContract[];
  humanReviewerCallouts: string[];
  reviewerCoverage: Record<ReviewerAgent, "used" | "not used">;
}
export type ReviewRunStatus = "succeeded" | "failed";
export interface ReviewRunOutcome {
  reviewer: ReviewerAgent;
  model: string;
  thinkingLevel: ReviewThinkingLevel;
  status: ReviewRunStatus;
  output?: ReviewerJsonContract;
  error?: string;
}
export interface ReviewWorkflowCallPlan {
  reviewerRuns: Array<{
    reviewer: ReviewerAgent;
    model: string;
    thinkingLevel: ReviewThinkingLevel;
  }>;
  synthesizer?: ReviewPanelEntry;
  verifier?: ReviewPanelEntry;
}
export interface ReviewWorkflowCoverage {
  configuredPanelSize: number;
  degraded: boolean;
  runs: ReviewRunOutcome[];
  callPlan: ReviewWorkflowCallPlan;
}
export interface ReviewWorkflowResult {
  report: string;
  verifier: VerifierJsonContract;
  reviewerOutputs: ReviewerJsonContract[];
  coverage: ReviewWorkflowCoverage;
  candidates: ReviewCandidateFindingContract[];
  clusters: SynthesizedClusterContract[];
}

const MODEL_MARKDOWN_ESCAPE_RE = /([\\`#])/g;
const MODEL_CONTROL_RE = /[\p{Cc}\p{Cf}]+/gu;
const WHITESPACE_RE = /\s+/g;

export function renderReviewReport(
  report: VerifierJsonContract,
  coverage?: ReviewWorkflowCoverage
): string {
  const renderedFindings = report.findings.filter(
    (finding) => finding.confidence !== "low"
  );
  const renderedVerdict = renderedFindings.length
    ? "needs attention"
    : "correct";
  const lines = [
    "## Review Scope",
    ...formatBullets(report.reviewScope.map(sanitizeMarkdownText)),
    "",
    "## Verdict",
    `- ${renderedVerdict}`,
    "",
    "## Findings",
  ];

  if (renderedFindings.length === 0) {
    lines.push("- Code looks good.");
  } else {
    for (const finding of renderedFindings) {
      lines.push(
        `### [${finding.priority}] ${sanitizeMarkdownText(finding.title)}`,
        `- Locations: ${(finding.locations ?? [{ file: finding.file, line: finding.line }]).map((location) => `\`${sanitizeInlineCode(location.file)}:${location.line}\``).join(", ")}`,
        `- Support: ${finding.supportCount ?? finding.supportingModels?.length ?? 1}/${finding.eligibleModelCount ?? finding.eligibleModels?.length ?? 1} eligible successful models (configured panel: ${coverage?.configuredPanelSize ?? "unknown"})`,
        `- Supporting models: ${(finding.supportingModels ?? []).map((model) => `\`${sanitizeInlineCode(model)}\` → ${(finding.modelReviewerRoles?.[model] ?? []).join(", ")}`).join("; ") || "(provenance unavailable)"}`,
        `- Verifier: accepted (${finding.confidence}) — ${sanitizeMarkdownText(finding.reason)}`,
        `- Consensus effect: ${finding.consensusEffect ?? "none"}`,
        `- Why it matters: ${sanitizeMarkdownText(finding.why)}`,
        `- What should change: ${sanitizeMarkdownText(finding.change)}`,
        ""
      );
    }
    if (lines.at(-1) === "") {
      lines.pop();
    }
  }

  lines.push(
    "",
    "## Human Reviewer Callouts (Non-Blocking)",
    ...formatBullets(
      report.humanReviewerCallouts.map(sanitizeMarkdownText),
      "- (none)"
    ),
    "",
    "## Reviewer Coverage"
  );

  if (coverage) {
    lines.push(
      `- Panel size: ${coverage.configuredPanelSize}`,
      `- Degraded: ${coverage.degraded ? "yes — one or more reviewer runs failed" : "no"}`
    );
    for (const reviewer of [
      "code-reviewer",
      "security-reviewer",
      "database-reviewer",
      "performance-reviewer",
    ] as const) {
      if (report.reviewerCoverage[reviewer] === "not used") {
        lines.push(`- ${reviewer}: not used`);
        continue;
      }
      for (const run of coverage.runs.filter(
        (candidate) => candidate.reviewer === reviewer
      )) {
        const failure = run.error
          ? ` — ${sanitizeMarkdownText(run.error).slice(0, 160)}`
          : "";
        lines.push(
          `- ${reviewer} · \`${sanitizeInlineCode(run.model)}\`: ${run.status === "succeeded" ? "used" : "failed"}${failure}`
        );
      }
    }
  } else {
    lines.push(
      `- code-reviewer: ${report.reviewerCoverage["code-reviewer"]}`,
      `- security-reviewer: ${report.reviewerCoverage["security-reviewer"]}`,
      `- database-reviewer: ${report.reviewerCoverage["database-reviewer"]}`,
      `- performance-reviewer: ${report.reviewerCoverage["performance-reviewer"]}`
    );
  }

  return lines.join("\n");
}

function sanitizeMarkdownText(value: string): string {
  return collapseModelText(value).replace(MODEL_MARKDOWN_ESCAPE_RE, "\\$1");
}
function sanitizeInlineCode(value: string): string {
  return collapseModelText(value).replace(/`/g, "'");
}
function collapseModelText(value: string): string {
  return value
    .replace(MODEL_CONTROL_RE, " ")
    .replace(WHITESPACE_RE, " ")
    .trim();
}
function formatBullets(values: string[], empty = "- (none)"): string[] {
  const filtered = values.map((value) => value.trim()).filter(Boolean);
  return filtered.length ? filtered.map((value) => `- ${value}`) : [empty];
}
