import { existsSync, readFileSync, realpathSync, statSync } from "node:fs";
import { dirname, join, resolve } from "node:path";

import type {
  ExtensionAPI,
  ExtensionContext,
} from "@earendil-works/pi-coding-agent";

import type { ValidatedVault } from "./config";
import { assertContained } from "./vault";

export const OBSIDIAN_CONTEXT_ENTRY = "obsidian.loadedContextPaths";
const FILE_LIMIT = 64 * 1024;
const TOTAL_LIMIT = 256 * 1024;
const CLAUDE_NAMES = ["CLAUDE.md", "CLAUDE.MD"];

export interface LoadedContextState {
  paths: Set<string>;
}

export function stateFromSession(ctx: ExtensionContext): LoadedContextState {
  const paths = new Set<string>();
  for (const entry of ctx.sessionManager.getEntries() as Array<{
    customType?: string;
    data?: unknown;
  }>) {
    if (entry.customType !== OBSIDIAN_CONTEXT_ENTRY) {
      continue;
    }
    const data = entry.data as { paths?: unknown } | undefined;
    if (Array.isArray(data?.paths)) {
      for (const item of data.paths) {
        if (typeof item === "string") {
          paths.add(item);
        }
      }
    }
  }
  return { paths };
}

function findClaudeFile(directory: string): string | null {
  for (const name of CLAUDE_NAMES) {
    const candidate = join(directory, name);
    if (existsSync(candidate) && statSync(candidate).isFile()) {
      return realpathSync(candidate);
    }
  }
  return null;
}

function nearestExistingDirectory(targetPath: string): string {
  let current =
    existsSync(targetPath) && statSync(targetPath).isDirectory()
      ? targetPath
      : dirname(targetPath);

  while (!existsSync(current)) {
    const parent = dirname(current);
    if (parent === current) {
      return current;
    }
    current = parent;
  }

  return current;
}

export function discoverClaudeChain(
  vault: ValidatedVault,
  targetPath: string
): string[] {
  if (!assertContained(vault, targetPath)) {
    return [];
  }

  const dirs: string[] = [];
  let current = resolve(nearestExistingDirectory(targetPath));
  while (true) {
    dirs.push(current);
    if (realpathSync(current) === vault.realPath) {
      break;
    }
    const parent = dirname(current);
    if (parent === current) {
      break;
    }
    current = parent;
  }
  return dirs
    .reverse()
    .map(findClaudeFile)
    .filter((item): item is string => item !== null);
}

export function loadContextFiles(paths: string[]): string {
  let total = 0;
  const blocks: string[] = [];
  const uniquePaths = new Set(paths);
  for (const filePath of uniquePaths) {
    const size = statSync(filePath).size;
    if (size > FILE_LIMIT) {
      throw new Error(`Obsidian context file exceeds 64KB: ${filePath}`);
    }
    total += size;
    if (total > TOTAL_LIMIT) {
      throw new Error("Obsidian context chain exceeds 256KB total");
    }
    blocks.push(`## ${filePath}\n\n${readFileSync(filePath, "utf8")}`);
  }
  return blocks.join("\n\n");
}

export function persistLoadedPaths(
  pi: ExtensionAPI,
  state: LoadedContextState
): void {
  pi.appendEntry(OBSIDIAN_CONTEXT_ENTRY, { paths: [...state.paths].sort() });
}
