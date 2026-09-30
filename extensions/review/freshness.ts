import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { constants, promises as fs, type Stats } from "node:fs";
import path from "node:path";

import type { ReviewTarget } from "../shared/review-targets";

const DEFAULT_MAX_FILES = 10_000;
const DEFAULT_MAX_BYTES = 50 * 1024 * 1024;
const MAX_GIT_OUTPUT_BYTES = 4 * 1024 * 1024;
const MAX_TARGET_PATHS = 256;
const MAX_PATH_BYTES = 4096;
const MAX_TARGET_TEXT_BYTES = 16 * 1024;
const MAX_DIRECTORY_ENTRIES = 100_000;
const MAX_DIRECTORY_DEPTH = 256;
const FILE_READ_CHUNK_BYTES = 64 * 1024;
// Git's administrative directory is not reviewer-visible source and mutates as
// review commands run. All other selected/status-listed paths are review input.
const EXCLUDED_SEGMENTS = new Set([".git"]);
const RENAME_STATUS_PATTERN = /^[RC]/u;
const SHA_PATTERN = /^[0-9a-f]{40,128}$/iu;
const TEXT_ENCODER = new TextEncoder();

type FileStats = Stats;

export type ReviewFreshnessErrorReason =
  | "byte-limit"
  | "cancelled"
  | "depth-limit"
  | "file-limit"
  | "git-error"
  | "git-output-limit"
  | "invalid-limit"
  | "invalid-target"
  | "read-error"
  | "root-error"
  | "special-file"
  | "target-limit"
  | "unsafe-path"
  | "unstable-file";

export class ReviewFreshnessError extends Error {
  readonly reason: ReviewFreshnessErrorReason;

  constructor(reason: ReviewFreshnessErrorReason, detail: string) {
    super(`Review freshness ${reason}: ${detail}`);
    this.name = "ReviewFreshnessError";
    this.reason = reason;
  }
}

export interface ReviewFreshnessOptions {
  readonly maxBytes?: number;
  readonly maxFiles?: number;
  readonly signal?: AbortSignal;
}

export interface ReviewTargetFreshness {
  readonly byteCount: number;
  readonly digest: string;
  readonly fileCount: number;
}

interface CaptureLimits {
  readonly maxBytes: number;
  readonly maxFiles: number;
}

interface ChangedPath {
  readonly path: string;
  readonly status: string;
}

interface FileFingerprint {
  readonly digest?: string;
  readonly kind: "file" | "missing";
  readonly mode?: number;
  readonly path: string;
  readonly size?: number;
}

interface CaptureState {
  readonly entries: FileFingerprint[];
  readonly limits: CaptureLimits;
  readonly root: string;
  readonly seen: Set<string>;
  byteCount: number;
  fileCount: number;
}

/**
 * Capture a bounded, deterministic fingerprint of the bytes and membership a
 * review target exposes. Uncommitted targets include the resolved HEAD
 * commit/tree identity, or a validated symbolic-head marker for unborn repos.
 * They use Git's standard ignore rules for untracked files; explicit folder
 * targets include ignored files. Git administrative `.git` path segments are
 * excluded because they are not reviewer-visible source and mutate as review
 * commands run; reviewed configuration and source paths remain included.
 * Branch and PR paths use the merge-base-to-worktree diff (not untracked files).
 * Symlinks fail with `unsafe-path`; other non-regular files fail with
 * `special-file` before opening.
 * Call this again at finalization rather than reusing a preflight path list.
 */
