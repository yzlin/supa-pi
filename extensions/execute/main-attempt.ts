import { homedir } from "node:os";
import { isAbsolute, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";

import type { Assignment } from "./schema";

// Header grammar copied from extensions/tool-display/unified-edit-parser.ts;
// sibling extensions cannot share code by import.
const ROW_FILE_HEADER = /^\[(.+)]\s*$/;
const PATCH_FILE_HEADER = /^\*\*\* (?:Add|Update|Delete) File: (.+)$/;
const PATCH_MOVE_HEADER = /^\*\*\* Move to: (.+)$/;
const UNICODE_SPACES = /[\u00A0\u2000-\u200A\u202F\u205F\u3000]/g;

function stripAlias(path: string): string {
  const trimmed = path.trim();
  return trimmed.startsWith("@") ? trimmed.slice(1) : trimmed;
}

/** Paths an edit/write call targets, or null when they cannot be determined. */
export function editTargets(
  toolName: string,
  input: Record<string, unknown>,
): string[] | null {
  if (typeof input.path === "string") {
    return [input.path];
  }
  if (toolName !== "edit" || typeof input.text !== "string") {
    return null;
  }
  const paths: string[] = [];
  for (const raw of input.text.replaceAll("\r\n", "\n").split("\n")) {
    const line = raw.trim();
    const match =
      ROW_FILE_HEADER.exec(line) ??
      PATCH_FILE_HEADER.exec(line) ??
      PATCH_MOVE_HEADER.exec(line);
    if (match?.[1]) {
      paths.push(stripAlias(match[1]));
    }
  }
  return paths.length > 0 ? paths : null;
}

function resolveTarget(cwd: string, path: string): string {
  let target = stripAlias(path.replace(UNICODE_SPACES, " "));
  if (target.startsWith("file://")) {
    return resolve(fileURLToPath(target));
  }
  if (target === "~" || target.startsWith("~/")) {
    target = resolve(homedir(), target.slice(2));
  }
  return isAbsolute(target) ? resolve(target) : resolve(cwd, target);
}

/** Targets outside the assignment's declared scope (lexical; symlinks are not resolved). */
export function outOfScope(
  workspace: string,
  assignment: Pick<Assignment, "scope" | "cwd">,
  targets: readonly string[],
): string[] {
  const base = resolve(workspace, assignment.cwd ?? ".");
  const roots = assignment.scope.map((scope) => resolve(base, scope));
  return targets.filter((path) => {
    const target = resolveTarget(workspace, path);
    return !roots.some(
      (root) =>
        target === root ||
        target.startsWith(root.endsWith(sep) ? root : `${root}${sep}`),
    );
  });
}

/** Freshness of one running main-executed attempt. */
export interface MainAttemptState {
  attemptId: string;
  /** True once a bash call succeeded after the latest edit/write. */
  checkedAfterLastEdit: boolean;
}
