/*
 * Apache-2.0 source notice: ported from mitsuhiko/agent-stuff
 * extensions/unified-edit.ts at commit
 * 4bce45560fa55ace2f5dc8634a63a2af464ddc8b.
 * Copyright Armin Ronacher and contributors. Licensed under Apache-2.0.
 * Modified for supa-pi: exported parser seam and local dialect naming.
 */
import { normalizeToLF } from "./unified-edit-matcher";

const FILE_HEADER_PATTERN = /^\[(.+)]\s*$/;
const INSERT_PATTERN = /^@INS\.(PRE|POST)\s+(\d+)\s*$/i;
const INSERT_BEFORE_PATTERN = /^@INS\.BEFORE\s*$/i;
const INSERT_AFTER_PATTERN = /^@INS\.AFTER\s*$/i;
const APPEND_PATTERN = /^@APPEND\s*$/i;
const REPLACE_PATTERN = /^@REPLACE\s*$/i;
const DELETE_PATTERN =
  /^@DEL\s+(\d+)(?:(?:\s*-\s*|\s*\.\.?=?\s*|\s*\.=\s*)(\d+))?\s*$/i;

export interface RowGroup {
  marker: "+" | "-" | " " | "@@";
  lines: string[];
}
export type RowOperation =
  | { kind: "insertBefore" | "insertAfter"; line: number; rows: string[] }
  | {
      kind: "insertBeforeAnchor" | "insertAfterAnchor" | "replace";
      groups: RowGroup[];
    }
  | { kind: "append"; rows: string[] }
  | { kind: "delete"; startLine: number; endLine: number };
export interface FileScript {
  path: string;
  ops: RowOperation[];
}
export interface UpdateChunk {
  changeContext?: string;
  oldLines: string[];
  newLines: string[];
  rows: Array<{ marker: " " | "+" | "-"; line: string }>;
  isEndOfFile: boolean;
}
export type PatchOperation =
  | { kind: "add"; path: string; contents: string }
  | { kind: "delete"; path: string }
  | { kind: "update"; path: string; chunks: UpdateChunk[] };

export function normalizeEditPath(path: string): string {
  const trimmed = path.trim();
  if (!trimmed) {
    throw new Error("File path cannot be empty.");
  }
  return trimmed.startsWith("@") ? trimmed.slice(1) : trimmed;
}

export function isPatchLikePayload(text: string): boolean {
  return normalizeToLF(text).trimStart().startsWith("*** Begin Patch");
}

export function parseRowScript(text: string): FileScript[] {
  const lines = normalizeToLF(text).split("\n");
  const files: FileScript[] = [];
  let file: FileScript | undefined;
  let op: RowOperation | undefined;
  const finish = () => {
    if (!op) {
      return;
    }
    if (!file) {
      throw new Error("Operation without file.");
    }
    if ("rows" in op && op.rows.length === 0) {
      throw new Error(`${op.kind} in ${file.path} has no + rows.`);
    }
    if ("groups" in op && op.groups.length === 0) {
      throw new Error(`Operation in ${file.path} has no + or - rows.`);
    }
    file.ops.push(op);
    op = undefined;
  };
  const requireFile = (line: number) => {
    if (!file) {
      throw new Error(`Line ${line}: expected a [filename] header.`);
    }
    return file;
  };
  const group = (marker: RowGroup["marker"], body?: string) => {
    if (!(op && "groups" in op)) {
      throw new Error("Group row without group operation.");
    }
    const last = op.groups.at(-1);
    if (marker !== "@@" && last?.marker === marker) {
      last.lines.push(body ?? "");
    } else {
      op.groups.push({ marker, lines: marker === "@@" ? [] : [body ?? ""] });
    }
  };

  for (let index = 0; index < lines.length; index++) {
    const raw = lines[index];
    const trimmed = raw.trim();
    const line = index + 1;
    if (raw === "") {
      continue;
    }
    const header = FILE_HEADER_PATTERN.exec(trimmed);
    if (header) {
      finish();
      file = { path: normalizeEditPath(header[1]), ops: [] };
      files.push(file);
      continue;
    }
    if (raw.startsWith("@@")) {
      if (op && "groups" in op) {
        group("@@");
      }
      continue;
    }
    if (raw.startsWith("@")) {
      const active = requireFile(line);
      finish();
      const insert = INSERT_PATTERN.exec(trimmed);
      if (insert) {
        const number = Number(insert[2]);
        if (!Number.isSafeInteger(number) || number < 1) {
          throw new Error(`Line ${line}: insert line number must be >= 1.`);
        }
        op = {
          kind:
            insert[1].toUpperCase() === "PRE" ? "insertBefore" : "insertAfter",
          line: number,
          rows: [],
        };
      } else if (INSERT_BEFORE_PATTERN.test(trimmed)) {
        op = { kind: "insertBeforeAnchor", groups: [] };
      } else if (INSERT_AFTER_PATTERN.test(trimmed)) {
        op = { kind: "insertAfterAnchor", groups: [] };
      } else if (APPEND_PATTERN.test(trimmed)) {
        op = { kind: "append", rows: [] };
      } else if (REPLACE_PATTERN.test(trimmed)) {
        op = { kind: "replace", groups: [] };
      } else {
        const deletion = DELETE_PATTERN.exec(trimmed);
        if (!deletion) {
          throw new Error(`Line ${line}: unknown edit operation ${trimmed}.`);
        }
        const startLine = Number(deletion[1]);
        const endLine = deletion[2] ? Number(deletion[2]) : startLine;
        if (startLine < 1 || endLine < startLine) {
          throw new Error(`Line ${line}: invalid inclusive delete range.`);
        }
        active.ops.push({ kind: "delete", startLine, endLine });
      }
      continue;
    }
    if (raw.startsWith("+") || raw.startsWith("-")) {
      requireFile(line);
      if (!op) {
        throw new Error(`Line ${line}: row appears before an operation.`);
      }
      const marker = raw[0] as "+" | "-";
      if ("rows" in op) {
        if (marker !== "+") {
          throw new Error(`Line ${line}: operation only accepts + rows.`);
        }
        op.rows.push(raw.slice(1));
      } else if ("groups" in op) {
        group(marker, raw.slice(1));
      } else {
        throw new Error(`Line ${line}: unexpected row for @DEL.`);
      }
      continue;
    }
    if (raw.startsWith(" ") && op && "groups" in op && op.kind === "replace") {
      group(" ", raw.slice(1));
      continue;
    }
    throw new Error(`Line ${line}: invalid row script line.`);
  }
  finish();
  if (files.length === 0) {
    throw new Error(
      "Row edit script must contain at least one [filename] section."
    );
  }
  for (const section of files) {
    if (section.ops.length === 0) {
      throw new Error(`File section [${section.path}] has no operations.`);
    }
  }
  return files;
}

