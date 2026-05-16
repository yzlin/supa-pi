const GITHUB_PULL_REQUEST_URL_PATTERN =
  /github\.com\/[^/]+\/[^/]+\/pull\/(\d+)/;
const WHITESPACE_PATTERN = /\s+/;
const WHITESPACE_CHARACTER_PATTERN = /\s/;

export type ReviewTarget =
  | { type: "uncommitted" }
  | { type: "baseBranch"; branch: string }
  | { type: "commit"; sha: string; title?: string }
  | { type: "pullRequest"; prNumber: number; baseBranch: string; title: string }
  | { type: "folder"; paths: string[] };

export interface ParsedReviewTargetArgs {
  target: ReviewTarget | { type: "pr"; ref: string } | null;
  extraInstruction?: string;
  reviewers?: string[];
  useAutoReviewers?: boolean;
  yes?: boolean;
  error?: string;
}

export interface GitExecResult {
  stdout: string;
  code: number;
}

export type GitExec = (args: string[]) => Promise<GitExecResult>;

export function tokenizeReviewTargetArgs(value: string): string[] {
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

    if (WHITESPACE_CHARACTER_PATTERN.test(char)) {
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

export function parseReviewPaths(value: string): string[] {
  return value
    .split(WHITESPACE_PATTERN)
    .map((item) => item.trim())
    .filter((item) => item.length > 0);
}

export function parseReviewTargetArgs(
  args: string | undefined,
  options: { parseReviewers?: (value: string) => string[] } = {}
): ParsedReviewTargetArgs {
  if (!args?.trim()) {
    return { target: null };
  }

  const rawParts = tokenizeReviewTargetArgs(args.trim());
  const parts: string[] = [];
  let extraInstruction: string | undefined;
  let reviewers: string[] | undefined;
  let useAutoReviewers = false;
  let yes = false;

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
      const parsedReviewers = options.parseReviewers?.(next) ?? [];
      if (!parsedReviewers.length) {
        return { target: null, error: "No valid reviewers in --reviewers" };
      }
      reviewers = parsedReviewers;
      i += 1;
      continue;
    }

    if (part.startsWith("--reviewers=")) {
      const parsedReviewers =
        options.parseReviewers?.(part.slice("--reviewers=".length)) ?? [];
      if (!parsedReviewers.length) {
        return { target: null, error: "No valid reviewers in --reviewers" };
      }
      reviewers = parsedReviewers;
      continue;
    }

    if (part === "--auto-reviewers") {
      useAutoReviewers = true;
      continue;
    }

    if (part === "--yes") {
      yes = true;
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

  const base = { extraInstruction, reviewers, useAutoReviewers, yes };
  if (parts.length === 0) {
    return { target: null, ...base };
  }

  const subcommand = parts[0]?.toLowerCase();
  switch (subcommand) {
    case "uncommitted":
      return { target: { type: "uncommitted" }, ...base };
    case "branch": {
      const branch = parts[1];
      return {
        target: branch ? { type: "baseBranch", branch } : null,
        ...base,
      };
    }
    case "commit": {
      const sha = parts[1];
      if (!sha) {
        return { target: null, ...base };
      }
      const title = parts.slice(2).join(" ") || undefined;
      return { target: { type: "commit", sha, title }, ...base };
    }
    case "folder": {
      const paths = parts.slice(1).filter((item) => item.trim().length > 0);
      return {
        target: paths.length ? { type: "folder", paths } : null,
        ...base,
      };
    }
    case "pr": {
      const ref = parts[1];
      return { target: ref ? { type: "pr", ref } : null, ...base };
    }
    default:
      return { target: null, ...base };
  }
}

export function normalizeStatusPaths(lines: string[]): string[] {
  return lines
    .map((line) => {
      if (!line.trim()) {
        return "";
      }
      if (line.startsWith("?? ")) {
        return line.slice(3).trim();
      }

      const trimmed = line.trim();
      const pathPortion = line.length > 3 ? line.slice(3).trim() : trimmed;
      const renameParts = pathPortion.split(" -> ");
      return renameParts.at(-1)?.trim() || pathPortion;
    })
    .filter(Boolean);
}

export async function getMergeBase(
  gitExec: GitExec,
  branch: string
): Promise<string | null> {
  try {
    const { stdout: upstream, code: upstreamCode } = await gitExec([
      "rev-parse",
      "--abbrev-ref",
      `${branch}@{upstream}`,
    ]);

    if (upstreamCode === 0 && upstream.trim()) {
      const { stdout: mergeBase, code } = await gitExec([
        "merge-base",
        "HEAD",
        upstream.trim(),
      ]);
      if (code === 0 && mergeBase.trim()) {
        return mergeBase.trim();
      }
    }

    const { stdout: mergeBase, code } = await gitExec([
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

export async function getChangedPaths(
  target: ReviewTarget,
  gitExec: GitExec
): Promise<string[]> {
  const run = async (
    args: string[],
    options: { preserveLines?: boolean } = {}
  ) => {
    const { stdout, code } = await gitExec(args);
    if (code !== 0) {
      return [];
    }
    const output = options.preserveLines ? stdout : stdout.trim();
    return output
      .split("\n")
      .map((line) => (options.preserveLines ? line : line.trim()))
      .filter((line) => line.trim());
  };

  switch (target.type) {
    case "uncommitted":
      return normalizeStatusPaths(
        await run(["status", "--porcelain", "--untracked-files=all"], {
          preserveLines: true,
        })
      );
    case "baseBranch": {
      const mergeBase = await getMergeBase(gitExec, target.branch);
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
      const mergeBase = await getMergeBase(gitExec, target.baseBranch);
      return mergeBase ? run(["diff", "--name-only", mergeBase]) : [];
    }
    case "folder":
      return target.paths;
  }
}

export function parsePrReference(ref: string): number | null {
  const trimmed = ref.trim();
  const num = Number.parseInt(trimmed, 10);
  if (!Number.isNaN(num) && num > 0) {
    return num;
  }

  const urlMatch = trimmed.match(GITHUB_PULL_REQUEST_URL_PATTERN);
  if (urlMatch) {
    return Number.parseInt(urlMatch[1], 10);
  }

  return null;
}
