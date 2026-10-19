import { readFileSync, realpathSync, statSync } from "node:fs";
import { dirname, join, resolve } from "node:path";

export const LOCAL_CONTEXT_FILENAME = "AGENTS.local.md";

export interface ContextFile {
  path: string;
  content: string;
}

export interface LocalContextFile extends ContextFile {
  dir: string;
}

export interface DiscoverOptions {
  cwd: string;
  agentDir: string;
}

export function contextFilesDisabled(argv: readonly string[]): boolean {
  return argv.includes("--no-context-files") || argv.includes("-nc");
}

/** Mirrors Pi's native walk: global agent dir, then filesystem root down to cwd. */
export function contextDirectories({
  cwd,
  agentDir,
}: DiscoverOptions): string[] {
  const ancestors: string[] = [];
  let current = resolve(cwd);
  while (true) {
    ancestors.unshift(current);
    const parent = dirname(current);
    if (parent === current) {
      break;
    }
    current = parent;
  }
  return [resolve(agentDir), ...ancestors];
}

function stripBom(content: string): string {
  return content.startsWith("\uFEFF") ? content.slice(1) : content;
}

export function discoverLocalContextFiles(
  options: DiscoverOptions,
): LocalContextFile[] {
  const files: LocalContextFile[] = [];
  const seenRealPaths = new Set<string>();
  for (const dir of contextDirectories(options)) {
    const filePath = join(dir, LOCAL_CONTEXT_FILENAME);
    try {
      if (!statSync(filePath).isFile()) {
        continue;
      }
      const realPath = realpathSync(filePath);
      if (seenRealPaths.has(realPath)) {
        continue;
      }
      const content = stripBom(readFileSync(filePath, "utf8"));
      seenRealPaths.add(realPath);
      files.push({ path: filePath, content, dir });
    } catch (error) {
      // Missing: skip silently. Unreadable: skip with native loading's warning.
      const code = (error as NodeJS.ErrnoException).code;
      if (code !== "ENOENT" && code !== "ENOTDIR") {
        console.error(`Warning: Could not read ${filePath}: ${String(error)}`);
      }
    }
  }
  return files;
}

/**
 * Inserts each local file right after the native entry from its directory, or
 * at its parent-to-child slot when that directory has none. Natives keep their
 * order; paths already present are not added again.
 */
export function mergeLocalContextFiles(
  native: readonly ContextFile[],
  local: readonly LocalContextFile[],
  dirOrder: readonly string[],
): ContextFile[] {
  const merged: ContextFile[] = [...native];
  const rankOf = (dir: string) => dirOrder.indexOf(dir);
  for (const file of local) {
    if (merged.some((entry) => entry.path === file.path)) {
      continue;
    }
    const rank = rankOf(file.dir);
    let insertAt = 0;
    for (const [index, entry] of merged.entries()) {
      const entryRank = rankOf(dirname(entry.path));
      if (entryRank !== -1 && entryRank <= rank) {
        insertAt = index + 1;
      }
    }
    merged.splice(insertAt, 0, { path: file.path, content: file.content });
  }
  return merged;
}