export async function captureReviewTargetFreshness(
  cwd: string,
  target: ReviewTarget,
  options: ReviewFreshnessOptions = {},
): Promise<ReviewTargetFreshness> {
  const limits = normalizeLimits(options);
  throwIfCancelled(options.signal);
  const cwdRoot = await resolveRoot(cwd, options.signal);
  const root =
    target.type === "folder"
      ? cwdRoot
      : await resolveGitRoot(cwdRoot, options.signal);
  const state: CaptureState = {
    byteCount: 0,
    entries: [],
    fileCount: 0,
    limits,
    root,
    seen: new Set(),
  };

  let descriptor: string;
  let identity: string[] = [];
  let paths: string[];

  switch (target.type) {
    case "uncommitted": {
      descriptor = describeTarget(target);
      const changed = normalizeChangedPaths(
        root,
        parsePorcelainPaths(
          await runGit(
            root,
            [
              "status",
              "--porcelain=v1",
              "--untracked-files=all",
              "--no-renames",
              "--ignored=no",
              "-z",
            ],
            options.signal,
          ),
        ),
        options.signal,
      );
      ensurePathLimit(changed.length, limits);
      paths = uniquePaths(changed);
      const index = paths.length
        ? await runGit(
            root,
            ["ls-files", "--stage", "-z", "--", ...paths],
            options.signal,
          )
        : "";
      identity = [
        ...(await resolveHeadIdentity(root, options.signal)),
        ...changed
          .sort(compareChangedPaths)
          .map(({ path: changedPath, status }) =>
            JSON.stringify({ path: changedPath, status }),
          ),
        `index:${index}`,
      ];
      break;
    }
    case "baseBranch": {
      validateRevisionInput(target.branch, "branch");
      descriptor = describeTarget(target);
      const range = await captureRange(root, target.branch, options.signal);
      ensurePathLimit(range.changed.length, limits);
      paths = uniquePaths(range.changed);
      identity = range.identity;
      break;
    }
    case "pullRequest": {
      validateRevisionInput(target.baseBranch, "base branch");
      validatePositiveInteger(target.prNumber, "pull request number");
      validateTargetText(target.title, "pull request title");
      descriptor = describeTarget(target);
      const range = await captureRange(root, target.baseBranch, options.signal);
      ensurePathLimit(range.changed.length, limits);
      paths = uniquePaths(range.changed);
      identity = range.identity;
      break;
    }
    case "commit": {
      validateRevisionInput(target.sha, "commit");
      if (target.title !== undefined) {
        validateTargetText(target.title, "commit title");
      }
      descriptor = describeTarget(target);
      const commit = await resolveRevision(root, target.sha, options.signal);
      const changed = normalizeChangedPaths(
        root,
        parseNameStatusPaths(
          await runGit(
            root,
            [
              "diff-tree",
              "--root",
              "--no-commit-id",
              "--format=",
              "--name-status",
              "-r",
              "--no-renames",
              "--no-ext-diff",
              "--no-textconv",
              "--relative",
              "-z",
              commit,
              "--",
            ],
            options.signal,
          ),
        ),
        options.signal,
      );
      ensurePathLimit(changed.length, limits);
      paths = uniquePaths(changed);
      identity = [
        `commit:${commit}`,
        ...changed
          .sort(compareChangedPaths)
          .map(({ path: changedPath, status }) =>
            JSON.stringify({ path: changedPath, status }),
          ),
      ];
      break;
    }
    case "folder": {
      const selected = normalizeFolderPaths(root, target.paths);
      descriptor = describeTarget({ type: "folder", paths: selected });
      paths = selected;
      break;
    }
    default:
      throw new ReviewFreshnessError(
        "invalid-target",
        "target has an unsupported type",
      );
  }

  throwIfCancelled(options.signal);
  await capturePaths(state, paths, options.signal);
  throwIfCancelled(options.signal);
  return {
    byteCount: state.byteCount,
    digest: hashCapture(descriptor, identity, state.entries),
    fileCount: state.fileCount,
  };
}

async function captureRange(
  cwd: string,
  baseRef: string,
  signal?: AbortSignal,
): Promise<{ changed: ChangedPath[]; identity: string[] }> {
  const base = await resolveRevision(cwd, baseRef, signal);
  const head = await resolveRevision(cwd, "HEAD", signal);
  const mergeBase = await resolveMergeBase(cwd, base, signal);
  const changed = normalizeChangedPaths(
    cwd,
    parseNameStatusPaths(await runDiffPaths(cwd, mergeBase, signal)),
    signal,
  );
  return {
    changed,
    identity: [
      `base:${base}`,
      `merge-base:${mergeBase}`,
      `head:${head}`,
      ...changed
        .slice()
        .sort(compareChangedPaths)
        .map(({ path: changedPath, status }) =>
          JSON.stringify({ path: changedPath, status }),
        ),
    ],
  };
}

