/*
 * Apache-2.0 source notice: ported from mitsuhiko/agent-stuff
 * extensions/unified-edit.ts at commit
 * 4bce45560fa55ace2f5dc8634a63a2af464ddc8b.
 * Copyright Armin Ronacher and contributors. Licensed under Apache-2.0.
 * Modified for supa-pi: injectable planning I/O, ambiguity rejection, and
 * BOM/line-ending preservation in planned old/new content.
 */
import { readFile, stat } from "node:fs/promises";
import { isAbsolute, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import {
  applyOriginalContentEdits,
  type MatcherBudget,
  normalizeForFuzzyMatch,
  normalizeToLF,
  type TextEdit,
} from "./unified-edit-matcher";
import {
  isPatchLikePayload,
  parsePatch,
  parseRowScript,
  type RowGroup,
  type RowOperation,
  type UpdateChunk,
} from "./unified-edit-parser";

const UNICODE_SPACES_PATTERN = /[\u00A0\u2000-\u200A\u202F\u205F\u3000]/g;
export const UNIFIED_EDIT_LIMITS = {
  inputBytes: 1_000_000,
  inputLines: 20_000,
  operations: 1000,
  targetBytes: 10_000_000,
  targetLines: 200_000,
  stagedBytes: 15_000_000,
  matcherComparisons: 200_000,
} as const;

function lineCount(text: string): number {
  return text.length === 0 ? 1 : text.split("\n").length;
}

function validateTextLimit(text: string, label: string): void {
  const bytes = Buffer.byteLength(text, "utf8");
  const lines = lineCount(text);
  if (
    bytes > UNIFIED_EDIT_LIMITS.targetBytes ||
    lines > UNIFIED_EDIT_LIMITS.targetLines
  ) {
    throw new Error(
      `${label} exceeds target limit of ${UNIFIED_EDIT_LIMITS.targetBytes} bytes / ${UNIFIED_EDIT_LIMITS.targetLines} lines.`
    );
  }
}

export interface PlannedFileChange {
  kind: "update" | "write" | "add" | "delete";
  path: string;
  absolutePath: string;
  oldText: string;
  newText: string;
}
export interface UnifiedEditPlan {
  mode: "rows" | "patch";
  changes: PlannedFileChange[];
}
export type PlanReader = (
  path: string,
  absolutePath: string
) => Promise<string | null>;

interface Format {
  bom: boolean;
  ending: "\n" | "\r\n";
}
function formatOf(raw: string): Format {
  return {
    bom: raw.startsWith("\uFEFF"),
    ending: raw.includes("\r\n") ? "\r\n" : "\n",
  };
}
function normalized(raw: string): string {
  return normalizeToLF(raw.startsWith("\uFEFF") ? raw.slice(1) : raw);
}
function restore(text: string, format: Format): string {
  const ending = format.ending === "\r\n" ? text.replace(/\n/g, "\r\n") : text;
  return format.bom ? `\uFEFF${ending}` : ending;
}
function absolute(cwd: string, path: string): string {
  const normalizedPath = path.replace(UNICODE_SPACES_PATTERN, " ");
  if (normalizedPath.startsWith("file://")) {
    return resolve(fileURLToPath(normalizedPath));
  }
  return isAbsolute(normalizedPath)
    ? resolve(normalizedPath)
    : resolve(cwd, normalizedPath);
}

function pairs(path: string, groups: RowGroup[]): TextEdit[] {
  const contextual = groups.some(
    (group) => group.marker === " " || group.marker === "@@"
  );
  if (contextual) {
    const hunks: RowGroup[][] = [[]];
    for (const group of groups) {
      if (group.marker === "@@") {
        if (hunks.at(-1)?.length) {
          hunks.push([]);
        }
      } else {
        hunks.at(-1)?.push(group);
      }
    }
    return hunks
      .filter((hunk) => hunk.length)
      .map((hunk) => {
        const oldLines: string[] = [];
        const newLines: string[] = [];
        let changed = false;
        for (const group of hunk) {
          if (group.marker === " ") {
            oldLines.push(...group.lines);
            newLines.push(...group.lines);
          } else if (group.marker === "-") {
            oldLines.push(...group.lines);
            changed = true;
          } else if (group.marker === "+") {
            newLines.push(...group.lines);
            changed = true;
          }
        }
        if (!(changed && oldLines.length)) {
          throw new Error(
            `@REPLACE hunk in ${path} needs changed and locating rows.`
          );
        }
        return { oldText: oldLines.join("\n"), newText: newLines.join("\n") };
      });
  }
  const changes = groups.filter(
    (group): group is RowGroup & { marker: "+" | "-" } =>
      group.marker === "+" || group.marker === "-"
  );
  if (changes.length === 1 && changes[0].marker === "-") {
    return [{ oldText: changes[0].lines.join("\n"), newText: "" }];
  }
  if (!changes.length || changes.length % 2) {
    throw new Error(`@REPLACE in ${path} must pair + and - blocks.`);
  }
  const result: TextEdit[] = [];
  for (let i = 0; i < changes.length; i += 2) {
    const a = changes[i];
    const b = changes[i + 1];
    if (a.marker === b.marker) {
      throw new Error(`@REPLACE in ${path} has adjacent ${a.marker} blocks.`);
    }
    result.push({
      oldText: (a.marker === "-" ? a : b).lines.join("\n"),
      newText: (a.marker === "+" ? a : b).lines.join("\n"),
    });
  }
  return result;
}
function split(content: string) {
  const finalNewline = content.endsWith("\n");
  const body = finalNewline ? content.slice(0, -1) : content;
  return { lines: body ? body.split("\n") : [], finalNewline };
}
function join(doc: { lines: string[]; finalNewline: boolean }) {
  const body = doc.lines.join("\n");
  return doc.finalNewline ? `${body}\n` : body;
}

export function applyRowOperations(
  path: string,
  content: string,
  operations: RowOperation[],
  matcherBudget?: MatcherBudget
): string {
  const doc = split(content);
  for (const operation of operations) {
    if (operation.kind === "insertBefore" || operation.kind === "insertAfter") {
      const index =
        operation.kind === "insertBefore" ? operation.line - 1 : operation.line;
      if (index < 0 || index > doc.lines.length) {
        throw new Error(`Insert line ${operation.line} is outside ${path}.`);
      }
      doc.lines.splice(index, 0, ...operation.rows);
      if (index + operation.rows.length === doc.lines.length) {
        doc.finalNewline = true;
      }
    } else if (operation.kind === "append") {
      doc.lines.push(...operation.rows);
      doc.finalNewline = true;
    } else if (operation.kind === "delete") {
      if (operation.endLine > doc.lines.length) {
        throw new Error(`@DEL range is outside ${path}.`);
      }
      doc.lines.splice(
        operation.startLine - 1,
        operation.endLine - operation.startLine + 1
      );
      if (!doc.lines.length) {
        doc.finalNewline = false;
      }
    } else if (operation.kind === "replace") {
      const edits = pairs(path, operation.groups);
      Object.assign(
        doc,
        split(
          applyOriginalContentEdits(
            join(doc),
            edits.map((edit) => ({
              ...edit,
              removeLineTerminator: edit.newText === "",
            })),
            path,
            true,
            matcherBudget
          )
        )
      );
    } else {
      if (!("groups" in operation)) {
        throw new Error(`Invalid row operation in ${path}.`);
      }
      const groups = operation.groups.filter(
        (group): group is RowGroup & { marker: "+" | "-" } =>
          (group.marker === "+" || group.marker === "-") &&
          group.lines.length > 0
      );
      if (groups.length !== 2 || groups[0].marker === groups[1].marker) {
        throw new Error(
          `Anchor insertion in ${path} needs one - and one + block.`
        );
      }
      const anchor = (
        groups[0].marker === "-" ? groups[0] : groups[1]
      ).lines.join("\n");
      const insertion = (
        groups[0].marker === "+" ? groups[0] : groups[1]
      ).lines.join("\n");
      const replacement =
        operation.kind === "insertBeforeAnchor"
          ? `${insertion}\n${anchor}`
          : `${anchor}\n${insertion}`;
      Object.assign(
        doc,
        split(
          applyOriginalContentEdits(
            join(doc),
            [{ oldText: anchor, newText: replacement }],
            path,
            true,
            matcherBudget
          )
        )
      );
    }
  }
  return join(doc);
}

function seek(
  lines: string[],
  pattern: string[],
  start: number,
  eof = false,
  matcherBudget?: MatcherBudget
): number {
  const begin = eof
    ? Math.max(0, lines.length - pattern.length)
    : Math.max(0, start);
  const comparators = [
    (a: string, b: string) => a === b,
    (a: string, b: string) => a.trimEnd() === b.trimEnd(),
    (a: string, b: string) =>
      normalizeForFuzzyMatch(a) === normalizeForFuzzyMatch(b),
  ];
  for (const equal of comparators) {
    const found: number[] = [];
    for (let i = begin; i <= lines.length - pattern.length; i++) {
      if (matcherBudget) {
        matcherBudget.remaining -= pattern.length;
        if (matcherBudget.remaining < 0) {
          throw new Error("Matcher comparison limit exceeded.");
        }
      }
      if (pattern.every((line, j) => equal(lines[i + j], line))) {
        found.push(i);
      }
    }
    if (found.length > 1) {
      throw new Error(
        "Patch hunk matched multiple locations. Add more context."
      );
    }
    if (found.length === 1) {
      return found[0];
    }
  }
  return -1;
}
export function applyPatchChunks(
  path: string,
  content: string,
  chunks: UpdateChunk[],
  matcherBudget?: MatcherBudget
): string {
  const finalNewline = content.endsWith("\n");
  const lines = content.split("\n");
  if (lines.at(-1) === "") {
    lines.pop();
  }
  const replacements: [number, number, string[]][] = [];
  let cursor = 0;
  for (const chunk of chunks) {
    if (chunk.changeContext !== undefined) {
      const context = seek(
        lines,
        [chunk.changeContext],
        cursor,
        false,
        matcherBudget
      );
      if (context < 0) {
        throw new Error(
          `Failed to find context '${chunk.changeContext}' in ${path}.`
        );
      }
      cursor = context + 1;
    }
    if (!chunk.oldLines.length) {
      if (chunk.changeContext === undefined) {
        throw new Error(
          `Insertion-only patch hunk in ${path} needs locating context.`
        );
      }
      replacements.push([cursor, 0, chunk.newLines]);
      continue;
    }
    let oldLines = chunk.oldLines;
    let found = seek(lines, oldLines, cursor, chunk.isEndOfFile, matcherBudget);
    if (found < 0 && oldLines.at(-1) === "") {
      oldLines = oldLines.slice(0, -1);
      found = seek(lines, oldLines, cursor, chunk.isEndOfFile, matcherBudget);
    }
    if (found < 0) {
      throw new Error(`Failed to find expected lines in ${path}.`);
    }
    const replacement: string[] = [];
    let source = found;
    for (const row of chunk.rows) {
      if (row.marker === "+") {
        replacement.push(row.line);
      } else if (source < found + oldLines.length) {
        if (row.marker === " ") {
          replacement.push(lines[source]);
        }
        source++;
      }
    }
    replacements.push([found, oldLines.length, replacement]);
    cursor = found + oldLines.length;
  }
  const next = [...lines];
  for (const [start, count, rows] of replacements.sort(
    (a, b) => b[0] - a[0] || b[1] - a[1]
  )) {
    next.splice(start, count, ...rows);
  }
  return next.join("\n") + (finalNewline ? "\n" : "");
}

export async function buildUnifiedEditPlan(
  text: string,
  cwd: string,
  reader: PlanReader = async (_path, target) => {
    try {
      const metadata = await stat(target);
      if (!metadata.isFile()) {
        throw new Error(`Target path ${target} is not a regular file.`);
      }
      if (metadata.size > UNIFIED_EDIT_LIMITS.targetBytes) {
        throw new Error(
          `Target ${target} exceeds target limit of ${UNIFIED_EDIT_LIMITS.targetBytes} bytes.`
        );
      }
      return await readFile(target, "utf8");
    } catch (error: unknown) {
      if (
        error instanceof Error &&
        "code" in error &&
        error.code === "ENOENT"
      ) {
        return null;
      }
      throw error;
    }
  }
): Promise<UnifiedEditPlan> {
  const inputBytes = Buffer.byteLength(text, "utf8");
  const inputLines = lineCount(normalizeToLF(text));
  if (
    inputBytes > UNIFIED_EDIT_LIMITS.inputBytes ||
    inputLines > UNIFIED_EDIT_LIMITS.inputLines
  ) {
    throw new Error(
      `Unified edit input exceeds limit of ${UNIFIED_EDIT_LIMITS.inputBytes} bytes / ${UNIFIED_EDIT_LIMITS.inputLines} lines.`
    );
  }
  const mode = isPatchLikePayload(text) ? "patch" : "rows";
  const matcherBudget = { remaining: UNIFIED_EDIT_LIMITS.matcherComparisons };
  let operationCount = 0;
  const snapshots = new Map<
    string,
    {
      path: string;
      absolutePath: string;
      original: string | null;
      current: string | null;
      format: Format;
    }
  >();
  const get = async (path: string) => {
    const target = absolute(cwd, path);
    let snapshot = snapshots.get(target);
    if (!snapshot) {
      const original = await reader(path, target);
      if (original !== null) {
        validateTextLimit(original, `Target ${path}`);
      }
      snapshot = {
        path,
        absolutePath: target,
        original,
        current: original,
        format: formatOf(original ?? ""),
      };
      snapshots.set(target, snapshot);
    }
    return snapshot;
  };
  if (mode === "rows") {
    for (const script of parseRowScript(text)) {
      operationCount += script.ops.length;
      if (operationCount > UNIFIED_EDIT_LIMITS.operations) {
        throw new Error(
          `Unified edit exceeds ${UNIFIED_EDIT_LIMITS.operations} operations.`
        );
      }
      const snapshot = await get(script.path);
      if (snapshot.current === null) {
        throw new Error(`Could not read ${script.path}.`);
      }
      snapshot.current = restore(
        applyRowOperations(
          script.path,
          normalized(snapshot.current),
          script.ops,
          matcherBudget
        ),
        snapshot.format
      );
    }
  } else {
    for (const operation of parsePatch(text)) {
      operationCount +=
        operation.kind === "update" ? operation.chunks.length : 1;
      if (operationCount > UNIFIED_EDIT_LIMITS.operations) {
        throw new Error(
          `Unified edit exceeds ${UNIFIED_EDIT_LIMITS.operations} operations.`
        );
      }
      const snapshot = await get(operation.path);
      if (operation.kind === "add") {
        if (snapshot.current !== null) {
          throw new Error(`Add target already exists: ${operation.path}.`);
        }
        snapshot.current = operation.contents;
      } else if (operation.kind === "delete") {
        if (snapshot.current === null) {
          throw new Error(`File does not exist: ${operation.path}.`);
        }
        snapshot.current = null;
      } else {
        if (snapshot.current === null) {
          throw new Error(`File does not exist: ${operation.path}.`);
        }
        snapshot.current = restore(
          applyPatchChunks(
            operation.path,
            normalized(snapshot.current),
            operation.chunks,
            matcherBudget
          ),
          snapshot.format
        );
      }
    }
  }
  const changes: PlannedFileChange[] = [];
  let stagedBytes = 0;
  for (const snapshot of snapshots.values()) {
    if (snapshot.original === snapshot.current) {
      continue;
    }
    if (snapshot.current !== null) {
      validateTextLimit(snapshot.current, `Staged target ${snapshot.path}`);
      stagedBytes += Buffer.byteLength(snapshot.current, "utf8");
      if (stagedBytes > UNIFIED_EDIT_LIMITS.stagedBytes) {
        throw new Error(
          `Staged content exceeds limit of ${UNIFIED_EDIT_LIMITS.stagedBytes} bytes.`
        );
      }
    }
    if (snapshot.original === null) {
      changes.push({
        kind: "add",
        path: snapshot.path,
        absolutePath: snapshot.absolutePath,
        oldText: "",
        newText: snapshot.current ?? "",
      });
    } else if (snapshot.current === null) {
      changes.push({
        kind: "delete",
        path: snapshot.path,
        absolutePath: snapshot.absolutePath,
        oldText: snapshot.original,
        newText: "",
      });
    } else {
      changes.push({
        kind: snapshot.original ? "update" : "write",
        path: snapshot.path,
        absolutePath: snapshot.absolutePath,
        oldText: snapshot.original,
        newText: snapshot.current,
      });
    }
  }
  if (!changes.length) {
    throw new Error(
      `The ${mode === "rows" ? "row edit script" : "patch"} produced no changes.`
    );
  }
  return { mode, changes };
}
