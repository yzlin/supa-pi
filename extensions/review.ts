/**
 * Code Review Extension (inspired by Codex's review feature)
 *
 * Provides a `/review` command that prompts the agent to review code changes.
 * Reviews run in the current session; there is no dedicated review branch or `/end-review` step.
 * Supports multiple review modes:
 * - Review a GitHub pull request (checks out the PR locally)
 * - Review against a base branch (PR style)
 * - Review uncommitted changes
 * - Review a specific commit
 * - Shared custom review instructions (applied to all review modes when configured)
 *
 * Review workflow adapted in part from `@earendil-works/pi-review`
 * by earendil-works / Earendil:
 * https://github.com/earendil-works/pi-review
 *
 * Usage:
 * - `/review` - show interactive selector
 * - `/review pr 123` - review PR #123 (checks out locally)
 * - `/review pr https://github.com/owner/repo/pull/123` - review PR from URL
 * - `/review uncommitted` - review uncommitted changes directly
 * - `/review branch main` - review against main branch
 * - `/review commit abc123` - review specific commit
 * - `/review folder src docs` - review specific folders/files (snapshot, not diff)
 * - `/review --reviewers code-reviewer,security-reviewer` - choose reviewer agents explicitly
 * - `/review --auto-reviewers` - auto-select reviewer agents from the review scope
 * - `/review --extra "focus on performance regressions"` - add extra review instruction (works with any mode)
 * - `/review-summary` - summarize the latest review report into an action list
 * - `/review-fix` - implement findings from the latest review report
 *
 * Project-specific review guidelines:
 * - If a REVIEW_GUIDELINES.md file exists in the same directory as .pi,
 *   its contents are appended to the review prompt.
 *
 * Note: PR review requires a clean working tree (no uncommitted changes to tracked files).
 */

import { promises as fs } from "node:fs";
import path from "node:path";

import type {
  ExtensionAPI,
  ExtensionCommandContext,
  ExtensionContext,
} from "@mariozechner/pi-coding-agent";
import { DynamicBorder } from "@mariozechner/pi-coding-agent";
import {
  Container,
  fuzzyFilter,
  Input,
  type SelectItem,
  SelectList,
  Spacer,
  Text,
} from "@mariozechner/pi-tui";

type ReviewerAgent =
  | "code-reviewer"
  | "security-reviewer"
  | "database-reviewer";

type ReviewerSelectionMode = "auto" | "manual";

const ALL_REVIEWERS: ReviewerAgent[] = [
  "code-reviewer",
  "security-reviewer",
  "database-reviewer",
];
const DEFAULT_REVIEWERS: ReviewerAgent[] = ["code-reviewer"];

// State persisted across sessions for review configuration.
let reviewCustomInstructions: string | undefined = undefined;
let reviewSelectedAgents: ReviewerAgent[] = DEFAULT_REVIEWERS;
let reviewReviewerSelectionMode: ReviewerSelectionMode = "auto";

const REVIEW_SETTINGS_TYPE = "review-settings";
const GH_SETUP_INSTRUCTIONS =
  "Install GitHub CLI (`gh`) from https://cli.github.com/ (macOS: `brew install gh`), then sign in with `gh auth login` and verify with `gh auth status`.";
const PR_CHECKOUT_BLOCKED_BY_PENDING_CHANGES_MESSAGE =
  "Cannot checkout PR: you have uncommitted changes. Please commit or stash them first.";

type ReviewSettingsState = {
  customInstructions?: string;
  selectedReviewers?: ReviewerAgent[];
  reviewerSelectionMode?: ReviewerSelectionMode;
};

function isReviewerAgent(value: string): value is ReviewerAgent {
  return ALL_REVIEWERS.includes(value as ReviewerAgent);
}

function normalizeReviewerSelection(
  reviewers: readonly string[]
): ReviewerAgent[] {
  const normalized: ReviewerAgent[] = [];

  for (const reviewer of reviewers) {
    if (isReviewerAgent(reviewer) && !normalized.includes(reviewer)) {
      normalized.push(reviewer);
    }
  }

  return normalized.length ? normalized : DEFAULT_REVIEWERS;
}

function getReviewSettings(ctx: ExtensionContext): ReviewSettingsState {
  let state: ReviewSettingsState | undefined;
  for (const entry of ctx.sessionManager.getEntries()) {
    if (entry.type === "custom" && entry.customType === REVIEW_SETTINGS_TYPE) {
      state = entry.data as ReviewSettingsState | undefined;
    }
  }

  return {
    customInstructions: state?.customInstructions?.trim() || undefined,
    selectedReviewers: normalizeReviewerSelection(
      state?.selectedReviewers ?? []
    ),
    reviewerSelectionMode:
      state?.reviewerSelectionMode === "manual" ? "manual" : "auto",
  };
}

function applyReviewSettings(ctx: ExtensionContext) {
  const state = getReviewSettings(ctx);
  reviewCustomInstructions = state.customInstructions?.trim() || undefined;
  reviewSelectedAgents = state.selectedReviewers ?? DEFAULT_REVIEWERS;
  reviewReviewerSelectionMode = state.reviewerSelectionMode ?? "auto";
}

// Review target types (matching Codex's approach)
type ReviewTarget =
  | { type: "uncommitted" }
  | { type: "baseBranch"; branch: string }
  | { type: "commit"; sha: string; title?: string }
  | { type: "pullRequest"; prNumber: number; baseBranch: string; title: string }
  | { type: "folder"; paths: string[] };

// Prompts (adapted from Codex)
const UNCOMMITTED_PROMPT =
  "Review the current code changes (staged, unstaged, and untracked files) and provide prioritized findings.";

const BASE_BRANCH_PROMPT_WITH_MERGE_BASE =
  "Review the code changes against the base branch '{baseBranch}'. The merge base commit for this comparison is {mergeBaseSha}. Run `git diff {mergeBaseSha}` to inspect the changes relative to {baseBranch}. Provide prioritized, actionable findings.";

const BASE_BRANCH_PROMPT_FALLBACK =
  'Review the code changes against the base branch \'{branch}\'. Start by finding the merge diff between the current branch and {branch}\'s upstream e.g. (`git merge-base HEAD "$(git rev-parse --abbrev-ref "{branch}@{upstream}")"`), then run `git diff` against that SHA to see what changes we would merge into the {branch} branch. Provide prioritized, actionable findings.';

const COMMIT_PROMPT_WITH_TITLE =
  'Review the code changes introduced by commit {sha} ("{title}"). Provide prioritized, actionable findings.';

const COMMIT_PROMPT =
  "Review the code changes introduced by commit {sha}. Provide prioritized, actionable findings.";

const PULL_REQUEST_PROMPT =
  "Review pull request #{prNumber} (\"{title}\") against the base branch '{baseBranch}'. The merge base commit for this comparison is {mergeBaseSha}. Run `git diff {mergeBaseSha}` to inspect the changes that would be merged. Provide prioritized, actionable findings.";

const PULL_REQUEST_PROMPT_FALLBACK =
  "Review pull request #{prNumber} (\"{title}\") against the base branch '{baseBranch}'. Start by finding the merge base between the current branch and {baseBranch} (e.g., `git merge-base HEAD {baseBranch}`), then run `git diff` against that SHA to see the changes that would be merged. Provide prioritized, actionable findings.";

const FOLDER_REVIEW_PROMPT =
  "Review the code in the following paths: {paths}. This is a snapshot review (not a diff). Read the files directly in these paths and provide prioritized, actionable findings.";

