import { constants } from "node:fs";
import {
  access as fsAccess,
  lstat as fsLstat,
  mkdir as fsMkdir,
  readFile as fsReadFile,
  realpath as fsRealpath,
  unlink as fsUnlink,
  writeFile as fsWriteFile,
} from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, isAbsolute, resolve as resolvePath } from "node:path";
import { fileURLToPath } from "node:url";

import { createTwoFilesPatch } from "diff";

import { prepareUnifiedEditArguments } from "./unified-edit-migration";
import { buildUnifiedEditPlan } from "./unified-edit-planner";
import {
  type UnifiedEditParameters,
  unifiedEditSchema,
} from "./unified-edit-schema";

export const MAX_DIFF_BYTES = 200_000;
export const MAX_DIFF_LINES = 4000;
const MAX_FILE_MUTATION_QUEUE_DEPTH = 50;
const MAX_CANONICALIZE_PATH_LENGTH = 4096;
const MAX_CANONICALIZE_PATH_SEGMENTS = 256;
const MAX_CANONICALIZE_REALPATH_ATTEMPTS = 512;
const PATH_SEGMENT_SEPARATOR_PATTERN = /[\\/]+/;

function isErrnoException(error: unknown): error is NodeJS.ErrnoException {
  return error instanceof Error && "code" in error;
}

async function pathExistsNoFollow(absolutePath: string): Promise<boolean> {
  try {
    await fsLstat(absolutePath);
    return true;
  } catch (error) {
    if (
      isErrnoException(error) &&
      (error.code === "ENOENT" || error.code === "ENOTDIR")
    ) {
      return false;
    }
    throw error;
  }
}

async function preflightAddParent(absolutePath: string): Promise<void> {
  let parent = dirname(absolutePath);
  while (true) {
    try {
      const stats = await fsLstat(parent);
      if (!stats.isDirectory()) {
        throw new Error(`Add parent is not a directory: ${parent}.`);
      }
      // POSIX creation requires write and search permission on the directory.
      // biome-ignore lint/suspicious/noBitwiseOperators: fs.access modes are bit flags.
      await fsAccess(parent, constants.W_OK | constants.X_OK);
      return;
    } catch (error) {
      if (!isErrnoException(error) || error.code !== "ENOENT") {
        throw error;
      }
      const next = dirname(parent);
      if (next === parent) {
        throw error;
      }
      parent = next;
    }
  }
}

function findFirstChangedLine(
  oldContent: string,
  newContent: string
): number | undefined {
  if (oldContent === newContent) {
    return;
  }
  const oldLines = oldContent.split("\n");
  const newLines = newContent.split("\n");
  const length = Math.max(oldLines.length, newLines.length);
  for (let index = 0; index < length; index++) {
    if (oldLines[index] !== newLines[index]) {
      return index + 1;
    }
  }
}

function generateDiffString(
  filePath: string,
  oldContent: string,
  newContent: string,
  missing: { old: boolean; new: boolean },
  requireComplete: boolean
): {
  diff: string;
  diffOmitted: boolean;
  firstChangedLine: number | undefined;
} {
  const inputBytes =
    Buffer.byteLength(oldContent, "utf8") +
    Buffer.byteLength(newContent, "utf8");
  const inputLines =
    oldContent.split("\n").length + newContent.split("\n").length;
  if (inputBytes > MAX_DIFF_BYTES || inputLines > MAX_DIFF_LINES) {
    if (requireComplete) {
      throw new Error(
        `Planned diff for ${filePath} exceeds the global diff ceiling.`
      );
    }
    return {
      diff: "",
      diffOmitted: true,
      firstChangedLine: findFirstChangedLine(oldContent, newContent),
    };
  }
  return {
    diff: createTwoFilesPatch(
      missing.old ? "/dev/null" : filePath,
      missing.new ? "/dev/null" : filePath,
      oldContent,
      newContent,
      undefined,
      undefined,
      { context: 4 }
    ),
    diffOmitted: false,
    firstChangedLine: findFirstChangedLine(oldContent, newContent),
  };
}