function normalizeLimits(options: ReviewFreshnessOptions): CaptureLimits {
  return {
    maxBytes: normalizeLimit(options.maxBytes, DEFAULT_MAX_BYTES, "maxBytes"),
    maxFiles: normalizeLimit(options.maxFiles, DEFAULT_MAX_FILES, "maxFiles"),
  };
}

function normalizeLimit(
  value: number | undefined,
  fallback: number,
  name: string,
): number {
  if (value !== undefined && (!Number.isSafeInteger(value) || value < 0)) {
    throw new ReviewFreshnessError(
      "invalid-limit",
      `${name} must be a finite non-negative safe integer`,
    );
  }
  return value ?? fallback;
}

async function resolveRoot(cwd: string, signal?: AbortSignal): Promise<string> {
  if (typeof cwd !== "string" || !cwd || cwd.includes("\0")) {
    throw new ReviewFreshnessError("root-error", "cwd is not a valid path");
  }
  throwIfCancelled(signal);
  try {
    const root = await fs.realpath(path.resolve(cwd));
    if (!(await fs.lstat(root)).isDirectory()) {
      throw new ReviewFreshnessError("root-error", "cwd is not a directory");
    }
    throwIfCancelled(signal);
    return root;
  } catch (error) {
    if (error instanceof ReviewFreshnessError) {
      throw error;
    }
    throw new ReviewFreshnessError("root-error", "cwd could not be opened");
  }
}

async function resolveGitRoot(
  cwd: string,
  signal?: AbortSignal,
): Promise<string> {
  const reported = (
    await runGit(cwd, ["rev-parse", "--show-toplevel"], signal)
  ).trim();
  if (
    !reported ||
    hasControlCharacter(reported) ||
    !path.isAbsolute(reported)
  ) {
    throw new ReviewFreshnessError(
      "git-error",
      "Git returned an invalid repository root",
    );
  }
  throwIfCancelled(signal);
  try {
    const root = await fs.realpath(reported);
    if (!(await fs.lstat(root)).isDirectory()) {
      throw new ReviewFreshnessError(
        "git-error",
        "Git repository root is not a directory",
      );
    }
    throwIfCancelled(signal);
    return root;
  } catch (error) {
    if (error instanceof ReviewFreshnessError) {
      throw error;
    }
    throw new ReviewFreshnessError(
      "git-error",
      "Git repository root could not be opened",
    );
  }
}

function describeTarget(target: ReviewTarget): string {
  switch (target.type) {
    case "uncommitted":
      return JSON.stringify({ type: target.type });
    case "baseBranch":
      return JSON.stringify({ branch: target.branch, type: target.type });
    case "commit":
      return JSON.stringify({
        sha: target.sha,
        title: target.title,
        type: target.type,
      });
    case "pullRequest":
      return JSON.stringify({
        baseBranch: target.baseBranch,
        prNumber: target.prNumber,
        title: target.title,
        type: target.type,
      });
    case "folder":
      return JSON.stringify({ paths: target.paths, type: target.type });
    default:
      throw new ReviewFreshnessError(
        "invalid-target",
        "target has an unsupported type",
      );
  }
}

function validateRevisionInput(value: string, label: string): void {
  validateTargetText(value, label);
  if (value.length === 0 || hasControlCharacter(value)) {
    throw new ReviewFreshnessError(
      "invalid-target",
      `${label} is not a valid Git revision input`,
    );
  }
}

function validateTargetText(value: string, label: string): void {
  if (
    typeof value !== "string" ||
    TEXT_ENCODER.encode(value).byteLength > MAX_TARGET_TEXT_BYTES
  ) {
    throw new ReviewFreshnessError(
      "target-limit",
      `${label} exceeds the bounded target input size`,
    );
  }
}

function validatePositiveInteger(value: number, label: string): void {
  if (!Number.isSafeInteger(value) || value <= 0) {
    throw new ReviewFreshnessError(
      "invalid-target",
      `${label} must be a positive safe integer`,
    );
  }
}

