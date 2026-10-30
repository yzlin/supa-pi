export const REVIEW_REPORT_MESSAGE_TYPE = "review-report";
export const REVIEWER_MODEL_POLICY_MODEL = "openai-codex/gpt-6-astra";
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
export type ReviewSketchKind = "flow" | "diff";
export interface ReviewSketch {
  kind: ReviewSketchKind;
  text: string;
}
interface VerifierFindingContract extends ReviewFindingContract {
  trigger: string;
  sketches: ReviewSketch[];
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
    trigger: string;
    why: string;
    change: string;
    sketches: ReviewSketch[];
    confidence: VerifierConfidence;
    reason: string;
    consensusEffect: "none" | "raised-one-level";
  }>;
  /** Every candidate ID not in an accepted finding, with the reason. */
  rejected: Array<{ id: string; reason: string }>;
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
}

const MODEL_MARKDOWN_ESCAPE_RE = /([\\`#])/g;
const MODEL_CONTROL_RE = /[\p{Cc}\p{Cf}]+/gu;
const WHITESPACE_RE = /\s+/g;
const MAX_SKETCH_LINES = 12;
const MAX_SKETCH_LINE_LENGTH = 160;

export function renderReviewReport(
  report: VerifierJsonContract,
  coverage?: ReviewWorkflowCoverage,
): string {
  const renderedFindings = report.findings.filter(
    (finding) => finding.confidence !== "low",
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
    const locationsOf = (finding: VerifierFindingContract) =>
      (finding.locations ?? [{ file: finding.file, line: finding.line }]).map(
        (location) =>
          `\`${sanitizeInlineCode(location.file)}:${location.line}\``,
      );
    if (renderedFindings.length > 1) {
      lines.push("| # | Priority | Finding | Location |", "|---|---|---|---|");
      for (const [index, finding] of renderedFindings.entries()) {
        const locations = locationsOf(finding);
        const more = locations.length > 1 ? ` +${locations.length - 1}` : "";
        lines.push(
          `| ${index + 1} | ${finding.priority} | ${sanitizeTableCell(finding.title)} | ${locations[0].replace(/\|/g, "\\|")}${more} |`,
        );
      }
      lines.push("");
    }
    for (const [index, finding] of renderedFindings.entries()) {
      const flow = finding.sketches.filter((sketch) => sketch.kind === "flow");
      const diff = finding.sketches.filter((sketch) => sketch.kind === "diff");
      lines.push(
        `### ${index + 1}. [${finding.priority}] ${sanitizeMarkdownText(finding.title)}`,
        locationsOf(finding).join(", "),
        "",
        `**Trigger:** ${sanitizeMarkdownText(finding.trigger)}`,
        `**Impact:** ${sanitizeMarkdownText(finding.why)}`,
        "",
        ...flow.flatMap((sketch) => [...renderSketch(sketch), ""]),
        `**Fix:** ${sanitizeMarkdownText(finding.change)}`,
        "",
        ...diff.flatMap((sketch) => [...renderSketch(sketch), ""]),
        `- Evidence: ${finding.confidence} confidence${finding.consensusEffect === "raised-one-level" ? " (raised one level by consensus)" : ""} — ${sanitizeMarkdownText(finding.reason)}`,
        `- Support: ${finding.supportCount ?? finding.supportingModels?.length ?? 1}/${finding.eligibleModelCount ?? finding.eligibleModels?.length ?? 1} eligible successful models (configured panel: ${coverage?.configuredPanelSize ?? "unknown"}) — ${(finding.supportingModels ?? []).map((model) => `\`${sanitizeInlineCode(model)}\` → ${(finding.modelReviewerRoles?.[model] ?? []).join(", ")}`).join("; ") || "(provenance unavailable)"}`,
        "",
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
      "- (none)",
    ),
    "",
    "## Reviewer Coverage",
  );

  if (coverage) {
    lines.push(
      `- Panel size: ${coverage.configuredPanelSize}`,
      `- Degraded: ${coverage.degraded ? "yes — one or more reviewer runs failed" : "no"}`,
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
        (candidate) => candidate.reviewer === reviewer,
      )) {
        const failure = run.error
          ? ` — ${sanitizeMarkdownText(run.error).slice(0, 160)}`
          : "";
        lines.push(
          `- ${reviewer} · \`${sanitizeInlineCode(run.model)}\`: ${run.status === "succeeded" ? "used" : "failed"}${failure}`,
        );
      }
    }
  } else {
    lines.push(
      `- code-reviewer: ${report.reviewerCoverage["code-reviewer"]}`,
      `- security-reviewer: ${report.reviewerCoverage["security-reviewer"]}`,
      `- database-reviewer: ${report.reviewerCoverage["database-reviewer"]}`,
      `- performance-reviewer: ${report.reviewerCoverage["performance-reviewer"]}`,
    );
  }

  return lines.join("\n");
}

function sanitizeMarkdownText(value: string): string {
  return collapseModelText(value).replace(MODEL_MARKDOWN_ESCAPE_RE, "\\$1");
}
function sanitizeTableCell(value: string): string {
  return sanitizeMarkdownText(value).replace(/\|/g, "\\|");
}
// Sketches keep line breaks, so they need their own guard: no control or
// format characters, a fence longer than any backtick run inside, and no
// line that starts with `#` (report consumers detect sections only from lines
// that start with `## `). U+2028/U+2029 count as line breaks because `^` in
// multiline regexes matches after them.
function renderSketch(sketch: ReviewSketch): string[] {
  const sketchLines = sketch.text
    .replace(/\t/g, "  ")
    .split(/\r\n|[\r\n\u2028\u2029]/)
    .map((line) => {
      const clean = line.replace(MODEL_CONTROL_RE, "").trimEnd();
      const clipped =
        clean.length > MAX_SKETCH_LINE_LENGTH
          ? `${clean.slice(0, MAX_SKETCH_LINE_LENGTH - 1)}…`
          : clean;
      return clipped.replace(/^#/, " #");
    });
  while (sketchLines.length && !sketchLines[0].trim()) {
    sketchLines.shift();
  }
  while (sketchLines.length && !sketchLines.at(-1)?.trim()) {
    sketchLines.pop();
  }
  if (sketchLines.length > MAX_SKETCH_LINES) {
    sketchLines.length = MAX_SKETCH_LINES;
    sketchLines.push("…");
  }
  const longestBacktickRun = Math.max(
    0,
    ...sketchLines.map((line) =>
      Math.max(0, ...(line.match(/`+/g) ?? []).map((run) => run.length)),
    ),
  );
  const fence = "`".repeat(Math.max(3, longestBacktickRun + 1));
  return [
    `${fence}${sketch.kind === "diff" ? "diff" : "text"}`,
    ...sketchLines,
    fence,
  ];
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