// The detailed review rubric (adapted from Codex's review_prompt.md)
const REVIEW_RUBRIC = `# Review Guidelines

You are acting as a code reviewer for a proposed code change made by another engineer.

Below are default guidelines for determining what to flag. These are not the final word — if you encounter more specific guidelines elsewhere (in a developer message, user message, file, or project review guidelines appended below), those override these general instructions.

## Determining what to flag

Flag issues that:
1. Meaningfully impact the accuracy, performance, security, or maintainability of the code.
2. Are discrete and actionable (not general issues or multiple combined issues).
3. Don't demand rigor inconsistent with the rest of the codebase.
4. Were introduced in the changes being reviewed (not pre-existing bugs).
5. The author would likely fix if aware of them.
6. Don't rely on unstated assumptions about the codebase or author's intent.
7. Have provable impact on other parts of the code — it is not enough to speculate that a change may disrupt another part, you must identify the parts that are provably affected.
8. Are clearly not intentional changes by the author.
9. Be particularly careful with untrusted user input and follow the specific guidelines to review.
10. Treat silent local error recovery (especially parsing/IO/network fallbacks) as high-signal review candidates unless there is explicit boundary-level justification.

## Untrusted User Input

1. Be careful with open redirects, they must always be checked to only go to trusted domains (?next_page=...)
2. Always flag SQL that is not parametrized
3. In systems with user supplied URL input, http fetches always need to be protected against access to local resources (intercept DNS resolver!)
4. Escape, don't sanitize if you have the option (eg: HTML escaping)

## Comment guidelines

1. Be clear about why the issue is a problem.
2. Communicate severity appropriately - don't exaggerate.
3. Be brief - at most 1 paragraph.
4. Keep code snippets under 3 lines, wrapped in inline code or code blocks.
5. Use \`\`\`suggestion blocks ONLY for concrete replacement code (minimal lines; no commentary inside the block). Preserve the exact leading whitespace of the replaced lines.
6. Explicitly state scenarios/environments where the issue arises.
7. Use a matter-of-fact tone - helpful AI assistant, not accusatory.
8. Write for quick comprehension without close reading.
9. Avoid excessive flattery or unhelpful phrases like "Great job...".

## Review priorities

1. Surface critical non-blocking human callouts (migrations, dependency churn, auth/permissions, compatibility, destructive operations) at the end.
2. Prefer simple, direct solutions over wrappers or abstractions without clear value.
3. Treat back pressure handling as critical to system stability.
4. Apply system-level thinking; flag changes that increase operational risk or on-call wakeups.
5. Ensure that errors are always checked against codes or stable identifiers, never error messages.

## Fail-fast error handling (strict)

When reviewing added or modified error handling, default to fail-fast behavior.

1. Evaluate every new or changed \`try/catch\`: identify what can fail and why local handling is correct at that exact layer.
2. Prefer propagation over local recovery. If the current scope cannot fully recover while preserving correctness, rethrow (optionally with context) instead of returning fallbacks.
3. Flag catch blocks that hide failure signals (e.g. returning \`null\`/\`[]\`/\`false\`, swallowing JSON parse failures, logging-and-continue, or “best effort” silent recovery).
4. JSON parsing/decoding should fail loudly by default. Quiet fallback parsing is only acceptable with an explicit compatibility requirement and clear tested behavior.
5. Boundary handlers (HTTP routes, CLI entrypoints, supervisors) may translate errors, but must not pretend success or silently degrade.
6. If a catch exists only to satisfy lint/style without real handling, treat it as a bug.
7. When uncertain, prefer crashing fast over silent degradation.

## Required human callouts (non-blocking, at the very end)

After findings/verdict, you MUST append this final section:

## Human Reviewer Callouts (Non-Blocking)

Include only applicable callouts (no yes/no lines):

- **This change adds a database migration:** <files/details>
- **This change introduces a new dependency:** <package(s)/details>
- **This change changes a dependency (or the lockfile):** <files/package(s)/details>
- **This change modifies auth/permission behavior:** <what changed and where>
- **This change introduces backwards-incompatible public schema/API/contract changes:** <what changed and where>
- **This change includes irreversible or destructive operations:** <operation and scope>
- **This change adds or removes feature flags:** <feature flags changed> (call out re-use of dormant feature flags!)
- **This change changes configuration defaults:** <config var changed>

Rules for this section:
1. These are informational callouts for the human reviewer, not fix items.
2. Do not include them in Findings unless there is an independent defect.
3. These callouts alone must not change the verdict.
4. Only include callouts that apply to the reviewed change.
5. Keep each emitted callout bold exactly as written.
6. If none apply, write "- (none)".

## Priority levels

Tag each finding with a priority level in the title:
- [P0] - Drop everything to fix. Blocking release/operations. Only for universal issues that do not depend on assumptions about inputs.
- [P1] - Urgent. Should be addressed in the next cycle.
- [P2] - Normal. To be fixed eventually.
- [P3] - Low. Nice to have.

## Output format

Provide your findings in a clear, structured format:
1. List each finding with its priority tag, file location, and explanation.
2. Findings must reference locations that overlap with the actual diff — don't flag pre-existing code.
3. Keep line references as short as possible (avoid ranges over 5-10 lines; pick the most suitable subrange).
4. Provide an overall verdict: "correct" (no blocking issues) or "needs attention" (has blocking issues).
5. Ignore trivial style issues unless they obscure meaning or violate documented standards.
6. Do not generate a full PR fix — only flag issues and optionally provide short suggestion blocks.
7. End with the required "Human Reviewer Callouts (Non-Blocking)" section and all applicable bold callouts (no yes/no).

Output all findings the author would fix if they knew about them. If there are no qualifying findings, explicitly state the code looks good. Don't stop at the first finding - list every qualifying issue. Then append the required non-blocking callouts section.`;

const REVIEW_ORCHESTRATION_PROMPT = `# Multi-Reviewer Orchestration

You are orchestrating a code review.

You MUST use these reviewer agents when beneficial:
{reviewers}

Reviewer responsibilities:
- \`code-reviewer\`: general correctness, maintainability, performance, and operational risk
- \`security-reviewer\`: auth, permissions, secrets, input handling, and unsafe trust boundaries
- \`database-reviewer\`: schema, queries, migrations, indexes, transactions, and RLS

Instructions:
1. Delegate to the selected reviewer agents when useful.
2. Keep each reviewer focused on the reviewed change and relevant files only.
3. Merge reviewer outputs into one final report.
4. De-duplicate overlapping findings.
5. Prefer the highest-confidence, highest-severity version of overlapping findings.
6. Do not include speculative issues.
7. Only report issues introduced by the reviewed change or directly exposed by it.
8. Keep non-blocking human callouts separate from findings.

Required final output:

## Review Scope
- what was reviewed
- selected reviewer agents
- diff basis or snapshot basis

## Verdict
- correct
- needs attention

## Findings
For EACH finding, include:
- [P0]..[P3] and short title
- File location (\`path/to/file.ext:line\`)
- Source reviewer (\`code-reviewer\`, \`security-reviewer\`, or \`database-reviewer\`)
- Why it matters
- What should change

## Human Reviewer Callouts (Non-Blocking)
Include only applicable callouts.

## Reviewer Coverage
- code-reviewer: used / not used
- security-reviewer: used / not used
- database-reviewer: used / not used`;