function parseUpdateChunk(
  lines: string[],
  start: number,
  last: number,
  allowMissing: boolean
): { chunk: UpdateChunk; next: number } {
  let index = start;
  let changeContext: string | undefined;
  const first = lines[index].trimEnd();
  if (first === "@@") {
    index++;
  } else if (first.startsWith("@@ ")) {
    changeContext = first.slice(3);
    index++;
  } else if (!allowMissing) {
    throw new Error(
      `Expected update hunk to start with @@, got '${lines[index]}'`
    );
  }
  const oldLines: string[] = [];
  const newLines: string[] = [];
  const rows: UpdateChunk["rows"] = [];
  let parsed = 0;
  let isEndOfFile = false;
  while (index <= last) {
    const raw = lines[index];
    const trimmed = raw.trimEnd();
    if (trimmed === "*** End of File") {
      if (!parsed) {
        throw new Error("Empty update hunk.");
      }
      isEndOfFile = true;
      index++;
      break;
    }
    if (parsed && (trimmed.startsWith("@@") || trimmed.startsWith("*** "))) {
      break;
    }
    if (raw === "") {
      oldLines.push("");
      newLines.push("");
      rows.push({ marker: " ", line: "" });
      parsed++;
      index++;
      continue;
    }
    const body = raw.slice(1);
    if (raw[0] === " ") {
      oldLines.push(body);
      newLines.push(body);
      rows.push({ marker: " ", line: body });
    } else if (raw[0] === "-") {
      oldLines.push(body);
      rows.push({ marker: "-", line: body });
    } else if (raw[0] === "+") {
      newLines.push(body);
      rows.push({ marker: "+", line: body });
    } else if (parsed) {
      break;
    } else {
      throw new Error(`Unexpected line in update hunk: '${raw}'.`);
    }
    parsed++;
    index++;
  }
  if (!parsed) {
    throw new Error("Update hunk does not contain any lines.");
  }
  return {
    chunk: { changeContext, oldLines, newLines, rows, isEndOfFile },
    next: index,
  };
}

export function parsePatch(text: string): PatchOperation[] {
  const lines = normalizeToLF(text).trim().split("\n");
  if (lines[0]?.trim() !== "*** Begin Patch") {
    throw new Error("The first line must be '*** Begin Patch'.");
  }
  if (lines.at(-1)?.trim() !== "*** End Patch") {
    throw new Error("The last line must be '*** End Patch'.");
  }
  const operations: PatchOperation[] = [];
  const last = lines.length - 2;
  let index = 1;
  while (index <= last) {
    if (!lines[index].trim()) {
      index++;
      continue;
    }
    const line = lines[index].trim();
    if (line.startsWith("*** Add File: ")) {
      const path = normalizeEditPath(line.slice(14));
      const content: string[] = [];
      index++;
      while (index <= last && !lines[index].trim().startsWith("*** ")) {
        if (!lines[index].startsWith("+")) {
          throw new Error(`Invalid add-file line '${lines[index]}'.`);
        }
        content.push(lines[index].slice(1));
        index++;
      }
      operations.push({
        kind: "add",
        path,
        contents: content.length ? `${content.join("\n")}\n` : "",
      });
    } else if (line.startsWith("*** Delete File: ")) {
      operations.push({
        kind: "delete",
        path: normalizeEditPath(line.slice(17)),
      });
      index++;
    } else if (line.startsWith("*** Update File: ")) {
      const path = normalizeEditPath(line.slice(17));
      index++;
      if (lines[index]?.trim().startsWith("*** Move to: ")) {
        throw new Error("Patch move operations are not supported.");
      }
      const chunks: UpdateChunk[] = [];
      while (index <= last && !lines[index].trim().startsWith("*** ")) {
        if (!lines[index].trim()) {
          index++;
          continue;
        }
        const parsed = parseUpdateChunk(
          lines,
          index,
          last,
          chunks.length === 0
        );
        chunks.push(parsed.chunk);
        index = parsed.next;
      }
      if (!chunks.length) {
        throw new Error(`Update file hunk for '${path}' is empty.`);
      }
      operations.push({ kind: "update", path, chunks });
    } else {
      throw new Error(`'${line}' is not a valid hunk header.`);
    }
  }
  if (!operations.length) {
    throw new Error("Patch contains no operations.");
  }
  return operations;
}