function buildCombinedDiff(
  results: Array<{ diff: string; diffOmitted: boolean }>,
  requireComplete: boolean
): { diff: string; omitted: boolean } {
  if (results.some((result) => result.diffOmitted)) {
    return { diff: "", omitted: true };
  }
  const diff = results.map((result) => result.diff).join("\n");
  if (
    Buffer.byteLength(diff, "utf8") > MAX_DIFF_BYTES ||
    diff.split("\n").length > MAX_DIFF_LINES
  ) {
    if (requireComplete) {
      throw new Error("Planned diff exceeds the global diff ceiling.");
    }
    return { diff: "", omitted: true };
  }
  return { diff, omitted: false };
}

interface FileMutationQueueEntry {
  depth: number;
  tail: Promise<void>;
}
const fileMutationQueues = new Map<string, FileMutationQueueEntry>();

interface CanonicalizeMutationPathContext {
  cache: Map<string, string>;
  realpathAttempts: number;
}
function createCanonicalizeMutationPathContext(): CanonicalizeMutationPathContext {
  return { cache: new Map(), realpathAttempts: 0 };
}
async function canonicalizeMutationPath(
  path: string,
  context = createCanonicalizeMutationPathContext()
): Promise<string> {
  let current = resolvePath(path);
  if (
    current.length > MAX_CANONICALIZE_PATH_LENGTH ||
    current.split(PATH_SEGMENT_SEPARATOR_PATTERN).length >
      MAX_CANONICALIZE_PATH_SEGMENTS
  ) {
    throw new Error(
      `Path exceeds maximum canonicalization size of ${MAX_CANONICALIZE_PATH_LENGTH} characters / ${MAX_CANONICALIZE_PATH_SEGMENTS} segments`
    );
  }
  const cached = context.cache.get(current);
  if (cached) {
    return cached;
  }
  const original = current;
  const missingParts: string[] = [];
  while (true) {
    const currentCached = context.cache.get(current);
    if (currentCached) {
      const result = missingParts.length
        ? resolvePath(currentCached, ...missingParts.reverse())
        : currentCached;
      context.cache.set(original, result);
      return result;
    }
    context.realpathAttempts++;
    if (context.realpathAttempts > MAX_CANONICALIZE_REALPATH_ATTEMPTS) {
      throw new Error(
        `Path canonicalization exceeds maximum realpath attempts of ${MAX_CANONICALIZE_REALPATH_ATTEMPTS}`
      );
    }
    try {
      const real = await fsRealpath(current);
      context.cache.set(current, real);
      const result = missingParts.length
        ? resolvePath(real, ...missingParts.reverse())
        : real;
      context.cache.set(original, result);
      return result;
    } catch (error) {
      if (!isErrnoException(error) || error.code !== "ENOENT") {
        throw error;
      }
      const parent = dirname(current);
      if (parent === current) {
        const result = resolvePath(path);
        context.cache.set(original, result);
        return result;
      }
      missingParts.push(current.slice(parent.length + 1));
      current = parent;
    }
  }
}

