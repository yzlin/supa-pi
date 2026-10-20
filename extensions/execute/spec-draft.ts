import { existsSync } from "node:fs";
import { join, resolve, sep } from "node:path";

import { SPEC_DRAFTED_ENTRY_TYPE } from "./constants";
import { SPECS_DIR, validSlug } from "./spec-log";

export interface DraftedSpec {
  slug: string;
  laterUserMessage: boolean;
}

export function draftedSpecSlug(cwd: string, path: unknown): string | null {
  if (typeof path !== "string") {
    return null;
  }
  const absPath = resolve(cwd, path.startsWith("@") ? path.slice(1) : path);
  const prefix = `${resolve(cwd, SPECS_DIR)}${sep}`;
  if (!absPath.startsWith(prefix) || !absPath.endsWith(".md")) {
    return null;
  }
  const slug = absPath.slice(prefix.length, -3);
  return validSlug(slug) ? slug : null;
}

function isUserMessage(entry: unknown): boolean {
  return (
    typeof entry === "object" &&
    entry !== null &&
    "type" in entry &&
    entry.type === "message" &&
    "message" in entry &&
    typeof entry.message === "object" &&
    entry.message !== null &&
    "role" in entry.message &&
    entry.message.role === "user"
  );
}

function markerSlug(entry: unknown): string | null {
  if (
    typeof entry !== "object" ||
    entry === null ||
    !("type" in entry) ||
    entry.type !== "custom" ||
    !("customType" in entry) ||
    entry.customType !== SPEC_DRAFTED_ENTRY_TYPE ||
    !("data" in entry) ||
    typeof entry.data !== "object" ||
    entry.data === null ||
    !("slug" in entry.data) ||
    typeof entry.data.slug !== "string" ||
    !validSlug(entry.data.slug)
  ) {
    return null;
  }
  return entry.data.slug;
}

// Only unaccepted Specs drafted on this branch qualify; accepted ones resume
// through the ledger instead.
export function latestDraftedSpec(
  branch: readonly unknown[],
  cwd: string,
): DraftedSpec | null {
  for (let index = branch.length - 1; index >= 0; index--) {
    const slug = markerSlug(branch[index]);
    if (
      slug &&
      existsSync(join(cwd, SPECS_DIR, `${slug}.md`)) &&
      !existsSync(join(cwd, SPECS_DIR, `${slug}.log.jsonl`))
    ) {
      return {
        slug,
        laterUserMessage: branch.slice(index + 1).some(isUserMessage),
      };
    }
  }
  return null;
}