function normalizeFolderPaths(root: string, values: string[]): string[] {
  if (!Array.isArray(values) || values.length === 0) {
    throw new ReviewFreshnessError(
      "invalid-target",
      "folder target must contain at least one path",
    );
  }
  if (values.length > MAX_TARGET_PATHS) {
    throw new ReviewFreshnessError(
      "target-limit",
      `folder target exceeds ${MAX_TARGET_PATHS} paths`,
    );
  }
  const normalized = new Set<string>();
  for (const value of values) {
    if (
      typeof value !== "string" ||
      TEXT_ENCODER.encode(value).byteLength > MAX_PATH_BYTES
    ) {
      throw new ReviewFreshnessError(
        "target-limit",
        "folder path exceeds the bounded path input size",
      );
    }
    normalized.add(normalizeRelativePath(root, value));
  }
  return [...normalized].sort(compareStrings);
}

function normalizeRelativePath(root: string, value: string): string {
  if (!value || value.includes("\0") || path.isAbsolute(value)) {
    throw new ReviewFreshnessError(
      "unsafe-path",
      "target path is absolute or otherwise unsafe",
    );
  }
  const resolved = path.resolve(root, value);
  if (!isContained(root, resolved)) {
    throw new ReviewFreshnessError(
      "unsafe-path",
      "target path escapes the capture root",
    );
  }
  const relative = path.relative(root, resolved);
  return relative ? relative.split(path.sep).join("/") : ".";
}

function normalizeChangedPaths(
  root: string,
  rawPaths: readonly ChangedPath[],
  signal: AbortSignal | undefined,
): ChangedPath[] {
  const normalized: ChangedPath[] = [];
  for (const rawPath of rawPaths) {
    throwIfCancelled(signal);
    const relativePath = normalizeRelativePath(root, rawPath.path);
    if (!isExcludedPath(relativePath)) {
      normalized.push({ path: relativePath, status: rawPath.status });
    }
  }
  return normalized;
}

function isContained(root: string, candidate: string): boolean {
  const relative = path.relative(root, candidate);
  return (
    relative === "" ||
    (!relative.startsWith(`..${path.sep}`) &&
      relative !== ".." &&
      !path.isAbsolute(relative))
  );
}

function isExcludedPath(relativePath: string): boolean {
  return (
    relativePath !== "." &&
    relativePath.split("/").some((segment) => EXCLUDED_SEGMENTS.has(segment))
  );
}

async function resolveRevision(
  cwd: string,
  revision: string,
  signal?: AbortSignal,
): Promise<string> {
  validateRevisionInput(revision, "revision");
  return parseGitIdentity(
    await runGit(
      cwd,
      [
        "rev-parse",
        "--verify",
        "--quiet",
        "--end-of-options",
        `${revision}^{commit}`,
      ],
      signal,
    ),
    "commit",
  );
}

async function resolveHeadIdentity(
  cwd: string,
  signal?: AbortSignal,
): Promise<string[]> {
  const commitResult = await runGitResult(
    cwd,
    ["rev-parse", "--verify", "--quiet", "--end-of-options", "HEAD^{commit}"],
    signal,
  );
  if (commitResult.exitCode === 0) {
    const commit = parseGitIdentity(commitResult.stdout, "commit");
    const tree = parseGitIdentity(
      await runGit(
        cwd,
        ["rev-parse", "--verify", "--quiet", "--end-of-options", "HEAD^{tree}"],
        signal,
      ),
      "tree",
    );
    return [`head:${commit}`, `head-tree:${tree}`];
  }

  // `rev-parse --verify --quiet` reports an absent HEAD with exit code 1.
  // Confirm the symbolic ref before accepting that expected unborn state; all
  // other Git failures remain fatal.
  if (commitResult.exitCode !== 1 || commitResult.stdout.trim()) {
    throwGitFailure();
  }

  const symbolicHead = await runGitResult(
    cwd,
    ["symbolic-ref", "--quiet", "HEAD"],
    signal,
  );
  if (symbolicHead.exitCode !== 0) {
    throwGitFailure();
  }
  const ref = symbolicHead.stdout.trim();
  if (!ref || hasControlCharacter(ref) || !ref.startsWith("refs/")) {
    throw new ReviewFreshnessError(
      "git-error",
      "Git returned an invalid unborn HEAD identity",
    );
  }
  const refResult = await runGitResult(
    cwd,
    ["show-ref", "--verify", "--quiet", "--", ref],
    signal,
  );
  if (refResult.exitCode !== 1 || refResult.stdout.trim()) {
    throwGitFailure();
  }
  return [`head:unborn:${ref}`, "head-tree:unborn"];
}