async function loadProjectReviewGuidelines(
  cwd: string
): Promise<string | null> {
  let currentDir = path.resolve(cwd);

  while (true) {
    const piDir = path.join(currentDir, ".pi");
    const guidelinesPath = path.join(currentDir, "REVIEW_GUIDELINES.md");

    const piStats = await fs.stat(piDir).catch(() => null);
    if (piStats?.isDirectory()) {
      const guidelineStats = await fs.stat(guidelinesPath).catch(() => null);
      if (guidelineStats?.isFile()) {
        try {
          const content = await fs.readFile(guidelinesPath, "utf8");
          const trimmed = content.trim();
          return trimmed ? trimmed : null;
        } catch {
          return null;
        }
      }
      return null;
    }

    const parentDir = path.dirname(currentDir);
    if (parentDir === currentDir) {
      return null;
    }
    currentDir = parentDir;
  }
}

/**
 * Get the merge base between HEAD and a branch
 */
async function getMergeBase(
  pi: ExtensionAPI,
  branch: string
): Promise<string | null> {
  try {
    // First try to get the upstream tracking branch
    const { stdout: upstream, code: upstreamCode } = await pi.exec("git", [
      "rev-parse",
      "--abbrev-ref",
      `${branch}@{upstream}`,
    ]);

    if (upstreamCode === 0 && upstream.trim()) {
      const { stdout: mergeBase, code } = await pi.exec("git", [
        "merge-base",
        "HEAD",
        upstream.trim(),
      ]);
      if (code === 0 && mergeBase.trim()) {
        return mergeBase.trim();
      }
    }

    // Fall back to using the branch directly
    const { stdout: mergeBase, code } = await pi.exec("git", [
      "merge-base",
      "HEAD",
      branch,
    ]);
    if (code === 0 && mergeBase.trim()) {
      return mergeBase.trim();
    }

    return null;
  } catch {
    return null;
  }
}

/**
 * Get list of local branches
 */
async function getLocalBranches(pi: ExtensionAPI): Promise<string[]> {
  const { stdout, code } = await pi.exec("git", [
    "branch",
    "--format=%(refname:short)",
  ]);
  if (code !== 0) return [];
  return stdout
    .trim()
    .split("\n")
    .filter((b) => b.trim());
}

/**
 * Get list of recent commits
 */
async function getRecentCommits(
  pi: ExtensionAPI,
  limit: number = 10
): Promise<Array<{ sha: string; title: string }>> {
  const { stdout, code } = await pi.exec("git", [
    "log",
    `--oneline`,
    `-n`,
    `${limit}`,
  ]);
  if (code !== 0) return [];

  return stdout
    .trim()
    .split("\n")
    .filter((line) => line.trim())
    .map((line) => {
      const [sha, ...rest] = line.trim().split(" ");
      return { sha, title: rest.join(" ") };
    });
}

/**
 * Check if there are uncommitted changes (staged, unstaged, or untracked)
 */
async function hasUncommittedChanges(pi: ExtensionAPI): Promise<boolean> {
  const { stdout, code } = await pi.exec("git", ["status", "--porcelain"]);
  return code === 0 && stdout.trim().length > 0;
}

/**
 * Check if there are changes that would prevent switching branches
 * (staged or unstaged changes to tracked files - untracked files are fine)
 */
async function hasPendingChanges(pi: ExtensionAPI): Promise<boolean> {
  // Check for staged or unstaged changes to tracked files
  const { stdout, code } = await pi.exec("git", ["status", "--porcelain"]);
  if (code !== 0) return false;

  // Filter out untracked files (lines starting with ??)
  const lines = stdout
    .trim()
    .split("\n")
    .filter((line) => line.trim());
  const trackedChanges = lines.filter((line) => !line.startsWith("??"));
  return trackedChanges.length > 0;
}

/**
 * Parse a PR reference (URL or number) and return the PR number
 */
function parsePrReference(ref: string): number | null {
  const trimmed = ref.trim();

  // Try as a number first
  const num = parseInt(trimmed, 10);
  if (!isNaN(num) && num > 0) {
    return num;
  }

  // Try to extract from GitHub URL
  // Formats: https://github.com/owner/repo/pull/123
  //          github.com/owner/repo/pull/123
  const urlMatch = trimmed.match(/github\.com\/[^/]+\/[^/]+\/pull\/(\d+)/);
  if (urlMatch) {
    return parseInt(urlMatch[1], 10);
  }

  return null;
}

/**
 * Get PR information from GitHub CLI
 */
async function getPrInfo(
  pi: ExtensionAPI,
  prNumber: number
): Promise<{ baseBranch: string; title: string; headBranch: string } | null> {
  const { stdout, code } = await pi.exec("gh", [
    "pr",
    "view",
    String(prNumber),
    "--json",
    "baseRefName,title,headRefName",
  ]);

  if (code !== 0) return null;

  try {
    const data = JSON.parse(stdout);
    return {
      baseBranch: data.baseRefName,
      title: data.title,
      headBranch: data.headRefName,
    };
  } catch {
    return null;
  }
}

/**
 * Checkout a PR using GitHub CLI
 */
async function checkoutPr(
  pi: ExtensionAPI,
  prNumber: number
): Promise<{ success: boolean; error?: string }> {
  const { stdout, stderr, code } = await pi.exec("gh", [
    "pr",
    "checkout",
    String(prNumber),
  ]);

  if (code !== 0) {
    return {
      success: false,
      error: stderr || stdout || "Failed to checkout PR",
    };
  }

  return { success: true };
}

/**
 * Get the current branch name
 */
async function getCurrentBranch(pi: ExtensionAPI): Promise<string | null> {
  const { stdout, code } = await pi.exec("git", ["branch", "--show-current"]);
  if (code === 0 && stdout.trim()) {
    return stdout.trim();
  }
  return null;
}

/**
 * Get the default branch (main or master)
 */
async function getDefaultBranch(pi: ExtensionAPI): Promise<string> {
  // Try to get from remote HEAD
  const { stdout, code } = await pi.exec("git", [
    "symbolic-ref",
    "refs/remotes/origin/HEAD",
    "--short",
  ]);
  if (code === 0 && stdout.trim()) {
    return stdout.trim().replace("origin/", "");
  }

  // Fall back to checking if main or master exists
  const branches = await getLocalBranches(pi);
  if (branches.includes("main")) return "main";
  if (branches.includes("master")) return "master";

  return "main"; // Default fallback
}

/**
 * Build the review prompt based on target
 */
async function buildReviewPrompt(
  pi: ExtensionAPI,
  target: ReviewTarget
): Promise<string> {
  switch (target.type) {
    case "uncommitted":
      return UNCOMMITTED_PROMPT;

    case "baseBranch": {
      const mergeBase = await getMergeBase(pi, target.branch);
      const basePrompt = mergeBase
        ? BASE_BRANCH_PROMPT_WITH_MERGE_BASE.replace(
            /{baseBranch}/g,
            target.branch
          ).replace(/{mergeBaseSha}/g, mergeBase)
        : BASE_BRANCH_PROMPT_FALLBACK.replace(/{branch}/g, target.branch);
      return basePrompt;
    }

    case "commit":
      if (target.title) {
        return COMMIT_PROMPT_WITH_TITLE.replace("{sha}", target.sha).replace(
          "{title}",
          target.title
        );
      }
      return COMMIT_PROMPT.replace("{sha}", target.sha);

    case "pullRequest": {
      const mergeBase = await getMergeBase(pi, target.baseBranch);
      const basePrompt = mergeBase
        ? PULL_REQUEST_PROMPT.replace(/{prNumber}/g, String(target.prNumber))
            .replace(/{title}/g, target.title)
            .replace(/{baseBranch}/g, target.baseBranch)
            .replace(/{mergeBaseSha}/g, mergeBase)
        : PULL_REQUEST_PROMPT_FALLBACK.replace(
            /{prNumber}/g,
            String(target.prNumber)
          )
            .replace(/{title}/g, target.title)
            .replace(/{baseBranch}/g, target.baseBranch);
      return basePrompt;
    }

    case "folder":
      return FOLDER_REVIEW_PROMPT.replace("{paths}", target.paths.join(", "));
  }
}

