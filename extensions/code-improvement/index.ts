import type { Stats } from "node:fs";
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { dirname, extname, isAbsolute, join, normalize } from "node:path";

import type {
  ExtensionAPI,
  ExtensionCommandContext,
} from "@earendil-works/pi-coding-agent";

import {
  type GitExec,
  getChangedPaths,
  parsePrReference,
  parseReviewPaths,
  parseReviewTargetArgs,
  type ReviewTarget,
  tokenizeReviewTargetArgs,
} from "../shared/review-targets";

const EXTENSION_DIR = dirname(new URL(import.meta.url).pathname);
const LARGE_SCOPE_FILE_COUNT = 20;
const PR_CHECKOUT_BLOCKED_BY_PENDING_CHANGES_MESSAGE =
  "Cannot checkout PR: you have uncommitted changes. Please commit or stash them first.";
const TEXT_LIKE_EXTENSIONS = new Set([
  ".cjs",
  ".css",
  ".html",
  ".js",
  ".json",
  ".jsonc",
  ".jsx",
  ".md",
  ".mjs",
  ".sh",
  ".ts",
  ".tsx",
  ".txt",
  ".yaml",
  ".yml",
]);
const TEXT_LIKE_FILENAMES = new Set([
  ".env.example",
  ".gitignore",
  "Dockerfile",
  "Makefile",
]);
const LOCKFILE_NAMES = new Set([
  "bun.lock",
  "Cargo.lock",
  "package-lock.json",
  "pnpm-lock.yaml",
  "yarn.lock",
]);
const GENERATED_OR_VENDOR_SEGMENTS = new Set([
  ".git",
  ".next",
  ".turbo",
  "build",
  "coverage",
  "dist",
  "generated",
  "node_modules",
  "vendor",
]);

function readPrompt(fileName: string): string {
  return readFileSync(join(EXTENSION_DIR, fileName), "utf8").trim();
}

function createGitExec(pi: ExtensionAPI): GitExec {
  return (args) =>
    pi.exec("git", args) as Promise<{ stdout: string; code: number }>;
}

const SIMPLIFY_PROMPT = readPrompt("SIMPLIFY.md");
const IMPROVE_CODEBASE_ARCHITECTURE_PROMPT = [
  "IMPROVE-CODEBASE-ARCHITECTURE.md",
  "LANGUAGE.md",
  "DEEPENING.md",
  "INTERFACE-DESIGN.md",
]
  .map(readPrompt)
  .join("\n\n");

interface ParsedSimplifyArgs {
  target: ReviewTarget | { type: "pr"; ref: string } | null;
  extraInstruction?: string;
  yes?: boolean;
  error?: string;
}

function isSafeRelativePath(value: string): boolean {
  const normalized = normalize(value).replaceAll("\\", "/");
  return (
    value.trim().length > 0 &&
    !isAbsolute(value) &&
    normalized !== ".." &&
    !normalized.startsWith("../")
  );
}

function hasGeneratedOrVendorSegment(path: string): boolean {
  return path
    .split("/")
    .some((segment) => GENERATED_OR_VENDOR_SEGMENTS.has(segment));
}

function isBinaryLookingFile(path: string): boolean {
  const bytes = readFileSync(path).subarray(0, 8192);
  return bytes.includes(0);
}

function isTextLikePath(path: string): boolean {
  const fileName = path.split("/").at(-1) ?? "";
  return (
    TEXT_LIKE_FILENAMES.has(fileName) ||
    TEXT_LIKE_EXTENSIONS.has(extname(fileName).toLowerCase())
  );
}

function isSafeAllowlistFile(path: string, allowLockfiles: boolean): boolean {
  const normalizedPath = normalize(path).replaceAll("\\", "/");
  const fileName = normalizedPath.split("/").at(-1) ?? "";
  if (
    !isSafeRelativePath(path) ||
    hasGeneratedOrVendorSegment(normalizedPath)
  ) {
    return false;
  }
  const isLockfile = LOCKFILE_NAMES.has(fileName);
  if (isLockfile && !allowLockfiles) {
    return false;
  }
  if (!(isLockfile || isTextLikePath(normalizedPath))) {
    return false;
  }
  try {
    return (
      existsSync(normalizedPath) &&
      statSync(normalizedPath).isFile() &&
      !isBinaryLookingFile(normalizedPath)
    );
  } catch {
    return false;
  }
}

