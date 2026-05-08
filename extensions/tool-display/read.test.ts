import { describe, expect, it } from "bun:test";
import { mkdtemp, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  isToolDisplayReadDetails,
  normalizeSkillFilePaths,
  readFullSkillText,
  resolveFullSkillReadPath,
  TOOL_DISPLAY_READ_MAX_BYTES,
} from "./read";

async function withTempDir<T>(fn: (dir: string) => Promise<T>): Promise<T> {
  const dir = await mkdtemp(join(tmpdir(), "tool-display-read-"));
  try {
    return await fn(dir);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

describe("tool-display read", () => {
  it("normalizes loaded skill file paths using realpath", async () => {
    await withTempDir(async (dir) => {
      const skillPath = join(dir, "SKILL.md");
      await writeFile(skillPath, "# Skill\n");

      const normalized = await normalizeSkillFilePaths([
        { filePath: skillPath },
        { filePath: join(dir, "missing.md") },
      ]);

      expect(normalized).toEqual(new Set([await realpath(skillPath)]));
    });
  });

  it("matches exact real skill file paths only", async () => {
    await withTempDir(async (dir) => {
      const skillPath = join(dir, "SKILL.md");
      const otherPath = join(dir, "README.md");
      await writeFile(skillPath, "# Skill\n");
      await writeFile(otherPath, "# Readme\n");

      const skillPaths = await normalizeSkillFilePaths([
        { filePath: skillPath },
      ]);

      await expect(
        resolveFullSkillReadPath(skillPath, dir, skillPaths)
      ).resolves.toBe(await realpath(skillPath));
      await expect(
        resolveFullSkillReadPath("README.md", dir, skillPaths)
      ).resolves.toBeNull();
    });
  });

  it("reads a full skill file while ignoring requested pagination", async () => {
    await withTempDir(async (dir) => {
      const skillPath = join(dir, "SKILL.md");
      await writeFile(skillPath, "one\ntwo\nthree\n");

      const result = await readFullSkillText(skillPath, {
        offset: 2,
        limit: 1,
      });

      expect(result.content).toEqual("one\ntwo\nthree\n");
      expect(result.details).toMatchObject({
        toolDisplay: {
          fullSkillRead: true,
          ignoredOffset: 2,
          ignoredLimit: 1,
        },
      });
      expect(result.details).not.toHaveProperty("readPatch");
      expect(isToolDisplayReadDetails(result.details)).toBe(true);
    });
  });

  it("fails instead of truncating when a skill exceeds the cap", async () => {
    await withTempDir(async (dir) => {
      const skillPath = join(dir, "SKILL.md");
      await writeFile(skillPath, "x".repeat(TOOL_DISPLAY_READ_MAX_BYTES + 1));

      await expect(readFullSkillText(skillPath, {})).rejects.toThrow(
        "exceeds tool-display read cap"
      );
    });
  });
});