/**
 * Get user-facing hint for the review target
 */
function getUserFacingHint(target: ReviewTarget): string {
  switch (target.type) {
    case "uncommitted":
      return "current changes";
    case "baseBranch":
      return `changes against '${target.branch}'`;
    case "commit": {
      const shortSha = target.sha.slice(0, 7);
      return target.title
        ? `commit ${shortSha}: ${target.title}`
        : `commit ${shortSha}`;
    }

    case "pullRequest": {
      const shortTitle =
        target.title.length > 30
          ? target.title.slice(0, 27) + "..."
          : target.title;
      return `PR #${target.prNumber}: ${shortTitle}`;
    }

    case "folder": {
      const joined = target.paths.join(", ");
      return joined.length > 40
        ? `folders: ${joined.slice(0, 37)}...`
        : `folders: ${joined}`;
    }
  }
}

// Review preset options for the selector (keep this order stable)
const REVIEW_PRESETS = [
  {
    value: "uncommitted",
    label: "Review uncommitted changes",
    description: "",
  },
  {
    value: "baseBranch",
    label: "Review against a base branch",
    description: "(local)",
  },
  { value: "commit", label: "Review a commit", description: "" },
  {
    value: "pullRequest",
    label: "Review a pull request",
    description: "(GitHub PR)",
  },
  {
    value: "folder",
    label: "Review a folder (or more)",
    description: "(snapshot, not diff)",
  },
] as const;

const TOGGLE_CUSTOM_INSTRUCTIONS_VALUE = "toggleCustomInstructions" as const;

type ReviewPresetValue =
  | (typeof REVIEW_PRESETS)[number]["value"]
  | typeof TOGGLE_CUSTOM_INSTRUCTIONS_VALUE;

function persistReviewSettings(pi: ExtensionAPI) {
  pi.appendEntry(REVIEW_SETTINGS_TYPE, {
    customInstructions: reviewCustomInstructions,
    selectedReviewers: reviewSelectedAgents,
    reviewerSelectionMode: reviewReviewerSelectionMode,
  });
}

function setReviewSelection(
  pi: ExtensionAPI,
  reviewers: ReviewerAgent[],
  selectionMode: ReviewerSelectionMode
) {
  reviewSelectedAgents = normalizeReviewerSelection(reviewers);
  reviewReviewerSelectionMode = selectionMode;
  persistReviewSettings(pi);
}

function setReviewCustomInstructions(
  pi: ExtensionAPI,
  instructions: string | undefined
) {
  reviewCustomInstructions = instructions?.trim() || undefined;
  persistReviewSettings(pi);
}

type SessionMessageLike = {
  role?: string;
  content?: string | Array<{ type?: string; text?: string }>;
};

function extractTextContent(content: SessionMessageLike["content"]): string {
  if (typeof content === "string") {
    return content.trim();
  }

  if (!Array.isArray(content)) {
    return "";
  }

  return content
    .flatMap((part) =>
      part?.type === "text" && typeof part.text === "string" ? [part.text] : []
    )
    .join("\n")
    .trim();
}

function looksLikeReviewReport(text: string): boolean {
  const normalized = text.trim();
  return (
    normalized.includes("## Verdict") &&
    normalized.includes("## Findings") &&
    normalized.includes("Human Reviewer Callouts")
  );
}

function isReviewSummaryReport(text: string): boolean {
  return (
    looksLikeReviewReport(text) && normalizedIncludes(text, "## Fix Queue")
  );
}

function normalizedIncludes(text: string, needle: string): boolean {
  return text.toLowerCase().includes(needle.toLowerCase());
}

function getLatestReviewReport(
  ctx: ExtensionCommandContext,
  options: { preferSummary?: boolean; excludeSummary?: boolean } = {}
): string {
  const branch = ctx.sessionManager.getBranch();
  let fallback = "";

  for (let i = branch.length - 1; i >= 0; i--) {
    const entry = branch[i];
    if (entry?.type !== "message") {
      continue;
    }

    const message = entry.message as SessionMessageLike;
    if (message.role !== "assistant") {
      continue;
    }

    const text = extractTextContent(message.content);
    if (!looksLikeReviewReport(text)) {
      continue;
    }

    if (options.excludeSummary && isReviewSummaryReport(text)) {
      continue;
    }

    if (options.preferSummary && isReviewSummaryReport(text)) {
      return text;
    }

    if (!fallback) {
      fallback = text;
    }
  }

  return fallback;
}

const REVIEW_SUMMARY_FROM_REPORT_PROMPT = `Use the review report below and produce a concise, implementation-ready summary.

Rules:
1. Use only findings that are present in the report.
2. Do not invent new issues.
3. Preserve exact file paths, priorities, and source reviewer when available.
4. Keep the result compact and actionable.
5. If the report says the code looks good, state that explicitly and keep Findings/ Fix Queue empty.

Required sections (in order):
- ## Review Scope
- ## Verdict
- ## Findings
- ## Fix Queue
- ## Human Reviewer Callouts (Non-Blocking)
- ## Reviewer Coverage`;

function buildReviewSummaryMessage(
  reviewReport: string,
  extraInstruction?: string
): string {
  let message = `${REVIEW_SUMMARY_FROM_REPORT_PROMPT}\n\n<review_report>\n${reviewReport}\n</review_report>`;

  if (extraInstruction?.trim()) {
    message += `\n\nAdditional instruction:\n${extraInstruction.trim()}`;
  }

  return message;
}

const REVIEW_FIX_FROM_REPORT_PROMPT = `Use the review report below and implement the valid findings now.

Instructions:
1. Treat Findings/Fix Queue as the implementation checklist.
2. Fix in priority order: P0, P1, then P2. Include P3 only if quick and safe.
3. If a finding is invalid, already fixed, or not possible right now, briefly explain why and continue.
4. Treat Human Reviewer Callouts as informational only unless there is a separate explicit finding.
5. Follow fail-fast error handling: do not add silent local recovery unless this scope is a real boundary that can translate the failure correctly.
6. Run relevant checks for touched code where practical.
7. End with fixed items, deferred/skipped items with reasons, and verification results.`;

function buildReviewFixMessage(
  reviewReport: string,
  extraInstruction?: string
): string {
  let message = `${REVIEW_FIX_FROM_REPORT_PROMPT}\n\n<review_report>\n${reviewReport}\n</review_report>`;

  if (extraInstruction?.trim()) {
    message += `\n\nAdditional instruction:\n${extraInstruction.trim()}`;
  }

  return message;
}

function dispatchFollowUpMessage(
  pi: ExtensionAPI,
  ctx: ExtensionCommandContext,
  message: string,
  queuedNotice: string
): void {
  if (ctx.isIdle()) {
    pi.sendUserMessage(message);
    return;
  }

  pi.sendUserMessage(message, { deliverAs: "followUp" });
  ctx.ui.notify(queuedNotice, "info");
}