function expandFolderScopePaths(paths: readonly string[]): string[] {
  const expanded: string[] = [];
  const visit = (path: string) => {
    const trimmedPath = path.trim();
    const normalizedPath = normalize(trimmedPath).replaceAll("\\", "/");
    if (
      !isSafeRelativePath(trimmedPath) ||
      hasGeneratedOrVendorSegment(normalizedPath)
    ) {
      return;
    }

    let stats: Stats;
    try {
      stats = statSync(normalizedPath);
    } catch {
      expanded.push(trimmedPath);
      return;
    }

    if (stats.isFile()) {
      expanded.push(normalizedPath);
      return;
    }
    if (!stats.isDirectory()) {
      return;
    }

    for (const entry of readdirSync(normalizedPath)) {
      visit(join(normalizedPath, entry));
    }
  };

  for (const path of paths) {
    visit(path);
  }

  return expanded;
}

function toSafeAllowlist(
  paths: readonly string[],
  options: { allowLockfiles?: boolean; expandDirectories?: boolean } = {}
): string[] {
  const candidatePaths = options.expandDirectories
    ? expandFolderScopePaths(paths)
    : paths;

  return Array.from(
    new Set(
      candidatePaths
        .map((item) => item.trim())
        .filter((item) =>
          isSafeAllowlistFile(item, options.allowLockfiles ?? false)
        )
    )
  ).sort();
}

function formatAllowlist(paths: readonly string[]): string {
  return paths.map((item) => `- ${item}`).join("\n");
}

function parseSimplifyArgs(args: string | undefined): ParsedSimplifyArgs {
  if (!args?.trim()) {
    return { target: null };
  }

  const tokens = tokenizeReviewTargetArgs(args);
  const positional: string[] = [];
  let skipNext = false;
  for (const token of tokens) {
    if (skipNext) {
      skipNext = false;
      continue;
    }
    if (token === "--yes") {
      continue;
    }
    if (token === "--extra") {
      skipNext = true;
      continue;
    }
    if (token.startsWith("--extra=")) {
      continue;
    }
    positional.push(token);
  }
  const command = positional[0]?.toLowerCase();
  const allowed = new Set(["uncommitted", "branch", "commit", "pr", "folder"]);

  if (!(command && allowed.has(command))) {
    return {
      target: null,
      error:
        "Usage: /simplify [uncommitted|branch <base>|commit <sha>|pr <ref>|folder <paths>] [--extra <guidance>] [--yes]",
    };
  }

  const parsed = parseReviewTargetArgs(args);
  if (parsed.error) {
    return parsed;
  }
  if (!parsed.target) {
    return { target: null, error: `Missing value for ${command}` };
  }

  if (
    (command === "uncommitted" && positional.length !== 1) ||
    (command === "branch" && positional.length !== 2) ||
    (command === "commit" && positional.length !== 2) ||
    (command === "pr" && positional.length !== 2) ||
    (command === "folder" && positional.length < 2)
  ) {
    return { target: null, error: `Invalid /simplify ${command} syntax` };
  }

  return {
    target: parsed.target,
    extraInstruction: parsed.extraInstruction,
    yes: parsed.yes,
  };
}

export function buildSimplifyCommandMessage(args: string): string {
  const focus = args.trim();
  const focusInstruction = focus
    ? `Focus instruction: ${focus}`
    : "Focus instruction: Simplify the recent feature implementation or recently modified code in this session.";

  return `${SIMPLIFY_PROMPT}\n\n${focusInstruction}`;
}

export function buildScopedSimplifyCommandMessage(options: {
  targetLabel: string;
  allowlist: readonly string[];
  extraInstruction?: string;
  staleCheck?: string;
}): string {
  const extra = options.extraInstruction?.trim()
    ? `\n\nExtra guidance: ${options.extraInstruction.trim()}`
    : "";
  const staleCheck = options.staleCheck?.trim()
    ? `\n\nBefore delegating, re-resolve this scope and stop if the file allowlist changed: ${options.staleCheck.trim()}`
    : "";

  return `${SIMPLIFY_PROMPT}\n\nDelegate to code-simplifier. Do not select reviewers.\n\nScope: ${options.targetLabel}\n\nAllowed files preview (${options.allowlist.length}):\n${formatAllowlist(options.allowlist)}\n\nHard edit boundary: you may read files outside the allowlist for context, but only edit files in the allowlist above. Do not edit files outside this allowlist. If needed edits fall outside it, stop and report the missing file path.${extra}${staleCheck}`;
}