export async function withFileMutationQueue<T>(
  paths: string[],
  fn: () => Promise<T>,
  signal?: AbortSignal,
  canonicalizeContext = createCanonicalizeMutationPathContext()
): Promise<T> {
  if (signal?.aborted) {
    throw new Error("Operation aborted");
  }
  const canonicalPaths: string[] = [];
  for (const path of paths) {
    if (signal?.aborted) {
      throw new Error("Operation aborted");
    }
    canonicalPaths.push(
      await canonicalizeMutationPath(path, canonicalizeContext)
    );
  }
  const keys = [...new Set(canonicalPaths)].sort();
  for (const key of keys) {
    if (
      (fileMutationQueues.get(key)?.depth ?? 0) >= MAX_FILE_MUTATION_QUEUE_DEPTH
    ) {
      throw new Error(
        `File mutation queue for ${key} exceeds maximum depth of ${MAX_FILE_MUTATION_QUEUE_DEPTH}`
      );
    }
  }
  const previousEntries = keys.map((key) => fileMutationQueues.get(key));
  const previous = Promise.all(
    previousEntries.map((entry) => entry?.tail.catch(() => undefined))
  );
  let release!: () => void;
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  const current = previous.then(() => gate);
  for (const key of keys) {
    const entry = fileMutationQueues.get(key);
    fileMutationQueues.set(key, {
      depth: (entry?.depth ?? 0) + 1,
      tail: current,
    });
  }
  let abortHandler: (() => void) | undefined;
  const abortPromise = signal
    ? new Promise<never>((_, reject) => {
        abortHandler = () => reject(new Error("Operation aborted"));
        signal.addEventListener("abort", abortHandler, { once: true });
      })
    : undefined;
  try {
    if (signal?.aborted) {
      throw new Error("Operation aborted");
    }
    await (abortPromise ? Promise.race([previous, abortPromise]) : previous);
    if (signal?.aborted) {
      throw new Error("Operation aborted");
    }
    return await fn();
  } finally {
    if (abortHandler) {
      signal?.removeEventListener("abort", abortHandler);
    }
    release();
    for (const [index, key] of keys.entries()) {
      const entry = fileMutationQueues.get(key);
      if (!entry) {
        continue;
      }
      if (entry.tail === current) {
        const depth = entry.depth - 1;
        const previousEntry = previousEntries[index];
        if (depth > 0 && previousEntry) {
          fileMutationQueues.set(key, { depth, tail: previousEntry.tail });
        } else {
          fileMutationQueues.delete(key);
        }
      } else {
        entry.depth--;
      }
    }
  }
}

function normalizePathUnicodeSpaces(filePath: string): string {
  return filePath.replace(/[\u00A0\u2000-\u200A\u202F\u205F\u3000]/g, " ");
}

export function resolveToCwd(cwd: string, filePath: string): string {
  let resolvedPath = normalizePathUnicodeSpaces(filePath);
  if (resolvedPath.startsWith("@")) {
    resolvedPath = resolvedPath.slice(1);
  }
  if (resolvedPath.startsWith("file://")) {
    return resolvePath(normalizePathUnicodeSpaces(fileURLToPath(resolvedPath)));
  }
  if (resolvedPath === "~" || resolvedPath.startsWith("~/")) {
    resolvedPath = resolvePath(homedir(), resolvedPath.slice(2));
  }
  return isAbsolute(resolvedPath)
    ? resolvePath(resolvedPath)
    : resolvePath(cwd, resolvedPath);
}

function pathsHaveAncestorDescendantConflict(a: string, b: string): boolean {
  let current = dirname(a);
  while (current !== a) {
    if (current === b) {
      return true;
    }
    const parent = dirname(current);
    if (parent === current) {
      return false;
    }
    current = parent;
  }
  return false;
}

export const ROW_EXAMPLE = `[src/app.ts]
@REPLACE
 export function run() {
-  return false;
+  return true;
 }
@@
-oldCall();
+newCall();
[README.md]
@APPEND
+Done.`;

export const PATCH_EXAMPLE = `*** Begin Patch
*** Add File: src/new.ts
+export const ready = true;
*** Update File: src/app.ts
@@ function start()
-  boot(false);
+  boot(true);
*** Delete File: obsolete.txt
*** End Patch`;

