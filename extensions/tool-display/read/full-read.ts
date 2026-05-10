import { readFile, realpath, stat } from "node:fs/promises";
import { homedir } from "node:os";
import { isAbsolute, relative, resolve } from "node:path";

import type { ReadToolInput } from "@earendil-works/pi-coding-agent";
import ignore from "ignore";

import {
  TOOL_DISPLAY_FULL_READ_MAX_BYTES,
  type ToolDisplayFullReadTarget,
} from "../config";
import {
  createToolDisplayReadDetails,
  type ToolDisplayReadDetails,
} from "./details";

export const TOOL_DISPLAY_READ_MAX_BYTES = TOOL_DISPLAY_FULL_READ_MAX_BYTES;

const PATH_SEPARATOR_PATTERN = /[/\\]+/;

export interface ToolDisplaySkillLike {
  filePath: string;
}

export interface ToolDisplayFullReadMatch {
  path: string;
  target: ToolDisplayFullReadTarget;
}

export async function normalizeSkillFilePaths(
  skills: ToolDisplaySkillLike[]
): Promise<Set<string>> {
  const normalized = new Set<string>();

  for (const skill of skills) {
    try {
      normalized.add(await realpath(skill.filePath));
    } catch {
      // Ignore missing/unreadable skills. Pi owns skill loading diagnostics.
    }
  }

  return normalized;
}

function expandBaseDir(baseDir: string, cwd: string): string {
  if (baseDir === "~") {
    return homedir();
  }
  if (baseDir.startsWith("~/")) {
    return resolve(homedir(), baseDir.slice(2));
  }
  return isAbsolute(baseDir) ? baseDir : resolve(cwd, baseDir);
}

function toPosixPath(path: string): string {
  return path.split(PATH_SEPARATOR_PATTERN).join("/");
}

function isContained(relativePath: string): boolean {
  return (
    relativePath !== "" &&
    !relativePath.startsWith("..") &&
    !isAbsolute(relativePath)
  );
}

function isContainedOrEqual(relativePath: string): boolean {
  return relativePath === "" || isContained(relativePath);
}

function matchesPatterns(
  relativePath: string,
  include: string[] = [],
  exclude: string[] = []
): boolean {
  const normalizedPath = toPosixPath(relativePath);
  const includeMatcher = ignore().add(include);
  const excludeMatcher = ignore().add(exclude);
  return (
    includeMatcher.ignores(normalizedPath) &&
    !excludeMatcher.ignores(normalizedPath)
  );
}

async function matchesPatternTarget(
  canonicalPath: string,
  cwd: string,
  target: ToolDisplayFullReadTarget
): Promise<boolean> {
  if (!(target.baseDir && target.include?.length)) {
    return false;
  }

  const realBaseDir = await realpath(expandBaseDir(target.baseDir, cwd));
  if (target.provenance === "project") {
    const realCwd = await realpath(cwd);
    if (!isContainedOrEqual(relative(realCwd, realBaseDir))) {
      return false;
    }
  }

  const relativePath = relative(realBaseDir, canonicalPath);
  if (!isContained(relativePath)) {
    return false;
  }

  return matchesPatterns(relativePath, target.include, target.exclude);
}

export async function resolveFullReadPath(
  requestedPath: string,
  cwd: string,
  targets: ToolDisplayFullReadTarget[],
  skillFilePaths: Set<string>
): Promise<ToolDisplayFullReadMatch | null> {
  let canonicalPath: string;
  try {
    canonicalPath = await realpath(resolve(cwd, requestedPath));
  } catch {
    return null;
  }

  for (const target of targets) {
    if (!target.enabled) {
      continue;
    }

    if (target.source === "registeredSkills") {
      if (skillFilePaths.has(canonicalPath)) {
        return { path: canonicalPath, target };
      }
      continue;
    }

    try {
      if (await matchesPatternTarget(canonicalPath, cwd, target)) {
        return { path: canonicalPath, target };
      }
    } catch {
      // Ignore unreadable/missing base directories and keep checking targets.
    }
  }

  return null;
}

function applyPagination(
  content: string,
  params: Pick<ReadToolInput, "offset" | "limit">
): string {
  const lines = content.split("\n");
  const start =
    params.offset === undefined ? 0 : Math.max(params.offset - 1, 0);
  const end = params.limit === undefined ? undefined : start + params.limit;
  return lines.slice(start, end).join("\n");
}

export async function readFullReadText(
  match: ToolDisplayFullReadMatch,
  params: Pick<ReadToolInput, "offset" | "limit">
): Promise<{ content: string; details: ToolDisplayReadDetails }> {
  const { path, target } = match;
  const fileStat = await stat(path);
  if (fileStat.size > TOOL_DISPLAY_FULL_READ_MAX_BYTES) {
    throw new Error(
      `File exceeds tool-display hard read cap: ${fileStat.size} bytes > ${TOOL_DISPLAY_FULL_READ_MAX_BYTES} bytes`
    );
  }
  if (target.ignorePagination && fileStat.size > target.maxBytes) {
    throw new Error(
      `File exceeds tool-display read cap: ${fileStat.size} bytes > ${target.maxBytes} bytes`
    );
  }

  const fullContent = await readFile(path, "utf8");
  const content = target.ignorePagination
    ? fullContent
    : applyPagination(fullContent, params);
  const bytes = Buffer.byteLength(content, "utf8");
  if (bytes > target.maxBytes) {
    throw new Error(
      `File exceeds tool-display read cap: ${bytes} bytes > ${target.maxBytes} bytes`
    );
  }

  const details = createToolDisplayReadDetails(
    path,
    target.name,
    bytes,
    target.ignorePagination ? params : {}
  );

  return { content, details };
}