function parseGitIdentity(output: string, kind: "commit" | "tree"): string {
  const identity = output.trim();
  if (!SHA_PATTERN.test(identity)) {
    throw new ReviewFreshnessError(
      "git-error",
      `Git returned an invalid ${kind} identity`,
    );
  }
  return identity.toLowerCase();
}

async function resolveMergeBase(
  cwd: string,
  base: string,
  signal?: AbortSignal,
): Promise<string> {
  const mergeBase = (
    await runGit(cwd, ["merge-base", "HEAD", base], signal)
  ).trim();
  if (!SHA_PATTERN.test(mergeBase)) {
    throw new ReviewFreshnessError(
      "git-error",
      "Git did not return a valid merge base",
    );
  }
  return mergeBase.toLowerCase();
}

function runDiffPaths(
  cwd: string,
  from: string,
  signal?: AbortSignal,
): Promise<string> {
  return runGit(
    cwd,
    [
      "diff",
      "--no-ext-diff",
      "--no-textconv",
      "--no-renames",
      "--name-status",
      "--no-color",
      "-z",
      from,
      "--",
    ],
    signal,
  );
}

function parsePorcelainPaths(output: string): ChangedPath[] {
  return splitNullSeparated(output).map((field) => {
    if (field.length < 4 || field[2] !== " ") {
      throw new ReviewFreshnessError(
        "git-error",
        "Git returned malformed status output",
      );
    }
    return { path: field.slice(3), status: field.slice(0, 2) };
  });
}

function parseNameStatusPaths(output: string): ChangedPath[] {
  const fields = splitNullSeparated(output);
  const paths: ChangedPath[] = [];
  for (let index = 0; index < fields.length; index += 1) {
    const field = fields[index];
    if (!field) {
      throw new ReviewFreshnessError(
        "git-error",
        "Git returned malformed changed-path output",
      );
    }
    const tab = field.indexOf("\t");
    const status = tab < 0 ? field : field.slice(0, tab);
    const changedPath = tab < 0 ? fields[index + 1] : field.slice(tab + 1);
    if (tab < 0) {
      index += 1;
    }
    if (!status || changedPath === undefined || !changedPath) {
      throw new ReviewFreshnessError(
        "git-error",
        "Git returned malformed changed-path output",
      );
    }
    if (RENAME_STATUS_PATTERN.test(status)) {
      throw new ReviewFreshnessError(
        "git-error",
        "Git returned a rename despite rename detection being disabled",
      );
    }
    paths.push({ path: changedPath, status });
  }
  return paths;
}

function splitNullSeparated(output: string): string[] {
  if (!output) {
    return [];
  }
  const fields = output.split("\0");
  if (fields.at(-1) === "") {
    fields.pop();
  }
  return fields;
}

function ensurePathLimit(pathCount: number, limits: CaptureLimits): void {
  if (pathCount > limits.maxFiles) {
    throw new ReviewFreshnessError(
      "file-limit",
      `target contains more than ${limits.maxFiles} changed paths`,
    );
  }
}

function uniquePaths(changedPaths: readonly ChangedPath[]): string[] {
  return [
    ...new Set(changedPaths.map(({ path: changedPath }) => changedPath)),
  ].sort(compareStrings);
}

async function capturePaths(
  state: CaptureState,
  paths: readonly string[],
  signal?: AbortSignal,
): Promise<void> {
  for (const relativePath of paths) {
    throwIfCancelled(signal);
    await capturePath(state, relativePath, signal, 0);
  }
}

