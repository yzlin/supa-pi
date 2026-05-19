import { execFileSync } from "node:child_process";

import type { DirtyBaseline, Result } from "./types";

function runGit(args: string[], cwd: string): string | null {
  try {
    return execFileSync("git", args, {
      cwd,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
    }).trim();
  } catch {
    return null;
  }
}

export function captureDirtyBaseline(cwd = process.cwd()): DirtyBaseline {
  const gitHead = runGit(["rev-parse", "HEAD"], cwd);
  const status = runGit(["status", "--porcelain"], cwd) ?? "";
  const dirtyFiles = status
    .split("\n")
    .map((line) => line.slice(3).trim())
    .filter((line) => line.length > 0)
    .sort();
  return { gitHead, dirtyFiles };
}

export function compareDirtyBaseline(
  baseline: DirtyBaseline,
  current: DirtyBaseline
): Result<{ added: string[]; removed: string[]; headChanged: boolean }> {
  const before = new Set(baseline.dirtyFiles);
  const after = new Set(current.dirtyFiles);
  return {
    ok: true,
    value: {
      added: [...after].filter((file) => !before.has(file)).sort(),
      removed: [...before].filter((file) => !after.has(file)).sort(),
      headChanged: baseline.gitHead !== current.gitHead,
    },
  };
}

export function assertDirtyBaselineUnchanged(
  baseline: DirtyBaseline,
  current: DirtyBaseline
): Result<void> {
  const compared = compareDirtyBaseline(baseline, current);
  if (!compared.ok) {
    return compared;
  }
  const { added, removed, headChanged } = compared.value;
  if (headChanged || added.length > 0 || removed.length > 0) {
    return {
      ok: false,
      error: `Dirty baseline changed: headChanged=${headChanged} added=${added.join(",") || "none"} removed=${removed.join(",") || "none"}.`,
    };
  }
  return { ok: true, value: undefined };
}