export function buildImproveCodebaseArchitectureCommandMessage(
  args: string
): string {
  const scope = args.trim();
  const scopeInstruction = scope
    ? `Scope instruction: ${scope}`
    : "Scope instruction: No explicit scope provided. Start broad, then narrow based on explorer findings.";

  return `${IMPROVE_CODEBASE_ARCHITECTURE_PROMPT}\n\n${scopeInstruction}`;
}

async function hasPendingChanges(pi: ExtensionAPI): Promise<boolean> {
  const { stdout, code } = await pi.exec("git", ["status", "--porcelain"]);
  return (
    code === 0 &&
    stdout.split("\n").some((line) => line.trim() && !line.startsWith("??"))
  );
}

async function checkoutPr(pi: ExtensionAPI, prNumber: number) {
  const { stdout, stderr, code } = await pi.exec("gh", [
    "pr",
    "checkout",
    String(prNumber),
  ]);
  return {
    success: code === 0,
    error: stderr || stdout || "Failed to checkout PR",
  };
}

async function resolvePrTarget(
  pi: ExtensionAPI,
  ctx: ExtensionCommandContext,
  ref: string,
  yes?: boolean
): Promise<ReviewTarget | null> {
  const prNumber = parsePrReference(ref);
  if (!prNumber) {
    ctx.ui.notify(
      "Invalid PR reference. Enter a number or GitHub PR URL.",
      "error"
    );
    return null;
  }
  if (await hasPendingChanges(pi)) {
    ctx.ui.notify(PR_CHECKOUT_BLOCKED_BY_PENDING_CHANGES_MESSAGE, "error");
    return null;
  }
  if (!yes) {
    if (!ctx.hasUI) {
      ctx.ui.notify("PR checkout in no-UI mode requires --yes", "error");
      return null;
    }
    const confirmed = await ctx.ui.confirm(
      "Checkout PR for /simplify?",
      `Checkout PR #${prNumber} before simplifying.`
    );
    if (!confirmed) {
      return null;
    }
  }
  if (await hasPendingChanges(pi)) {
    ctx.ui.notify(PR_CHECKOUT_BLOCKED_BY_PENDING_CHANGES_MESSAGE, "error");
    return null;
  }
  const checkout = await checkoutPr(pi, prNumber);
  if (!checkout.success) {
    ctx.ui.notify(`Failed to checkout PR: ${checkout.error}`, "error");
    return null;
  }
  const { stdout, code } = await pi.exec("gh", [
    "pr",
    "view",
    String(prNumber),
    "--json",
    "baseRefName,title",
  ]);
  if (code !== 0) {
    ctx.ui.notify(`Could not fetch PR #${prNumber}.`, "error");
    return null;
  }
  const data = JSON.parse(stdout) as { baseRefName: string; title: string };
  return {
    type: "pullRequest",
    prNumber,
    baseBranch: data.baseRefName,
    title: data.title,
  };
}

function targetLabel(target: ReviewTarget): string {
  switch (target.type) {
    case "uncommitted":
      return "uncommitted changes";
    case "baseBranch":
      return `branch ${target.branch}`;
    case "commit":
      return `commit ${target.sha}`;
    case "pullRequest":
      return `PR #${target.prNumber}`;
    case "folder":
      return `folder ${target.paths.join(", ")}`;
  }
}

async function getSmartDefault(pi: ExtensionAPI): Promise<string> {
  const { stdout: status, code: statusCode } = await pi.exec("git", [
    "status",
    "--porcelain",
  ]);
  if (statusCode === 0 && status.trim()) {
    return "uncommitted";
  }

  const { stdout: branch, code: branchCode } = await pi.exec("git", [
    "branch",
    "--show-current",
  ]);
  if (
    branchCode === 0 &&
    branch.trim() &&
    !["main", "master"].includes(branch.trim())
  ) {
    return "branch";
  }

  return "commit";
}