export const TOOL_DESCRIPTION = `Edit files with exactly one local unified-edit { text } payload. Choose either the row dialect or Codex patch dialect.

Row grammar (repeat [path] sections to edit multiple files):
[path]
@INS.PRE N       insert + rows before 1-based line N
@INS.POST N      insert + rows after 1-based line N
@INS.BEFORE      insert + rows before the unique - anchor block
@INS.AFTER       insert + rows after the unique - anchor block
@APPEND          append + rows
@REPLACE         replace unique - rows with + rows; context rows start with one space
@DEL N           delete line N
@DEL N-M         delete the inclusive range; N.M, N..M, N.=M, N..=M, and spaced forms are aliases
Operation names are case-insensitive. Under @REPLACE, contiguous -, +, and space-prefixed context rows form groups; @@ separates contextual hunks. Without context, pair one - block with one + block (either order); a lone - block deletes matched text. Anchor insertion requires exactly one - block and one + block. @INS.*, @APPEND accept only + rows. Blank unmarked script lines are ignored. Every content row must carry its marker: prefix literal leading +, -, space, or @ content with the operation marker too (for example ++plus inserts "+plus", --minus matches "-minus", and +@tag inserts "@tag"). Paths may be relative, absolute, file:// URLs, or prefixed with @; the leading @ path alias is removed.

Row example:
${ROW_EXAMPLE}

Codex patch grammar:
*** Begin Patch
*** Add File: path       followed only by + content rows
*** Update File: path    followed by one or more hunks
@@ optional unique context line
 unchanged context
-old
+new
*** End of File          optional hunk end anchor
*** Delete File: path
*** End Patch
Repeat Add/Update/Delete headers for multiple files. Update rows use space, -, and + markers; later hunks normally begin with @@ or @@ context. Empty lines inside update hunks are context. Add creates only new files. Delete permanently removes files only when local delete configuration is enabled and confirmation is granted interactively against the exact planned diff. Move headers (*** Move to:) are not supported.

Patch example:
${PATCH_EXAMPLE}

Local safety: all targets are planned and validated before mutation; ambiguous matches, overlapping targets, changed planning snapshots, no-op changes, limits, and unsafe add collisions fail. Add File requires the write tool to be enabled. Moves are never performed. Do not mix dialects or include prose outside the payload.`;

export const TOOL_PROMPT_SNIPPET =
  "Use edit with one { text } local unified-edit row script or Codex patch payload.";
export const TOOL_PROMPT_GUIDELINES = [
  "Use edit row mode for concise line, anchor, append, replace, or delete operations across known files.",
  "Use edit patch mode when a contextual Codex Add/Update/Delete patch is clearer or creates files.",
  "Before calling edit, include enough context for every content match to be unique and use exact planned targets.",
];

function collectFilesInOrder(results: Array<{ path: string }>): string[] {
  return [...new Set(results.map((result) => result.path))];
}

