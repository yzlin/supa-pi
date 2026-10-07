import type {
  ReviewerAgent,
  ReviewPanelEntry,
  ReviewThinkingLevel,
} from "./workflow";

export interface ReviewPipelineInput {
  scopeHint: string;
  invocationPacket: string;
  reviewers: readonly ReviewerAgent[];
  reviewerPanel: readonly ReviewPanelEntry[];
  synthesizerModel: string;
  verifierModel: string;
  projectGuidelines?: string | null;
}

/** Raw calls only; derived fields in the workflow result are not publication authority. */
export interface ReviewRawResult {
  reviewerRuns: Array<{
    reviewer: ReviewerAgent;
    model: string;
    thinkingLevel: ReviewThinkingLevel;
    status: "succeeded" | "failed";
    output?: unknown;
  }>;
  synthesizerOutput?: unknown;
  verifierOutput?: unknown;
}

const REVIEWERS = [
  "code-reviewer",
  "security-reviewer",
  "database-reviewer",
  "performance-reviewer",
] as const;

const EFFORTS = new Set(["off", "minimal", "low", "medium", "high", "xhigh"]);

export function assertReviewEfforts(panel: readonly ReviewPanelEntry[]): void {
  if (panel.some((entry) => entry.thinkingLevel === "off")) {
    throw new Error(
      "/review does not support thinking level 'off'; choose minimal, low, medium, high, or xhigh in --reviewer-models or your review config. Saved config entries are not changed.",
    );
  }
}

export function prepareReviewPlan(input: ReviewPipelineInput) {
  if (!input || typeof input !== "object") {
    throw new Error("Review pipeline input must be an object.");
  }
  if (!(input.scopeHint.trim() && input.invocationPacket.trim())) {
    throw new Error("Review pipeline scope and packet must be non-empty.");
  }
  if (!input.reviewers.length) {
    throw new Error("Review pipeline needs at least one reviewer role.");
  }
  for (const reviewer of input.reviewers) {
    if (!REVIEWERS.includes(reviewer)) {
      throw new Error(`Unknown review role '${reviewer}'.`);
    }
  }
  if (input.reviewerPanel.length < 1 || input.reviewerPanel.length > 4) {
    throw new Error("Review pipeline model panel must contain 1–4 entries.");
  }
  assertReviewEfforts(input.reviewerPanel);
  const models = new Set<string>();
  const reviewerPanel = input.reviewerPanel.map((entry) => {
    const model = entry.model.trim();
    if (!model) {
      throw new Error("Review pipeline model IDs cannot be blank.");
    }
    if (!EFFORTS.has(entry.thinkingLevel)) {
      throw new Error(`Invalid review effort '${entry.thinkingLevel}'.`);
    }
    if (models.has(model)) {
      throw new Error("Review pipeline model IDs must be unique.");
    }
    models.add(model);
    return { model, thinkingLevel: entry.thinkingLevel };
  });
  if (!(input.synthesizerModel.trim() && input.verifierModel.trim())) {
    throw new Error("Review pipeline downstream model IDs cannot be blank.");
  }
  return {
    scopeHint: input.scopeHint.trim(),
    invocationPacket: input.invocationPacket,
    reviewers: [...input.reviewers],
    reviewerPanel,
    synthesizerModel: input.synthesizerModel.trim(),
    verifierModel: input.verifierModel.trim(),
    projectGuidelines: input.projectGuidelines?.trim() || "",
  };
}
