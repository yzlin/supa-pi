import { readFile, realpath, stat } from "node:fs/promises";
import { resolve } from "node:path";

import {
  createReadTool,
  type ExtensionAPI,
  type ReadToolDetails,
  type ReadToolInput,
} from "@earendil-works/pi-coding-agent";
import { Text } from "@earendil-works/pi-tui";

export const READ_PATCH_MAX_BYTES = 256 * 1024;

export interface ReadPatchSkillLike {
  filePath: string;
}

export interface ReadPatchDetails extends ReadToolDetails {
  readPatch: {
    fullSkillRead: true;
    path: string;
    bytes: number;
    ignoredOffset?: number;
    ignoredLimit?: number;
  };
}

export function isReadPatchDetails(
  details: unknown
): details is ReadPatchDetails {
  if (!(details && typeof details === "object")) {
    return false;
  }

  const value = details as { readPatch?: { fullSkillRead?: unknown } };
  return value.readPatch?.fullSkillRead === true;
}

function createReadPatchDetails(
  path: string,
  bytes: number,
  params: Pick<ReadToolInput, "offset" | "limit">
): ReadPatchDetails {
  const readPatch: ReadPatchDetails["readPatch"] = {
    fullSkillRead: true,
    path,
    bytes,
  };

  if (params.offset !== undefined) {
    readPatch.ignoredOffset = params.offset;
  }

  if (params.limit !== undefined) {
    readPatch.ignoredLimit = params.limit;
  }

  return { readPatch };
}

function getReadPatchErrorMessage(error: unknown): string {
  if (error instanceof Error) {
    return error.message;
  }

  return "Failed to read full skill file";
}

export async function normalizeSkillFilePaths(
  skills: ReadPatchSkillLike[]
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

export async function resolvePatchedSkillPath(
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
): Promise<{ content: string; details: ReadPatchDetails }> {
  const fileStat = await stat(canonicalPath);
  if (fileStat.size > READ_PATCH_MAX_BYTES) {
    throw new Error(
      `Skill file exceeds read-patch cap: ${fileStat.size} bytes > ${READ_PATCH_MAX_BYTES} bytes`
    );
  }

  const content = await readFile(canonicalPath, "utf8");
  const details = createReadPatchDetails(
    canonicalPath,
    Buffer.byteLength(content, "utf8"),
    params
  );

  return { content, details };
}

export default function readPatchExtension(pi: ExtensionAPI): void {
  let cwd = process.cwd();
  let readTool = createReadTool(cwd);
  let skillFilePaths = new Set<string>();

  pi.on("session_start", (_event, ctx) => {
    cwd = ctx.cwd;
    readTool = createReadTool(cwd);
  });

  pi.on("before_agent_start", async (event) => {
    skillFilePaths = await normalizeSkillFilePaths(
      event.systemPromptOptions.skills
    );
  });

  pi.registerTool({
    ...readTool,
    async execute(toolCallId, params, signal, onUpdate, ctx) {
      const patchedPath = await resolvePatchedSkillPath(
        params.path,
        cwd,
        skillFilePaths
      );

      if (!patchedPath) {
        return readTool.execute(toolCallId, params, signal, onUpdate, ctx);
      }

      try {
        const result = await readFullSkillText(patchedPath, params);
        return {
          content: [{ type: "text", text: result.content }],
          details: result.details,
        };
      } catch (error) {
        return {
          content: [
            {
              type: "text",
              text: getReadPatchErrorMessage(error),
            },
          ],
          isError: true,
          details: createReadPatchDetails(patchedPath, 0, params),
        };
      }
    },

    renderCall(args, theme, context) {
      if (readTool.renderCall) {
        return readTool.renderCall(args, theme, context);
      }

      return new Text(theme.fg("toolTitle", `read ${args.path}`), 0, 0);
    },

    renderResult(result, renderContext, theme, context) {
      if (isReadPatchDetails(result.details)) {
        const details = result.details.readPatch;
        const ignored: string[] = [];

        if (details.ignoredOffset !== undefined) {
          ignored.push(`offset=${details.ignoredOffset}`);
        }

        if (details.ignoredLimit !== undefined) {
          ignored.push(`limit=${details.ignoredLimit}`);
        }

        const suffix = ignored.length ? `; ignored ${ignored.join(", ")}` : "";
        const status = result.isError ? "error" : "success";
        return new Text(
          theme.fg(status, `skill read full (${details.bytes} bytes${suffix})`),
          0,
          0
        );
      }

      if (readTool.renderResult) {
        return readTool.renderResult(result, renderContext, theme, context);
      }

      return new Text(theme.fg("success", "read"), 0, 0);
    },
  });
}