async function capturePath(
  state: CaptureState,
  relativePath: string,
  signal: AbortSignal | undefined,
  depth: number,
): Promise<void> {
  if (isExcludedPath(relativePath) || state.seen.has(relativePath)) {
    return;
  }
  if (depth > MAX_DIRECTORY_DEPTH) {
    throw new ReviewFreshnessError(
      "depth-limit",
      `path recursion exceeds ${MAX_DIRECTORY_DEPTH} levels`,
    );
  }
  state.seen.add(relativePath);
  throwIfCancelled(signal);
  const fullPath = joinRelative(state.root, relativePath);
  let stats: FileStats;
  try {
    stats = await fs.lstat(fullPath);
  } catch (error) {
    if (isErrorCode(error, "ENOENT")) {
      await ensureMissingPathSafe(state.root, fullPath, signal);
      reserveFile(state);
      state.entries.push({ kind: "missing", path: relativePath });
      return;
    }
    throw new ReviewFreshnessError(
      "read-error",
      `could not inspect target path ${relativePath}`,
    );
  }

  await assertExistingPathSafe(state.root, fullPath, stats, signal);
  if (stats.isDirectory()) {
    await captureDirectory(state, fullPath, relativePath, signal, depth);
    return;
  }
  if (!stats.isFile()) {
    throw new ReviewFreshnessError(
      "special-file",
      `target path ${relativePath} is not a regular file or directory`,
    );
  }
  state.entries.push(
    await readRegularFile(state, fullPath, relativePath, stats, signal),
  );
}

async function captureDirectory(
  state: CaptureState,
  fullPath: string,
  relativePath: string,
  signal: AbortSignal | undefined,
  depth: number,
): Promise<void> {
  const names: string[] = [];
  let directory: Awaited<ReturnType<typeof fs.opendir>> | undefined;
  try {
    directory = await fs.opendir(fullPath);
    const entryLimit = Math.min(
      MAX_DIRECTORY_ENTRIES,
      state.limits.maxFiles + 1,
    );
    for await (const entry of directory) {
      throwIfCancelled(signal);
      if (EXCLUDED_SEGMENTS.has(entry.name)) {
        continue;
      }
      if (names.length >= entryLimit) {
        throw new ReviewFreshnessError(
          "file-limit",
          "directory entries exceed the bounded file limit",
        );
      }
      names.push(entry.name);
    }
  } catch (error) {
    if (error instanceof ReviewFreshnessError) {
      throw error;
    }
    throw new ReviewFreshnessError(
      "read-error",
      `could not enumerate target directory ${relativePath}`,
    );
  } finally {
    await directory?.close().catch(() => undefined);
  }

  names.sort(compareStrings);
  for (const name of names) {
    const childPath = relativePath === "." ? name : `${relativePath}/${name}`;
    await capturePath(state, childPath, signal, depth + 1);
  }
}

async function assertExistingPathSafe(
  root: string,
  fullPath: string,
  stats: FileStats,
  signal?: AbortSignal,
): Promise<void> {
  throwIfCancelled(signal);
  if (stats.isSymbolicLink()) {
    throw new ReviewFreshnessError(
      "unsafe-path",
      "symbolic links are not captured",
    );
  }
  try {
    if (!isContained(root, await fs.realpath(fullPath))) {
      throw new ReviewFreshnessError(
        "unsafe-path",
        "target path resolves outside the capture root",
      );
    }
  } catch (error) {
    if (error instanceof ReviewFreshnessError) {
      throw error;
    }
    throw new ReviewFreshnessError(
      "read-error",
      "could not verify target path containment",
    );
  }
}

async function ensureMissingPathSafe(
  root: string,
  fullPath: string,
  signal?: AbortSignal,
): Promise<void> {
  let ancestor = path.dirname(fullPath);
  while (true) {
    throwIfCancelled(signal);
    try {
      const stats = await fs.lstat(ancestor);
      if (stats.isSymbolicLink()) {
        throw new ReviewFreshnessError(
          "unsafe-path",
          "missing target path has a symbolic-link parent",
        );
      }
      if (!stats.isDirectory()) {
        throw new ReviewFreshnessError(
          "read-error",
          "missing target path has a non-directory parent",
        );
      }
      if (!isContained(root, await fs.realpath(ancestor))) {
        throw new ReviewFreshnessError(
          "unsafe-path",
          "missing target path resolves outside the capture root",
        );
      }
      return;
    } catch (error) {
      if (error instanceof ReviewFreshnessError) {
        throw error;
      }
      if (!isErrorCode(error, "ENOENT")) {
        throw new ReviewFreshnessError(
          "read-error",
          "could not verify missing target path containment",
        );
      }
      const parent = path.dirname(ancestor);
      if (parent === ancestor || !isContained(root, parent)) {
        throw new ReviewFreshnessError(
          "unsafe-path",
          "missing target path escapes the capture root",
        );
      }
      ancestor = parent;
    }
  }
}