async function promptForSimplifyTarget(
  pi: ExtensionAPI,
  ctx: ExtensionCommandContext
): Promise<ReviewTarget | { type: "pr"; ref: string } | null> {
  const smartDefault = await getSmartDefault(pi);
  const choice = await ctx.ui.select("Select simplify scope:", [
    `${smartDefault} (smart default)`,
    "uncommitted",
    "branch",
    "commit",
    "pr",
    "folder",
  ]);
  const normalizedChoice = choice?.replace(" (smart default)", "");

  if (normalizedChoice === "folder") {
    const input = await ctx.ui.editor(
      "Enter folders/files to simplify (space-separated or one per line):",
      "."
    );
    const paths = parseReviewPaths(input ?? "");
    return paths.length ? { type: "folder", paths } : null;
  }
  if (normalizedChoice === "branch") {
    const branch = await ctx.ui.editor("Enter base branch:", "main");
    return branch?.trim()
      ? { type: "baseBranch", branch: branch.trim() }
      : null;
  }
  if (normalizedChoice === "commit") {
    const sha = await ctx.ui.editor("Enter commit SHA:", "HEAD");
    return sha?.trim() ? { type: "commit", sha: sha.trim() } : null;
  }
  if (normalizedChoice === "pr") {
    const ref = await ctx.ui.editor("Enter PR number or URL:", "");
    return ref?.trim() ? { type: "pr", ref: ref.trim() } : null;
  }
  if (normalizedChoice === "uncommitted") {
    return { type: "uncommitted" };
  }
  return null;
}

async function dispatchSimplify(
  pi: ExtensionAPI,
  ctx: ExtensionCommandContext,
  target: ReviewTarget,
  extraInstruction: string | undefined,
  yes: boolean | undefined
) {
  const allowlist = toSafeAllowlist(
    await getChangedPaths(target, createGitExec(pi)),
    {
      allowLockfiles: target.type === "folder",
      expandDirectories: target.type === "folder",
    }
  );
  if (allowlist.length === 0) {
    ctx.ui.notify("No files resolved for /simplify scope", "warning");
    return;
  }
  if (allowlist.length > LARGE_SCOPE_FILE_COUNT && !yes) {
    if (!ctx.hasUI) {
      ctx.ui.notify("Large no-UI /simplify scopes require --yes", "error");
      return;
    }
    const confirmed = await ctx.ui.confirm(
      "Large simplify scope",
      `Allow code-simplifier to edit ${allowlist.length} files?`
    );
    if (!confirmed) {
      return;
    }
  }
  const message = buildScopedSimplifyCommandMessage({
    targetLabel: targetLabel(target),
    allowlist,
    extraInstruction,
    staleCheck: targetLabel(target),
  });
  if (ctx.isIdle()) {
    pi.sendUserMessage(message);
    return;
  }
  pi.sendUserMessage(message, { deliverAs: "followUp" });
  ctx.ui.notify("Queued /simplify as a follow-up", "info");
}

export default function codeImprovementExtension(pi: ExtensionAPI): void {
  pi.registerCommand("simplify", {
    description:
      "Simplify recent code or scoped files: /simplify [uncommitted|branch <base>|commit <sha>|pr <ref>|folder <paths>] [--extra <guidance>] [--yes]",
    handler: async (args, ctx) => {
      const parsed = parseSimplifyArgs(args);
      if (parsed.error) {
        ctx.ui.notify(parsed.error, "error");
        return;
      }

      if (!parsed.target) {
        if (ctx.hasUI) {
          const selected = await promptForSimplifyTarget(pi, ctx);
          if (selected) {
            const target =
              selected.type === "pr"
                ? await resolvePrTarget(pi, ctx, selected.ref, parsed.yes)
                : selected;
            if (target) {
              await dispatchSimplify(
                pi,
                ctx,
                target,
                parsed.extraInstruction,
                parsed.yes
              );
            }
          }
          return;
        }
        const message = buildSimplifyCommandMessage(args ?? "");
        if (ctx.isIdle()) {
          pi.sendUserMessage(message);
          return;
        }
        pi.sendUserMessage(message, { deliverAs: "followUp" });
        ctx.ui.notify("Queued /simplify as a follow-up", "info");
        return;
      }

      const target =
        parsed.target.type === "pr"
          ? await resolvePrTarget(pi, ctx, parsed.target.ref, parsed.yes)
          : parsed.target;
      if (target) {
        await dispatchSimplify(
          pi,
          ctx,
          target,
          parsed.extraInstruction,
          parsed.yes
        );
      }
    },
  });

  pi.registerCommand("improve-codebase-architecture", {
    description:
      "Read-only architecture review with deepening candidates: /improve-codebase-architecture [scope]",
    handler: (args, ctx) => {
      const message = buildImproveCodebaseArchitectureCommandMessage(
        args ?? ""
      );

      if (ctx.isIdle()) {
        pi.sendUserMessage(message);
        return;
      }

      pi.sendUserMessage(message, { deliverAs: "followUp" });
      ctx.ui.notify(
        "Queued /improve-codebase-architecture as a follow-up",
        "info"
      );
    },
  });
}
