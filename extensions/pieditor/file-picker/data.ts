import { execSync } from "node:child_process";
import * as fs from "node:fs";
import * as path from "node:path";

import ignore from "ignore";

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

function toGitPath(value: string): string {
  return value.split(path.sep).join("/");
}

function shouldSkipRelativePath(
  relativePath: string,
  skipHidden: boolean,
  skipPatterns: string[]
): boolean {
  const segments = toGitPath(relativePath).split("/").filter(Boolean);
  return segments.some(
    (segment) =>
      (skipHidden && segment.startsWith(".")) ||
      shouldSkipPattern(segment, skipPatterns)
  );
}

function loadIgnoreFile(filePath: string): string[] {
  if (!fs.existsSync(filePath)) return [];
  return fs.readFileSync(filePath, "utf-8").split(/\r?\n/);
}

function resolveDirentDirectoryStatus(
  fullPath: string,
  item: fs.Dirent
): boolean | null {
  if (!item.isSymbolicLink()) {
    return item.isDirectory();
  }

  try {
    return fs.statSync(fullPath).isDirectory();
  } catch {
    return null;
  }
}

function createGitIgnoreFilter(
  cwdRoot: string
): (relativePath: string) => boolean {
  const matcher = ignore();
  matcher.add(loadIgnoreFile(path.join(cwdRoot, ".gitignore")));
  matcher.add(loadIgnoreFile(path.join(cwdRoot, ".git", "info", "exclude")));
  return (relativePath: string) => !matcher.ignores(toGitPath(relativePath));
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

      const isDirectory = resolveDirentDirectoryStatus(fullPath, item);
      if (isDirectory === null) {
        continue;
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
  skipPatterns: string[],
  ancestorRealPaths: Set<string> = new Set()
): FileEntry[] {
  let realDirPath: string;
  try {
    realDirPath = fs.realpathSync(dirPath);
  } catch {
    return results;
  }

  if (ancestorRealPaths.has(realDirPath)) return results;

  const nextAncestorRealPaths = new Set(ancestorRealPaths);
  nextAncestorRealPaths.add(realDirPath);

  try {
    const items = fs.readdirSync(dirPath, { withFileTypes: true });

    for (const item of items) {
      if (skipHidden && item.name.startsWith(".")) continue;
      if (shouldSkipPattern(item.name, skipPatterns)) continue;

      const fullPath = path.join(dirPath, item.name);
      const relativePath = path.relative(cwdRoot, fullPath);

      const isDirectory = resolveDirentDirectoryStatus(fullPath, item);
      if (isDirectory === null) {
        continue;
      }

      results.push({
        name: item.name,
        isDirectory,
        relativePath,
      });

      if (isDirectory) {
        listAllFiles(
          fullPath,
          cwdRoot,
          results,
          skipHidden,
          skipPatterns,
          nextAncestorRealPaths
        );
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

function isSymbolicDirectory(fullPath: string): boolean {
  try {
    return (
      fs.lstatSync(fullPath).isSymbolicLink() &&
      fs.statSync(fullPath).isDirectory()
    );
  } catch {
    return false;
  }
}

export function listGitFiles(
  cwdRoot: string,
  skipHidden = false,
  skipPatterns: string[] = []
): FileEntry[] {
  const entriesByPath = new Map<string, FileEntry>();

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
    const shouldIncludeGitPath = createGitIgnoreFilter(cwdRoot);
    const symlinkDirectories: string[] = [];

    for (const relativePath of files) {
      if (shouldSkipRelativePath(relativePath, skipHidden, skipPatterns)) {
        continue;
      }

      const fullPath = path.join(cwdRoot, relativePath);
      const name = path.basename(relativePath);

      let isDirectory = false;
      try {
        const stats = fs.statSync(fullPath);
        isDirectory = stats.isDirectory();
      } catch {
        continue;
      }

      entriesByPath.set(relativePath, {
        name,
        isDirectory,
        relativePath,
      });

      if (isDirectory && isSymbolicDirectory(fullPath)) {
        symlinkDirectories.push(fullPath);
      }
    }

    for (const symlinkDirectory of symlinkDirectories) {
      const linkedEntries = listAllFiles(
        symlinkDirectory,
        cwdRoot,
        [],
        skipHidden,
        skipPatterns
      );
      for (const entry of linkedEntries) {
        if (
          shouldSkipRelativePath(
            entry.relativePath,
            skipHidden,
            skipPatterns
          ) ||
          !shouldIncludeGitPath(entry.relativePath)
        ) {
          continue;
        }
        entriesByPath.set(entry.relativePath, entry);
      }
    }

    const dirs = new Set<string>();
    for (const entry of entriesByPath.values()) {
      let dir = path.dirname(entry.relativePath);
      while (dir && dir !== ".") {
        dirs.add(dir);
        dir = path.dirname(dir);
      }
    }

    for (const dir of dirs) {
      if (entriesByPath.has(dir)) continue;
      entriesByPath.set(dir, {
        name: path.basename(dir),
        isDirectory: true,
        relativePath: dir,
      });
    }
  } catch {
    // Fall back to empty
  }

  return Array.from(entriesByPath.values());
}