async function readRegularFile(
  state: CaptureState,
  fullPath: string,
  relativePath: string,
  stats: FileStats,
  signal?: AbortSignal,
): Promise<FileFingerprint> {
  reserveFile(state);
  if (stats.size > state.limits.maxBytes - state.byteCount) {
    throw new ReviewFreshnessError(
      "byte-limit",
      `file ${relativePath} exceeds the bounded byte limit`,
    );
  }

  let handle: Awaited<ReturnType<typeof fs.open>> | undefined;
  try {
    const noFollow =
      typeof constants.O_NOFOLLOW === "number" ? constants.O_NOFOLLOW : 0;
    handle = await fs.open(
      fullPath,
      constants.O_RDONLY + noFollow + constants.O_NONBLOCK,
    );
    const opened = await handle.stat();
    if (
      !opened.isFile() ||
      opened.size !== stats.size ||
      fileMode(opened) !== fileMode(stats)
    ) {
      throw new ReviewFreshnessError(
        "unstable-file",
        `file ${relativePath} changed while being opened`,
      );
    }

    const digest = createHash("sha256");
    const buffer = new Uint8Array(FILE_READ_CHUNK_BYTES);
    let offset = 0;
    while (offset < stats.size) {
      throwIfCancelled(signal);
      const bytesToRead = Math.min(buffer.byteLength, stats.size - offset);
      const { bytesRead } = await handle.read(buffer, 0, bytesToRead, offset);
      if (bytesRead === 0) {
        throw new ReviewFreshnessError(
          "unstable-file",
          `file ${relativePath} became shorter while being read`,
        );
      }
      if (state.byteCount + bytesRead > state.limits.maxBytes) {
        throw new ReviewFreshnessError(
          "byte-limit",
          `target exceeds the ${state.limits.maxBytes}-byte limit`,
        );
      }
      digest.update(buffer.subarray(0, bytesRead));
      state.byteCount += bytesRead;
      offset += bytesRead;
    }

    const final = await handle.stat();
    if (
      !final.isFile() ||
      final.size !== stats.size ||
      fileMode(final) !== fileMode(stats) ||
      final.mtimeMs !== opened.mtimeMs ||
      final.ctimeMs !== opened.ctimeMs
    ) {
      throw new ReviewFreshnessError(
        "unstable-file",
        `file ${relativePath} changed while being read`,
      );
    }
    throwIfCancelled(signal);
    return {
      digest: digest.digest("hex"),
      kind: "file",
      mode: fileMode(stats),
      path: relativePath,
      size: stats.size,
    };
  } catch (error) {
    if (error instanceof ReviewFreshnessError) {
      throw error;
    }
    if (isErrorCode(error, "ELOOP")) {
      throw new ReviewFreshnessError(
        "unsafe-path",
        `file ${relativePath} became a symbolic link`,
      );
    }
    throw new ReviewFreshnessError(
      "read-error",
      `could not read target file ${relativePath}`,
    );
  } finally {
    await handle?.close().catch(() => undefined);
  }
}

function reserveFile(state: CaptureState): void {
  if (state.fileCount >= state.limits.maxFiles) {
    throw new ReviewFreshnessError(
      "file-limit",
      `target exceeds the ${state.limits.maxFiles}-file limit`,
    );
  }
  state.fileCount += 1;
}

function joinRelative(root: string, relativePath: string): string {
  return relativePath === "."
    ? root
    : path.join(root, ...relativePath.split("/"));
}

function fileMode(stats: { mode: number }): number {
  return stats.mode % 0o1_0000;
}

function hashCapture(
  descriptor: string,
  identity: readonly string[],
  entries: readonly FileFingerprint[],
): string {
  const hash = createHash("sha256");
  hashPart(hash, "supa-pi-review-freshness-v1");
  hashPart(hash, descriptor);
  for (const item of identity) {
    hashPart(hash, item);
  }
  for (const entry of [...entries].sort(compareEntries)) {
    hashPart(hash, JSON.stringify(entry));
  }
  return hash.digest("hex");
}

