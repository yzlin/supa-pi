import { spawnSync } from "node:child_process";
import type { Stats } from "node:fs";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { extname, isAbsolute, join, normalize } from "node:path";

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
export const LOCKFILE_NAMES = new Set([
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
  "coverage",
  "dist",
  "generated",
  "node_modules",
  "vendor",
]);

export interface SimplifyScopeClassification {
  editableFiles: string[];
  ignoredLockfiles: string[];
  unsupportedChangedFiles: string[];
  gitIgnoreUnavailable?: boolean;
}

export interface SimplifyScopeClassificationOptions {
  expandDirectories?: boolean;
  lockfileNames?: ReadonlySet<string>;
}

function normalizeScopePath(path: string): string {
  return normalize(path).replaceAll("\\", "/");
}

function isSafeRelativePath(value: string): boolean {
  const normalized = normalizeScopePath(value);
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

function readStats(path: string): Stats | undefined {
  try {
    return statSync(path);
  } catch {
    return;
  }
}

function isExistingNonBinaryFile(path: string): boolean {
  const stats = readStats(path);
  if (!stats?.isFile()) {
    return false;
  }

  try {
    return !isBinaryLookingFile(path);
  } catch {
    return false;
  }
}

interface GitIgnoreCheckState {
  unavailable: boolean;
}

function gitIgnoreCheckablePaths(paths: readonly string[]): string[] {
  return paths
    .map((path) => normalizeScopePath(path.trim()))
    .filter(
      (path) => isSafeRelativePath(path) && !hasGeneratedOrVendorSegment(path)
    );
}

function checkGitIgnored(
  paths: readonly string[],
  state: GitIgnoreCheckState
): Set<string> {
  if (state.unavailable || paths.length === 0) {
    return new Set();
  }

  const result = spawnSync("git", ["check-ignore", "--stdin", "-z"], {
    encoding: "utf8",
    input: `${paths.join("\0")}\0`,
  });
  if (result.status === 0 || result.status === 1) {
    return new Set(
      result.stdout.split("\0").filter((path) => path.length > 0)
    );
  }

  state.unavailable = true;
  return new Set();
}

function addExplicitInput(
  expanded: string[],
  path: string,
  isExplicitInput: boolean
): void {
  if (isExplicitInput) {
    expanded.push(path);
  }
}

function expandFolderScopePaths(paths: readonly string[]): {
  paths: string[];
  gitIgnoreUnavailable: boolean;
} {
  const expanded: string[] = [];
  const ignoreState: GitIgnoreCheckState = { unavailable: false };

  function visit(
    path: string,
    isExplicitInput = false,
    isIgnored = false
  ): void {
    const trimmedPath = path.trim();
    const normalizedPath = normalizeScopePath(trimmedPath);
    if (
      !isSafeRelativePath(trimmedPath) ||
      hasGeneratedOrVendorSegment(normalizedPath)
    ) {
      addExplicitInput(expanded, trimmedPath, isExplicitInput);
      return;
    }

    if (isIgnored) {
      addExplicitInput(expanded, normalizedPath, isExplicitInput);
      return;
    }

    const stats = readStats(normalizedPath);
    if (!stats) {
      expanded.push(trimmedPath);
      return;
    }

    if (stats.isFile()) {
      expanded.push(normalizedPath);
      return;
    }
    if (!stats.isDirectory()) {
      addExplicitInput(expanded, normalizedPath, isExplicitInput);
      return;
    }

    const entries = readdirSync(normalizedPath).map((entry) =>
      normalizeScopePath(join(normalizedPath, entry))
    );
    const ignoredEntries = checkGitIgnored(
      gitIgnoreCheckablePaths(entries),
      ignoreState
    );

    for (const entry of entries) {
      visit(entry, false, ignoredEntries.has(entry));
    }
  }

  const ignoredPaths = checkGitIgnored(
    gitIgnoreCheckablePaths(paths),
    ignoreState
  );

  for (const path of paths) {
    const normalizedPath = normalizeScopePath(path.trim());
    visit(path, true, ignoredPaths.has(normalizedPath));
  }

  return { paths: expanded, gitIgnoreUnavailable: ignoreState.unavailable };
}

export function classifySimplifyScopePaths(
  paths: readonly string[],
  options: SimplifyScopeClassificationOptions = {}
): SimplifyScopeClassification {
  const lockfileNames = options.lockfileNames ?? LOCKFILE_NAMES;
  const shouldCheckGitIgnore = options.expandDirectories === true;
  const expandedScope = shouldCheckGitIgnore
    ? expandFolderScopePaths(paths)
    : { paths, gitIgnoreUnavailable: false };
  const ignoreState: GitIgnoreCheckState = {
    unavailable: expandedScope.gitIgnoreUnavailable,
  };
  const candidatePaths = expandedScope.paths;
  const editableFiles = new Set<string>();
  const ignoredLockfiles = new Set<string>();
  const unsupportedChangedFiles = new Set<string>();
  const checkableCandidatePaths = shouldCheckGitIgnore
    ? gitIgnoreCheckablePaths(candidatePaths)
    : [];
  const ignoredCandidates = checkGitIgnored(
    checkableCandidatePaths,
    ignoreState
  );

  for (const candidatePath of candidatePaths) {
    const trimmedPath = candidatePath.trim();
    const normalizedPath = normalizeScopePath(trimmedPath);
    const fileName = normalizedPath.split("/").at(-1) ?? "";
    const isSafePath =
      isSafeRelativePath(trimmedPath) &&
      !hasGeneratedOrVendorSegment(normalizedPath);

    if (isSafePath && ignoredCandidates.has(normalizedPath)) {
      unsupportedChangedFiles.add(normalizedPath);
      continue;
    }

    if (!(isSafePath && isExistingNonBinaryFile(normalizedPath))) {
      unsupportedChangedFiles.add(trimmedPath);
      continue;
    }

    if (lockfileNames.has(fileName)) {
      ignoredLockfiles.add(normalizedPath);
      continue;
    }

    if (!isTextLikePath(normalizedPath)) {
      unsupportedChangedFiles.add(normalizedPath);
      continue;
    }

    editableFiles.add(normalizedPath);
  }

  return {
    editableFiles: Array.from(editableFiles).sort(),
    ignoredLockfiles: Array.from(ignoredLockfiles).sort(),
    unsupportedChangedFiles: Array.from(unsupportedChangedFiles).sort(),
    gitIgnoreUnavailable: ignoreState.unavailable,
  };
}