export const editTool = {
  name: "edit",
  label: "edit",
  description: TOOL_DESCRIPTION,
  promptSnippet: TOOL_PROMPT_SNIPPET,
  promptGuidelines: TOOL_PROMPT_GUIDELINES,
  parameters: unifiedEditSchema,
  prepareArguments: prepareUnifiedEditArguments,

  async execute(
    _toolCallId,
    params: UnifiedEditParameters,
    signal,
    _onUpdate,
    ctx
  ) {
    if (signal?.aborted) {
      throw new Error("Operation aborted");
    }
    const plan = await buildUnifiedEditPlan(params.text, ctx.cwd);
    const deletes = plan.changes.filter((change) => change.kind === "delete");
    const adds = plan.changes.filter((change) => change.kind === "add");
    if (adds.length && ctx.toolDisplayAllowPatchAdd !== true) {
      throw new Error("Patch Add File requires the write tool to be enabled.");
    }
    if (deletes.length && ctx.toolDisplayAllowPermanentDelete !== true) {
      throw new Error(
        "Permanent delete is disabled. Set tools.edit.allowPermanentDelete=true to enable confirmed deletes."
      );
    }
    for (const change of deletes) {
      if ((await fsLstat(change.absolutePath)).isSymbolicLink()) {
        throw new Error(`Refusing to delete symbolic link: ${change.path}.`);
      }
    }
    const results = plan.changes.map((change) => ({
      path: change.path,
      ...generateDiffString(
        change.path,
        change.oldText,
        change.newText,
        {
          old: change.kind === "add",
          new: change.kind === "delete",
        },
        deletes.length > 0
      ),
    }));
    const combinedDiff = buildCombinedDiff(results, deletes.length > 0);
    if (deletes.length) {
      if (!ctx.hasUI || (ctx.mode !== "tui" && ctx.mode !== "rpc")) {
        throw new Error(
          "Permanent delete requires confirmation and is unavailable in JSON/print mode."
        );
      }
      const approved = await ctx.ui.confirm(
        "Confirm permanent file deletion",
        `Deleted paths:\n${deletes.map((change) => `- ${change.path}`).join("\n")}\n\nComplete planned diff:\n${combinedDiff.diff}`
      );
      if (!approved) {
        throw new Error("Permanent delete was not approved; no files changed.");
      }
    }
    const canonicalizeContext = createCanonicalizeMutationPathContext();
    return withFileMutationQueue(
      plan.changes.map((change) => change.absolutePath),
      async () => {
        const canonicalChanges = new Map<
          string,
          (typeof plan.changes)[number]
        >();
        for (const change of plan.changes) {
          const canonical = await canonicalizeMutationPath(
            change.absolutePath,
            canonicalizeContext
          );
          if (canonicalChanges.has(canonical)) {
            throw new Error(
              `Multiple planned paths resolve to the same target: ${change.path}.`
            );
          }
          canonicalChanges.set(canonical, change);
        }
        const canonicalPaths = [...canonicalChanges.keys()];
        for (let i = 0; i < canonicalPaths.length; i++) {
          for (let j = i + 1; j < canonicalPaths.length; j++) {
            if (
              pathsHaveAncestorDescendantConflict(
                canonicalPaths[i],
                canonicalPaths[j]
              ) ||
              pathsHaveAncestorDescendantConflict(
                canonicalPaths[j],
                canonicalPaths[i]
              )
            ) {
              throw new Error(
                "Planned targets overlap as ancestor and descendant paths."
              );
            }
          }
        }
        for (const [canonical, change] of canonicalChanges) {
          if (signal?.aborted) {
            throw new Error("Operation aborted");
          }
          const mutationPath =
            change.kind === "delete" ? change.absolutePath : canonical;
          const exists = await pathExistsNoFollow(mutationPath);
          if (
            change.kind === "delete" &&
            exists &&
            (await fsLstat(mutationPath)).isSymbolicLink()
          ) {
            throw new Error(
              `Refusing to delete symbolic link: ${change.path}.`
            );
          }
          if (change.kind === "add") {
            if (exists) {
              throw new Error(`Add target already exists: ${change.path}.`);
            }
            await preflightAddParent(canonical);
          } else if (
            !exists ||
            (await fsReadFile(mutationPath, "utf8")) !== change.oldText
          ) {
            throw new Error(
              `Source changed after planning: ${change.path}; no files changed.`
            );
          } else if (change.kind === "delete") {
            // POSIX unlink permission is controlled by the parent directory.
            await fsAccess(
              dirname(change.absolutePath),
              // biome-ignore lint/suspicious/noBitwiseOperators: fs.access modes are bit flags.
              constants.W_OK | constants.X_OK
            );
          } else {
            // biome-ignore lint/suspicious/noBitwiseOperators: fs.access modes are bit flags.
            await fsAccess(canonical, constants.R_OK | constants.W_OK);
          }
        }
        for (const [canonical, change] of canonicalChanges) {
          if (signal?.aborted) {
            throw new Error("Operation aborted");
          }
          if (change.kind === "delete") {
            await fsUnlink(change.absolutePath);
          } else if (change.kind === "add") {
            await fsMkdir(dirname(canonical), { recursive: true });
            await fsWriteFile(canonical, change.newText, {
              encoding: "utf8",
              flag: "wx",
              signal,
            });
          } else {
            await fsWriteFile(canonical, change.newText, {
              encoding: "utf8",
              signal,
            });
          }
        }
        return {
          content: [
            {
              type: "text" as const,
              text: `Applied ${results.length} unified edit change(s).`,
            },
          ],
          details: {
            diff: combinedDiff.diff,
            patch: combinedDiff.diff,
            diffOmitted: combinedDiff.omitted,
            files: collectFilesInOrder(results),
            firstChangedLine: results.find(
              (result) => result.firstChangedLine !== undefined
            )?.firstChangedLine,
          },
        };
      },
      signal,
      canonicalizeContext
    );
  },
};