function hashPart(hash: ReturnType<typeof createHash>, value: string): void {
  const bytes = TEXT_ENCODER.encode(value);
  hash.update(String(bytes.byteLength));
  hash.update(":");
  hash.update(bytes);
  hash.update("\0");
}

function compareChangedPaths(left: ChangedPath, right: ChangedPath): number {
  return compareStrings(
    `${left.path}\0${left.status}`,
    `${right.path}\0${right.status}`,
  );
}

function compareEntries(left: FileFingerprint, right: FileFingerprint): number {
  return compareStrings(
    `${left.path}\0${left.kind}`,
    `${right.path}\0${right.kind}`,
  );
}

function compareStrings(left: string, right: string): number {
  if (left < right) {
    return -1;
  }
  if (left > right) {
    return 1;
  }
  return 0;
}

function hasControlCharacter(value: string): boolean {
  for (const character of value) {
    const codePoint = character.codePointAt(0);
    if (codePoint !== undefined && (codePoint < 32 || codePoint === 127)) {
      return true;
    }
  }
  return false;
}

function throwIfCancelled(signal?: AbortSignal): void {
  if (signal?.aborted) {
    throw new ReviewFreshnessError(
      "cancelled",
      "freshness capture was cancelled",
    );
  }
}

interface GitResult {
  readonly exitCode: number;
  readonly stdout: string;
}

async function runGit(
  cwd: string,
  args: readonly string[],
  signal?: AbortSignal,
): Promise<string> {
  const result = await runGitResult(cwd, args, signal);
  if (result.exitCode !== 0) {
    throwGitFailure();
  }
  return result.stdout;
}

async function runGitResult(
  cwd: string,
  args: readonly string[],
  signal?: AbortSignal,
): Promise<GitResult> {
  throwIfCancelled(signal);
  return await new Promise((resolve, reject) => {
    execFile(
      "git",
      [
        "--no-pager",
        "--literal-pathspecs",
        "-c",
        "core.fsmonitor=false",
        "-c",
        "core.hooksPath=/dev/null",
        ...args,
      ],
      {
        cwd,
        encoding: "buffer",
        maxBuffer: MAX_GIT_OUTPUT_BYTES,
        timeout: 30_000,
        killSignal: "SIGKILL",
        signal,
        env: {
          ...process.env,
          GIT_TERMINAL_PROMPT: "0",
          GIT_OPTIONAL_LOCKS: "0",
        },
      },
      (error, stdout) => {
        if (signal?.aborted) {
          reject(
            new ReviewFreshnessError(
              "cancelled",
              "freshness capture was cancelled",
            ),
          );
          return;
        }
        if (error && isErrorCode(error, "ERR_CHILD_PROCESS_STDIO_MAXBUFFER")) {
          reject(
            new ReviewFreshnessError(
              "git-output-limit",
              "Git failed, timed out, or exceeded its bounded output limit",
            ),
          );
          return;
        }
        const exitCode = error ? numericErrorCode(error) : 0;
        if (exitCode === undefined) {
          reject(
            new ReviewFreshnessError(
              "git-error",
              "Git failed, timed out, or exceeded its bounded output limit",
            ),
          );
          return;
        }
        try {
          resolve({
            exitCode,
            stdout: new TextDecoder("utf-8", { fatal: true }).decode(stdout),
          });
        } catch {
          reject(
            new ReviewFreshnessError(
              "git-error",
              "Git returned non-UTF-8 path metadata",
            ),
          );
        }
      },
    );
  });
}

function throwGitFailure(): never {
  throw new ReviewFreshnessError(
    "git-error",
    "Git failed, timed out, or exceeded its bounded output limit",
  );
}

function numericErrorCode(error: unknown): number | undefined {
  if (typeof error !== "object" || error === null || !("code" in error)) {
    return;
  }
  const code = error.code;
  return typeof code === "number" ? code : undefined;
}

function isErrorCode(error: unknown, code: string): boolean {
  return (
    typeof error === "object" &&
    error !== null &&
    "code" in error &&
    error.code === code
  );
}
