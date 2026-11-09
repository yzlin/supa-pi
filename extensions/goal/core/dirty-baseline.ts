import { execFileSync } from "node:child_process";

import type { DirtyBaseline } from "./types";

function runGit(args: string[], cwd: string): string | null {
  try {
    return execFileSync("git", args, {
      cwd,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
    });
  } catch {
    return null;
  }
}

// `-z` keeps each entry's two status columns intact and paths unquoted. A
// rename or copy in either column ("R  new\0old\0", " R new\0old\0") is
// followed by its source path, which is skipped; only the current path is
// recorded.
function parsePorcelainZ(status: string): string[] {
  const fields = status.split("\0");
  const paths: string[] = [];
  for (let index = 0; index < fields.length; index += 1) {
    const entry = fields[index];
    if (entry.length < 4) {
      continue;
    }
    paths.push(entry.slice(3));
    const columns = entry.slice(0, 2);
    if (columns.includes("R") || columns.includes("C")) {
      index += 1;
    }
  }
  return paths;
}

export function captureDirtyBaseline(cwd = process.cwd()): DirtyBaseline {
  const gitHead = runGit(["rev-parse", "HEAD"], cwd)?.trim() || null;
  const status = runGit(["status", "--porcelain", "-z"], cwd) ?? "";
  const dirtyFiles = parsePorcelainZ(status).sort();
  return { gitHead, dirtyFiles };
}
