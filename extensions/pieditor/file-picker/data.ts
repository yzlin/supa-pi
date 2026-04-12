import { execSync } from "node:child_process";
import * as fs from "node:fs";
import * as path from "node:path";

import { globToRegex } from "./filter.js";
import type { FileEntry } from "./types.js";

export function getCwdRoot(): string {
  return process.cwd();
}

export function isWithinCwd(targetPath: string, cwdRoot: string): boolean {
  const resolved = path.resolve(targetPath);
  const normalizedCwd = path.resolve(cwdRoot);
  return (
    resolved === normalizedCwd ||
    resolved.startsWith(`${normalizedCwd}${path.sep}`)
  );
}

function shouldSkipPattern(name: string, skipPatterns: string[]): boolean {
  return skipPatterns.some((pattern) => {
    if (pattern.includes("*")) {
      const regex = globToRegex(pattern);
      return regex.test(name);
    }
    return name === pattern;
  });
}

export function listDirectoryWithGit(
  dirPath: string,
  cwdRoot: string,
  gitFiles: Set<string> | null,
  skipHidden: boolean,
  skipPatterns: string[]
): FileEntry[] {
  const entries: FileEntry[] = [];

  try {
    const items = fs.readdirSync(dirPath, { withFileTypes: true });
    const relDir = path.relative(cwdRoot, dirPath);

    for (const item of items) {
      if (skipHidden && item.name.startsWith(".")) continue;
      if (shouldSkipPattern(item.name, skipPatterns)) continue;

      const fullPath = path.join(dirPath, item.name);
      const relativePath = relDir ? path.join(relDir, item.name) : item.name;

      let isDirectory = item.isDirectory();
      if (item.isSymbolicLink()) {
        try {
          const stats = fs.statSync(fullPath);
          isDirectory = stats.isDirectory();
        } catch {
          continue;
        }
      }

      if (gitFiles !== null) {
        if (isDirectory) {
          let hasGitFiles = false;
          const prefix = `${relativePath}/`;
          for (const gitFile of gitFiles) {
            if (gitFile.startsWith(prefix) || gitFile === relativePath) {
              hasGitFiles = true;
              break;
            }
          }
          if (!hasGitFiles) continue;
        } else if (!gitFiles.has(relativePath)) {
          continue;
        }
      }

      entries.push({
        name: item.name,
        isDirectory,
        relativePath,
      });
    }

    entries.sort((a, b) => {
      if (a.isDirectory && !b.isDirectory) return -1;
      if (!a.isDirectory && b.isDirectory) return 1;
      return a.name.localeCompare(b.name);
    });
  } catch {
    // Return empty on error
  }

  return entries;
}

export function listAllFiles(
  dirPath: string,
  cwdRoot: string,
  results: FileEntry[],
  skipHidden: boolean,
  skipPatterns: string[]
): FileEntry[] {
  try {
    const items = fs.readdirSync(dirPath, { withFileTypes: true });

    for (const item of items) {
      if (skipHidden && item.name.startsWith(".")) continue;
      if (shouldSkipPattern(item.name, skipPatterns)) continue;

      const fullPath = path.join(dirPath, item.name);
      const relativePath = path.relative(cwdRoot, fullPath);

      let isDirectory = item.isDirectory();
      if (item.isSymbolicLink()) {
        try {
          const stats = fs.statSync(fullPath);
          isDirectory = stats.isDirectory();
        } catch {
          continue;
        }
      }

      results.push({
        name: item.name,
        isDirectory,
        relativePath,
      });

      if (isDirectory) {
        listAllFiles(fullPath, cwdRoot, results, skipHidden, skipPatterns);
      }
    }
  } catch {
    // Skip inaccessible directories
  }

  return results;
}

export function isGitRepo(cwdRoot: string): boolean {
  try {
    execSync("git rev-parse --is-inside-work-tree", {
      cwd: cwdRoot,
      encoding: "utf-8",
      stdio: "pipe",
    });
    return true;
  } catch {
    return false;
  }
}

export function listGitFiles(cwdRoot: string): FileEntry[] {
  const entries: FileEntry[] = [];

  try {
    const output = execSync(
      "git ls-files --cached --others --exclude-standard",
      {
        cwd: cwdRoot,
        encoding: "utf-8",
        stdio: "pipe",
        maxBuffer: 10 * 1024 * 1024,
      }
    );

    const files = output.trim().split("\n").filter(Boolean);

    for (const relativePath of files) {
      const fullPath = path.join(cwdRoot, relativePath);
      const name = path.basename(relativePath);

      let isDirectory = false;
      try {
        const stats = fs.statSync(fullPath);
        isDirectory = stats.isDirectory();
      } catch {
        continue;
      }

      entries.push({
        name,
        isDirectory,
        relativePath,
      });
    }

    const dirs = new Set<string>();
    for (const entry of entries) {
      let dir = path.dirname(entry.relativePath);
      while (dir && dir !== ".") {
        dirs.add(dir);
        dir = path.dirname(dir);
      }
    }

    for (const dir of dirs) {
      entries.push({
        name: path.basename(dir),
        isDirectory: true,
        relativePath: dir,
      });
    }
  } catch {
    // Fall back to empty
  }

  return entries;
}
