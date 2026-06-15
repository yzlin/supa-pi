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
  "build",
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

function addExplicitInput(
  expanded: string[],
  path: string,
  isExplicitInput: boolean
): void {
  if (isExplicitInput) {
    expanded.push(path);
  }
}

function expandFolderScopePaths(paths: readonly string[]): string[] {
  const expanded: string[] = [];

  function visit(path: string, isExplicitInput = false): void {
    const trimmedPath = path.trim();
    const normalizedPath = normalizeScopePath(trimmedPath);
    if (
      !isSafeRelativePath(trimmedPath) ||
      hasGeneratedOrVendorSegment(normalizedPath)
    ) {
      addExplicitInput(expanded, trimmedPath, isExplicitInput);
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

    for (const entry of readdirSync(normalizedPath)) {
      visit(join(normalizedPath, entry));
    }
  }

  for (const path of paths) {
    visit(path, true);
  }

  return expanded;
}

export function classifySimplifyScopePaths(
  paths: readonly string[],
  options: SimplifyScopeClassificationOptions = {}
): SimplifyScopeClassification {
  const lockfileNames = options.lockfileNames ?? LOCKFILE_NAMES;
  const candidatePaths = options.expandDirectories
    ? expandFolderScopePaths(paths)
    : paths;
  const editableFiles = new Set<string>();
  const ignoredLockfiles = new Set<string>();
  const unsupportedChangedFiles = new Set<string>();

  for (const candidatePath of candidatePaths) {
    const trimmedPath = candidatePath.trim();
    const normalizedPath = normalizeScopePath(trimmedPath);
    const fileName = normalizedPath.split("/").at(-1) ?? "";
    const isSafePath =
      isSafeRelativePath(trimmedPath) &&
      !hasGeneratedOrVendorSegment(normalizedPath);

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
  };
}
