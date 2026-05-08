import { readFile, realpath, stat } from "node:fs/promises";
import { resolve } from "node:path";

import type {
  ReadToolDetails,
  ReadToolInput,
} from "@earendil-works/pi-coding-agent";

export const TOOL_DISPLAY_READ_MAX_BYTES = 256 * 1024;

export interface ToolDisplaySkillLike {
  filePath: string;
}

export interface ToolDisplayReadDetails extends ReadToolDetails {
  toolDisplay: {
    fullSkillRead: true;
    path: string;
    bytes: number;
    ignoredOffset?: number;
    ignoredLimit?: number;
  };
}

export function isToolDisplayReadDetails(
  details: unknown
): details is ToolDisplayReadDetails {
  if (!(details && typeof details === "object")) {
    return false;
  }

  const value = details as { toolDisplay?: { fullSkillRead?: unknown } };
  return value.toolDisplay?.fullSkillRead === true;
}

export function createToolDisplayReadDetails(
  path: string,
  bytes: number,
  params: Pick<ReadToolInput, "offset" | "limit">
): ToolDisplayReadDetails {
  const toolDisplay: ToolDisplayReadDetails["toolDisplay"] = {
    fullSkillRead: true,
    path,
    bytes,
  };

  if (params.offset !== undefined) {
    toolDisplay.ignoredOffset = params.offset;
  }

  if (params.limit !== undefined) {
    toolDisplay.ignoredLimit = params.limit;
  }

  return { toolDisplay };
}

export function getToolDisplayReadErrorMessage(error: unknown): string {
  if (error instanceof Error) {
    return error.message;
  }

  return "Failed to read full skill file";
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

export async function resolveFullSkillReadPath(
  requestedPath: string,
  cwd: string,
  skillFilePaths: Set<string>
): Promise<string | null> {
  try {
    const absolutePath = resolve(cwd, requestedPath);
    const canonicalPath = await realpath(absolutePath);
    return skillFilePaths.has(canonicalPath) ? canonicalPath : null;
  } catch {
    return null;
  }
}

export async function readFullSkillText(
  canonicalPath: string,
  params: Pick<ReadToolInput, "offset" | "limit">
): Promise<{ content: string; details: ToolDisplayReadDetails }> {
  const fileStat = await stat(canonicalPath);
  if (fileStat.size > TOOL_DISPLAY_READ_MAX_BYTES) {
    throw new Error(
      `Skill file exceeds tool-display read cap: ${fileStat.size} bytes > ${TOOL_DISPLAY_READ_MAX_BYTES} bytes`
    );
  }

  const content = await readFile(canonicalPath, "utf8");
  const details = createToolDisplayReadDetails(
    canonicalPath,
    Buffer.byteLength(content, "utf8"),
    params
  );

  return { content, details };
}