export default function reviewExtension(pi: ExtensionAPI) {
  function applyAllReviewState(ctx: ExtensionContext) {
    applyReviewSettings(ctx);
  }

  async function ensureGithubCliReady(ctx: ExtensionContext): Promise<boolean> {
    const ghVersion = await pi.exec("gh", ["--version"]);
    if (ghVersion.code !== 0) {
      ctx.ui.notify(
        `PR review requires GitHub CLI (\`gh\`). ${GH_SETUP_INSTRUCTIONS}`,
        "error"
      );
      return false;
    }

    const ghAuthStatus = await pi.exec("gh", ["auth", "status"]);
    if (ghAuthStatus.code !== 0) {
      ctx.ui.notify(
        "GitHub CLI is installed, but you're not signed in. Run `gh auth login`, then verify with `gh auth status`.",
        "error"
      );
      return false;
    }

    return true;
  }

  async function resolvePullRequestTarget(
    ctx: ExtensionContext,
    ref: string,
    options: { skipInitialPendingChangesCheck?: boolean } = {}
  ): Promise<ReviewTarget | null> {
    if (!(await ensureGithubCliReady(ctx))) {
      return null;
    }

    if (
      !options.skipInitialPendingChangesCheck &&
      (await hasPendingChanges(pi))
    ) {
      ctx.ui.notify(PR_CHECKOUT_BLOCKED_BY_PENDING_CHANGES_MESSAGE, "error");
      return null;
    }

    const prNumber = parsePrReference(ref);
    if (!prNumber) {
      ctx.ui.notify(
        "Invalid PR reference. Enter a number or GitHub PR URL.",
        "error"
      );
      return null;
    }

    ctx.ui.notify(`Fetching PR #${prNumber} info...`, "info");
    const prInfo = await getPrInfo(pi, prNumber);

    if (!prInfo) {
      ctx.ui.notify(
        `Could not fetch PR #${prNumber}. Make sure it exists and your GitHub auth has access (check with \`gh auth status\`).`,
        "error"
      );
      return null;
    }

    // Re-check right before checkout to avoid switching branches with newly introduced changes.
    if (await hasPendingChanges(pi)) {
      ctx.ui.notify(PR_CHECKOUT_BLOCKED_BY_PENDING_CHANGES_MESSAGE, "error");
      return null;
    }

    ctx.ui.notify(`Checking out PR #${prNumber}...`, "info");
    const checkoutResult = await checkoutPr(pi, prNumber);

    if (!checkoutResult.success) {
      ctx.ui.notify(`Failed to checkout PR: ${checkoutResult.error}`, "error");
      return null;
    }

    ctx.ui.notify(`Checked out PR #${prNumber} (${prInfo.headBranch})`, "info");

    return {
      type: "pullRequest",
      prNumber,
      baseBranch: prInfo.baseBranch,
      title: prInfo.title,
    };
  }

  pi.on("session_start", (_event, ctx) => {
    applyAllReviewState(ctx);
  });

  pi.on("session_tree", (_event, ctx) => {
    applyAllReviewState(ctx);
  });

  /**
   * Determine the smart default review type based on git state
   */
  async function getSmartDefault(): Promise<
    "uncommitted" | "baseBranch" | "commit"
  > {
    // Priority 1: If there are uncommitted changes, default to reviewing them
    if (await hasUncommittedChanges(pi)) {
      return "uncommitted";
    }

    // Priority 2: If on a feature branch (not the default branch), default to PR-style review
    const currentBranch = await getCurrentBranch(pi);
    const defaultBranch = await getDefaultBranch(pi);
    if (currentBranch && currentBranch !== defaultBranch) {
      return "baseBranch";
    }

    // Priority 3: Default to reviewing a specific commit
    return "commit";
  }

  /**
   * Show the review preset selector
   */
  async function showReviewSelector(
    ctx: ExtensionContext
  ): Promise<ReviewTarget | null> {
    // Determine smart default (but keep the list order stable)
    const smartDefault = await getSmartDefault();
    const presetItems: SelectItem[] = REVIEW_PRESETS.map((preset) => ({
      value: preset.value,
      label: preset.label,
      description: preset.description,
    }));
    const smartDefaultIndex = presetItems.findIndex(
      (item) => item.value === smartDefault
    );

    while (true) {
      const customInstructionsLabel = reviewCustomInstructions
        ? "Remove custom review instructions"
        : "Add custom review instructions";
      const customInstructionsDescription = reviewCustomInstructions
        ? "(currently set)"
        : "(applies to all review modes)";
      const items: SelectItem[] = [
        ...presetItems,
        {
          value: TOGGLE_CUSTOM_INSTRUCTIONS_VALUE,
          label: customInstructionsLabel,
          description: customInstructionsDescription,
        },
      ];

      const result = await ctx.ui.custom<ReviewPresetValue | null>(
        (tui, theme, _kb, done) => {
          const container = new Container();
          container.addChild(
            new DynamicBorder((str) => theme.fg("accent", str))
          );
          container.addChild(
            new Text(theme.fg("accent", theme.bold("Select a review preset")))
          );

          const selectList = new SelectList(items, Math.min(items.length, 10), {
            selectedPrefix: (text) => theme.fg("accent", text),
            selectedText: (text) => theme.fg("accent", text),
            description: (text) => theme.fg("muted", text),
            scrollInfo: (text) => theme.fg("dim", text),
            noMatch: (text) => theme.fg("warning", text),
          });

          // Preselect the smart default without reordering the list
          if (smartDefaultIndex >= 0) {
            selectList.setSelectedIndex(smartDefaultIndex);
          }

          selectList.onSelect = (item) => done(item.value as ReviewPresetValue);
          selectList.onCancel = () => done(null);

          container.addChild(selectList);
          container.addChild(
            new Text(
              theme.fg("dim", "Press enter to confirm or esc to go back")
            )
          );
          container.addChild(
            new DynamicBorder((str) => theme.fg("accent", str))
          );

          return {
            render(width: number) {
              return container.render(width);
            },
            invalidate() {
              container.invalidate();
            },
            handleInput(data: string) {
              selectList.handleInput(data);
              tui.requestRender();
            },
          };
        }
      );

      if (!result) return null;

      if (result === TOGGLE_CUSTOM_INSTRUCTIONS_VALUE) {
        if (reviewCustomInstructions) {
          setReviewCustomInstructions(pi, undefined);
          ctx.ui.notify("Custom review instructions removed", "info");
          continue;
        }

        const customInstructions = await ctx.ui.editor(
          "Enter custom review instructions (applies to all review modes):",
          ""
        );

        if (!customInstructions?.trim()) {
          ctx.ui.notify("Custom review instructions not changed", "info");
          continue;
        }

        setReviewCustomInstructions(pi, customInstructions);
        ctx.ui.notify("Custom review instructions saved", "info");
        continue;
      }

      // Handle each preset type
      switch (result) {
        case "uncommitted":
          return { type: "uncommitted" };

        case "baseBranch": {
          const target = await showBranchSelector(ctx);
          if (target) return target;
          break;
        }

        case "commit": {
          const target = await showCommitSelector(ctx);
          if (target) return target;
          break;
        }

        case "folder": {
          const target = await showFolderInput(ctx);
          if (target) return target;
          break;
        }

        case "pullRequest": {
          const target = await showPrInput(ctx);
          if (target) return target;
          break;
        }

        default:
          return null;
      }
    }
  }

  /**
   * Show branch selector for base branch review
   */
  async function showBranchSelector(
    ctx: ExtensionContext
  ): Promise<ReviewTarget | null> {
    const branches = await getLocalBranches(pi);
    const currentBranch = await getCurrentBranch(pi);
    const defaultBranch = await getDefaultBranch(pi);

    // Never offer the current branch as a base branch (reviewing against itself is meaningless).
    const candidateBranches = currentBranch
      ? branches.filter((b) => b !== currentBranch)
      : branches;

    if (candidateBranches.length === 0) {
      ctx.ui.notify(
        currentBranch
          ? `No other branches found (current branch: ${currentBranch})`
          : "No branches found",
        "error"
      );
      return null;
    }

    // Sort branches with default branch first
    const sortedBranches = candidateBranches.sort((a, b) => {
      if (a === defaultBranch) return -1;
      if (b === defaultBranch) return 1;
      return a.localeCompare(b);
    });

    const items: SelectItem[] = sortedBranches.map((branch) => ({
      value: branch,
      label: branch,
      description: branch === defaultBranch ? "(default)" : "",
    }));

    const result = await ctx.ui.custom<string | null>(
      (tui, theme, keybindings, done) => {
        const container = new Container();
        container.addChild(new DynamicBorder((str) => theme.fg("accent", str)));
        container.addChild(
          new Text(theme.fg("accent", theme.bold("Select base branch")))
        );

        const searchInput = new Input();
        container.addChild(searchInput);
        container.addChild(new Spacer(1));

        const listContainer = new Container();
        container.addChild(listContainer);
        container.addChild(
          new Text(
            theme.fg("dim", "Type to filter • enter to select • esc to cancel")
          )
        );
        container.addChild(new DynamicBorder((str) => theme.fg("accent", str)));

        let filteredItems = items;
        let selectList: SelectList | null = null;

        const updateList = () => {
          listContainer.clear();
          if (filteredItems.length === 0) {
            listContainer.addChild(
              new Text(theme.fg("warning", "  No matching branches"))
            );
            selectList = null;
            return;
          }

          selectList = new SelectList(
            filteredItems,
            Math.min(filteredItems.length, 10),
            {
              selectedPrefix: (text) => theme.fg("accent", text),
              selectedText: (text) => theme.fg("accent", text),
              description: (text) => theme.fg("muted", text),
              scrollInfo: (text) => theme.fg("dim", text),
              noMatch: (text) => theme.fg("warning", text),
            }
          );

          selectList.onSelect = (item) => done(item.value);
          selectList.onCancel = () => done(null);
          listContainer.addChild(selectList);
        };

        const applyFilter = () => {
          const query = searchInput.getValue();
          filteredItems = query
            ? fuzzyFilter(
                items,
                query,
                (item) =>
                  `${item.label} ${item.value} ${item.description ?? ""}`
              )
            : items;
          updateList();
        };

        applyFilter();

        return {
          render(width: number) {
            return container.render(width);
          },
          invalidate() {
            container.invalidate();
          },
          handleInput(data: string) {
            if (
              keybindings.matches(data, "tui.select.up") ||
              keybindings.matches(data, "tui.select.down") ||
              keybindings.matches(data, "tui.select.confirm") ||
              keybindings.matches(data, "tui.select.cancel")
            ) {
              if (selectList) {
                selectList.handleInput(data);
              } else if (keybindings.matches(data, "tui.select.cancel")) {
                done(null);
              }
              tui.requestRender();
              return;
            }

            searchInput.handleInput(data);
            applyFilter();
            tui.requestRender();
          },
        };
      }
    );

    if (!result) return null;
    return { type: "baseBranch", branch: result };
  }

  /**
   * Show commit selector
   */
  async function showCommitSelector(
    ctx: ExtensionContext
  ): Promise<ReviewTarget | null> {
    const commits = await getRecentCommits(pi, 20);

    if (commits.length === 0) {
      ctx.ui.notify("No commits found", "error");
      return null;
    }

    const items: SelectItem[] = commits.map((commit) => ({
      value: commit.sha,
      label: `${commit.sha.slice(0, 7)} ${commit.title}`,
      description: "",
    }));

    const result = await ctx.ui.custom<{ sha: string; title: string } | null>(
      (tui, theme, keybindings, done) => {
        const container = new Container();
        container.addChild(new DynamicBorder((str) => theme.fg("accent", str)));
        container.addChild(
          new Text(theme.fg("accent", theme.bold("Select commit to review")))
        );

        const searchInput = new Input();
        container.addChild(searchInput);
        container.addChild(new Spacer(1));

        const listContainer = new Container();
        container.addChild(listContainer);
        container.addChild(
          new Text(
            theme.fg("dim", "Type to filter • enter to select • esc to cancel")
          )
        );
        container.addChild(new DynamicBorder((str) => theme.fg("accent", str)));

        let filteredItems = items;
        let selectList: SelectList | null = null;

        const updateList = () => {
          listContainer.clear();
          if (filteredItems.length === 0) {
            listContainer.addChild(
              new Text(theme.fg("warning", "  No matching commits"))
            );
            selectList = null;
            return;
          }

          selectList = new SelectList(
            filteredItems,
            Math.min(filteredItems.length, 10),
            {
              selectedPrefix: (text) => theme.fg("accent", text),
              selectedText: (text) => theme.fg("accent", text),
              description: (text) => theme.fg("muted", text),
              scrollInfo: (text) => theme.fg("dim", text),
              noMatch: (text) => theme.fg("warning", text),
            }
          );

          selectList.onSelect = (item) => {
            const commit = commits.find((c) => c.sha === item.value);
            if (commit) {
              done(commit);
            } else {
              done(null);
            }
          };
          selectList.onCancel = () => done(null);
          listContainer.addChild(selectList);
        };

        const applyFilter = () => {
          const query = searchInput.getValue();
          filteredItems = query
            ? fuzzyFilter(
                items,
                query,
                (item) =>
                  `${item.label} ${item.value} ${item.description ?? ""}`
              )
            : items;
          updateList();
        };

        applyFilter();

        return {
          render(width: number) {
            return container.render(width);
          },
          invalidate() {
            container.invalidate();
          },
          handleInput(data: string) {
            if (
              keybindings.matches(data, "tui.select.up") ||
              keybindings.matches(data, "tui.select.down") ||
              keybindings.matches(data, "tui.select.confirm") ||
              keybindings.matches(data, "tui.select.cancel")
            ) {
              if (selectList) {
                selectList.handleInput(data);
              } else if (keybindings.matches(data, "tui.select.cancel")) {
                done(null);
              }
              tui.requestRender();
              return;
            }

            searchInput.handleInput(data);
            applyFilter();
            tui.requestRender();
          },
        };
      }
    );

    if (!result) return null;
    return { type: "commit", sha: result.sha, title: result.title };
  }

  function parseReviewPaths(value: string): string[] {
    return value
      .split(/\s+/)
      .map((item) => item.trim())
      .filter((item) => item.length > 0);
  }

  function parseReviewerList(value: string): ReviewerAgent[] {
    return value
      .split(",")
      .map((item) => item.trim())
      .filter(isReviewerAgent);
  }

  function normalizeStatusPaths(lines: string[]): string[] {
    return lines
      .map((line) => {
        const trimmed = line.trim();
        if (trimmed.startsWith("?? ")) {
          return trimmed.slice(3);
        }

        const pathPortion =
          trimmed.length > 3 ? trimmed.slice(3).trim() : trimmed;
        const renameParts = pathPortion.split(" -> ");
        return renameParts[renameParts.length - 1]?.trim() || pathPortion;
      })
      .filter(Boolean);
  }

  function matchesAnyPattern(value: string, patterns: RegExp[]): boolean {
    return patterns.some((pattern) => pattern.test(value));
  }

  async function getChangedPaths(target: ReviewTarget): Promise<string[]> {
    const run = async (args: string[]) => {
      const { stdout, code } = await pi.exec("git", args);
      if (code !== 0) return [];
      return stdout
        .trim()
        .split("\n")
        .map((line) => line.trim())
        .filter(Boolean);
    };

    switch (target.type) {
      case "uncommitted":
        return normalizeStatusPaths(await run(["status", "--porcelain"]));

      case "baseBranch": {
        const mergeBase = await getMergeBase(pi, target.branch);
        return mergeBase ? run(["diff", "--name-only", mergeBase]) : [];
      }

      case "commit":
        return run([
          "diff-tree",
          "--no-commit-id",
          "--name-only",
          "-r",
          target.sha,
        ]);

      case "pullRequest": {
        const mergeBase = await getMergeBase(pi, target.baseBranch);
        return mergeBase ? run(["diff", "--name-only", mergeBase]) : [];
      }

      case "folder":
        return target.paths;
    }
  }

  async function detectReviewers(
    target: ReviewTarget
  ): Promise<ReviewerAgent[]> {
    const paths = await getChangedPaths(target);
    const reviewers = new Set<ReviewerAgent>(["code-reviewer"]);

    const securityPatterns = [
      /(^|\/)(auth|permissions?|middleware|webhooks?|api|server)\//i,
      /(^|\/)(cookies?|headers?|redirects?)\b/i,
      /(^|\/)\.env/i,
      /(^|\/)(config|security)\//i,
    ];

    const databasePatterns = [
      /(^|\/)(db|database|migrations?|schema|sql|supabase)\//i,
      /\.sql$/i,
    ];

    for (const path of paths) {
      if (matchesAnyPattern(path, securityPatterns)) {
        reviewers.add("security-reviewer");
      }
      if (matchesAnyPattern(path, databasePatterns)) {
        reviewers.add("database-reviewer");
      }
    }

    return Array.from(reviewers);
  }

  async function resolveReviewers(
    ctx: ExtensionContext,
    target: ReviewTarget,
    preselectedReviewers?: ReviewerAgent[],
    useAutoReviewers?: boolean
  ): Promise<{
    reviewers: ReviewerAgent[];
    selectionMode: ReviewerSelectionMode;
  } | null> {
    if (useAutoReviewers) {
      return {
        reviewers: await detectReviewers(target),
        selectionMode: "auto",
      };
    }

    if (preselectedReviewers?.length) {
      return {
        reviewers: normalizeReviewerSelection(preselectedReviewers),
        selectionMode: "manual",
      };
    }

    const autoReviewers = await detectReviewers(target);
    const choice = await ctx.ui.select("Select reviewer set:", [
      `Auto (${autoReviewers.join(", ")})`,
      "General only",
      "General + Security",
      "General + Database",
      "Custom",
    ]);

    if (!choice) return null;

    if (choice.startsWith("Auto")) {
      return { reviewers: autoReviewers, selectionMode: "auto" };
    }
    if (choice === "General only") {
      return { reviewers: ["code-reviewer"], selectionMode: "manual" };
    }
    if (choice === "General + Security") {
      return {
        reviewers: ["code-reviewer", "security-reviewer"],
        selectionMode: "manual",
      };
    }
    if (choice === "General + Database") {
      return {
        reviewers: ["code-reviewer", "database-reviewer"],
        selectionMode: "manual",
      };
    }

    const customReviewers = await ctx.ui.editor(
      "Enter reviewers (comma-separated): code-reviewer, security-reviewer, database-reviewer",
      reviewSelectedAgents.join(", ")
    );
    if (!customReviewers?.trim()) return null;

    const customParsedReviewers = parseReviewerList(customReviewers);
    if (!customParsedReviewers.length) {
      ctx.ui.notify("No valid reviewers selected", "error");
      return null;
    }

    return {
      reviewers: normalizeReviewerSelection(customParsedReviewers),
      selectionMode: "manual",
    };
  }

  /**
   * Show folder input
   */
  async function showFolderInput(
    ctx: ExtensionContext
  ): Promise<ReviewTarget | null> {
    const result = await ctx.ui.editor(
      "Enter folders/files to review (space-separated or one per line):",
      "."
    );

    if (!result?.trim()) return null;
    const paths = parseReviewPaths(result);
    if (paths.length === 0) return null;

    return { type: "folder", paths };
  }

  /**
   * Show PR input and handle checkout
   */
  async function showPrInput(
    ctx: ExtensionContext
  ): Promise<ReviewTarget | null> {
    // First check for pending changes that would prevent branch switching
    if (await hasPendingChanges(pi)) {
      ctx.ui.notify(PR_CHECKOUT_BLOCKED_BY_PENDING_CHANGES_MESSAGE, "error");
      return null;
    }

    // Get PR reference from user
    const prRef = await ctx.ui.editor(
      "Enter PR number or URL (e.g. 123 or https://github.com/owner/repo/pull/123):",
      ""
    );

    if (!prRef?.trim()) return null;

    return await resolvePullRequestTarget(ctx, prRef, {
      skipInitialPendingChangesCheck: true,
    });
  }

  /**
   * Execute the review
   */
  async function executeReview(
    ctx: ExtensionCommandContext,
    target: ReviewTarget,
    options?: { extraInstruction?: string; reviewers?: ReviewerAgent[] }
  ): Promise<boolean> {
    const prompt = await buildReviewPrompt(pi, target);
    const hint = getUserFacingHint(target);
    const projectGuidelines = await loadProjectReviewGuidelines(ctx.cwd);
    const reviewers = normalizeReviewerSelection(
      options?.reviewers ?? reviewSelectedAgents
    );
    const orchestrationPrompt = REVIEW_ORCHESTRATION_PROMPT.replace(
      "{reviewers}",
      reviewers.map((reviewer) => `- ${reviewer}`).join("\n")
    );

    let fullPrompt = `${orchestrationPrompt}\n\n---\n\n${REVIEW_RUBRIC}\n\n---\n\nPlease perform a code review with the following focus:\n\n${prompt}`;

    if (reviewCustomInstructions) {
      fullPrompt += `\n\nShared custom review instructions (applies to all reviews):\n\n${reviewCustomInstructions}`;
    }

    if (options?.extraInstruction?.trim()) {
      fullPrompt += `\n\nAdditional user-provided review instruction:\n\n${options.extraInstruction.trim()}`;
    }

    if (projectGuidelines) {
      fullPrompt += `\n\nThis project has additional instructions for code reviews:\n\n${projectGuidelines}`;
    }

    ctx.ui.notify(`Starting review: ${hint} [${reviewers.join(", ")}]`, "info");

    pi.sendUserMessage(fullPrompt);
    return true;
  }

  /**
   * Parse command arguments for direct invocation
   * Returns the target or a special marker for PR that needs async handling
   */
  type ParsedReviewArgs = {
    target: ReviewTarget | { type: "pr"; ref: string } | null;
    extraInstruction?: string;
    reviewers?: ReviewerAgent[];
    useAutoReviewers?: boolean;
    error?: string;
  };

  function tokenizeArgs(value: string): string[] {
    const tokens: string[] = [];
    let current = "";
    let quote: '"' | "'" | null = null;

    for (let i = 0; i < value.length; i++) {
      const char = value[i];

      if (quote) {
        if (char === "\\" && i + 1 < value.length) {
          current += value[i + 1];
          i += 1;
          continue;
        }
        if (char === quote) {
          quote = null;
          continue;
        }
        current += char;
        continue;
      }

      if (char === '"' || char === "'") {
        quote = char;
        continue;
      }

      if (/\s/.test(char)) {
        if (current.length > 0) {
          tokens.push(current);
          current = "";
        }
        continue;
      }

      current += char;
    }

    if (current.length > 0) {
      tokens.push(current);
    }

    return tokens;
  }

  function parseArgs(args: string | undefined): ParsedReviewArgs {
    if (!args?.trim()) return { target: null };

    const rawParts = tokenizeArgs(args.trim());
    const parts: string[] = [];
    let extraInstruction: string | undefined;
    let reviewers: ReviewerAgent[] | undefined;
    let useAutoReviewers = false;

    for (let i = 0; i < rawParts.length; i++) {
      const part = rawParts[i];
      if (part === "--extra") {
        const next = rawParts[i + 1];
        if (!next) {
          return { target: null, error: "Missing value for --extra" };
        }
        extraInstruction = next;
        i += 1;
        continue;
      }

      if (part.startsWith("--extra=")) {
        extraInstruction = part.slice("--extra=".length);
        continue;
      }

      if (part === "--reviewers") {
        const next = rawParts[i + 1];
        if (!next) {
          return { target: null, error: "Missing value for --reviewers" };
        }
        const parsedReviewers = parseReviewerList(next);
        if (!parsedReviewers.length) {
          return { target: null, error: "No valid reviewers in --reviewers" };
        }
        reviewers = normalizeReviewerSelection(parsedReviewers);
        i += 1;
        continue;
      }

      if (part.startsWith("--reviewers=")) {
        const parsedReviewers = parseReviewerList(
          part.slice("--reviewers=".length)
        );
        if (!parsedReviewers.length) {
          return { target: null, error: "No valid reviewers in --reviewers" };
        }
        reviewers = normalizeReviewerSelection(parsedReviewers);
        continue;
      }

      if (part === "--auto-reviewers") {
        useAutoReviewers = true;
        continue;
      }

      parts.push(part);
    }

    if (reviewers?.length && useAutoReviewers) {
      return {
        target: null,
        error: "Use either --reviewers or --auto-reviewers, not both",
      };
    }

    if (parts.length === 0) {
      return { target: null, extraInstruction, reviewers, useAutoReviewers };
    }

    const subcommand = parts[0]?.toLowerCase();

    switch (subcommand) {
      case "uncommitted":
        return {
          target: { type: "uncommitted" },
          extraInstruction,
          reviewers,
          useAutoReviewers,
        };

      case "branch": {
        const branch = parts[1];
        if (!branch)
          return {
            target: null,
            extraInstruction,
            reviewers,
            useAutoReviewers,
          };
        return {
          target: { type: "baseBranch", branch },
          extraInstruction,
          reviewers,
          useAutoReviewers,
        };
      }

      case "commit": {
        const sha = parts[1];
        if (!sha)
          return {
            target: null,
            extraInstruction,
            reviewers,
            useAutoReviewers,
          };
        const title = parts.slice(2).join(" ") || undefined;
        return {
          target: { type: "commit", sha, title },
          extraInstruction,
          reviewers,
          useAutoReviewers,
        };
      }

      case "folder": {
        const paths = parseReviewPaths(parts.slice(1).join(" "));
        if (paths.length === 0)
          return {
            target: null,
            extraInstruction,
            reviewers,
            useAutoReviewers,
          };
        return {
          target: { type: "folder", paths },
          extraInstruction,
          reviewers,
          useAutoReviewers,
        };
      }

      case "pr": {
        const ref = parts[1];
        if (!ref)
          return {
            target: null,
            extraInstruction,
            reviewers,
            useAutoReviewers,
          };
        return {
          target: { type: "pr", ref },
          extraInstruction,
          reviewers,
          useAutoReviewers,
        };
      }

      default:
        return { target: null, extraInstruction, reviewers, useAutoReviewers };
    }
  }

  /**
   * Handle PR checkout and return a ReviewTarget (or null on failure)
   */
  async function handlePrCheckout(
    ctx: ExtensionContext,
    ref: string
  ): Promise<ReviewTarget | null> {
    return await resolvePullRequestTarget(ctx, ref);
  }

  // Register the /review command
  pi.registerCommand("review", {
    description:
      "Review code changes (PR, uncommitted, branch, commit, or folder)",
    handler: async (args, ctx) => {
      if (!ctx.hasUI) {
        ctx.ui.notify("Review requires interactive mode", "error");
        return;
      }

      // Check if we're in a git repository
      const { code } = await pi.exec("git", ["rev-parse", "--git-dir"]);
      if (code !== 0) {
        ctx.ui.notify("Not a git repository", "error");
        return;
      }

      // Try to parse direct arguments
      let target: ReviewTarget | null = null;
      let fromSelector = false;
      let extraInstruction: string | undefined;
      let reviewers: ReviewerAgent[] | undefined;
      let useAutoReviewers = false;
      const parsed = parseArgs(args);
      if (parsed.error) {
        ctx.ui.notify(parsed.error, "error");
        return;
      }
      extraInstruction = parsed.extraInstruction?.trim() || undefined;
      reviewers = parsed.reviewers;
      useAutoReviewers = parsed.useAutoReviewers ?? false;

      if (parsed.target) {
        if (parsed.target.type === "pr") {
          // Handle PR checkout (async operation)
          target = await handlePrCheckout(ctx, parsed.target.ref);
          if (!target) {
            ctx.ui.notify(
              "PR review failed. Returning to review menu.",
              "warning"
            );
          }
        } else {
          target = parsed.target;
        }
      }

      // If no args or invalid args, show selector
      if (!target) {
        fromSelector = true;
      }

      while (true) {
        if (!target && fromSelector) {
          target = await showReviewSelector(ctx);
        }

        if (!target) {
          ctx.ui.notify("Review cancelled", "info");
          return;
        }

        const reviewerSelection = await resolveReviewers(
          ctx,
          target,
          reviewers,
          useAutoReviewers
        );
        if (!reviewerSelection) {
          ctx.ui.notify("Review cancelled", "info");
          return;
        }
        setReviewSelection(
          pi,
          reviewerSelection.reviewers,
          reviewerSelection.selectionMode
        );

        await executeReview(ctx, target, {
          extraInstruction,
          reviewers: reviewerSelection.reviewers,
        });
        return;
      }
    },
  });

  pi.registerCommand("review-summary", {
    description:
      "Summarize the latest review report in this session: /review-summary [extra instruction]",
    handler: async (args, ctx) => {
      const reviewReport =
        getLatestReviewReport(ctx, { excludeSummary: true }) ||
        getLatestReviewReport(ctx);

      if (!reviewReport) {
        ctx.ui.notify(
          "No review report found in this session. Run /review first.",
          "warning"
        );
        return;
      }

      dispatchFollowUpMessage(
        pi,
        ctx,
        buildReviewSummaryMessage(reviewReport, args),
        "Queued /review-summary as a follow-up"
      );
    },
  });

  pi.registerCommand("review-fix", {
    description:
      "Implement findings from the latest review report in this session: /review-fix [extra instruction]",
    handler: async (args, ctx) => {
      const reviewReport =
        getLatestReviewReport(ctx, { preferSummary: true }) ||
        getLatestReviewReport(ctx);

      if (!reviewReport) {
        ctx.ui.notify(
          "No review report found in this session. Run /review first.",
          "warning"
        );
        return;
      }

      dispatchFollowUpMessage(
        pi,
        ctx,
        buildReviewFixMessage(reviewReport, args),
        "Queued /review-fix as a follow-up"
      );
    },
  });
}
