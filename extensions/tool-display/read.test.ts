import { describe, expect, it } from "bun:test";
import {
  mkdir,
  mkdtemp,
  realpath,
  rm,
  symlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import type { ToolDisplayFullReadTarget } from "./config";
import {
  isToolDisplayReadDetails,
  normalizeSkillFilePaths,
  readFullReadText,
  resolveFullReadPath,
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

function target(
  overrides: Partial<ToolDisplayFullReadTarget>
): ToolDisplayFullReadTarget {
  return {
    name: "target",
    enabled: true,
    source: "patterns",
    maxBytes: TOOL_DISPLAY_READ_MAX_BYTES,
    ignorePagination: true,
    provenance: "project",
    warnings: [],
    ...overrides,
  };
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

  it("matches registered skill paths by realpath", async () => {
    await withTempDir(async (dir) => {
      const skillPath = join(dir, "SKILL.md");
      const otherPath = join(dir, "README.md");
      await writeFile(skillPath, "# Skill\n");
      await writeFile(otherPath, "# Readme\n");

      const skillPaths = await normalizeSkillFilePaths([
        { filePath: skillPath },
      ]);
      const targets = [target({ name: "skills", source: "registeredSkills" })];

      await expect(
        resolveFullReadPath(skillPath, dir, targets, skillPaths)
      ).resolves.toMatchObject({ path: await realpath(skillPath) });
      await expect(
        resolveFullReadPath("README.md", dir, targets, skillPaths)
      ).resolves.toBeNull();
    });
  });

  it("matches rule pattern targets under cwd-relative baseDir", async () => {
    await withTempDir(async (dir) => {
      const ruleDir = join(dir, ".pi", "rules");
      await mkdir(ruleDir, { recursive: true });
      const rulePath = join(ruleDir, "rule.md");
      await writeFile(rulePath, "# Rule\n");

      await expect(
        resolveFullReadPath(
          ".pi/rules/rule.md",
          dir,
          [
            target({
              name: "rules",
              baseDir: ".pi/rules",
              include: ["**/*.md"],
            }),
          ],
          new Set()
        )
      ).resolves.toMatchObject({ path: await realpath(rulePath) });
    });
  });

  it("applies include and exclude against paths relative to real baseDir", async () => {
    await withTempDir(async (dir) => {
      const ruleDir = join(dir, "rules");
      await mkdir(join(ruleDir, "private"), { recursive: true });
      const publicRule = join(ruleDir, "public.md");
      const privateRule = join(ruleDir, "private", "secret.md");
      await writeFile(publicRule, "public\n");
      await writeFile(privateRule, "secret\n");
      const targets = [
        target({
          baseDir: "rules",
          include: ["**/*.md"],
          exclude: ["private/**"],
        }),
      ];

      await expect(
        resolveFullReadPath(publicRule, dir, targets, new Set())
      ).resolves.toMatchObject({ path: await realpath(publicRule) });
      await expect(
        resolveFullReadPath(privateRule, dir, targets, new Set())
      ).resolves.toBeNull();
    });
  });

  it("uses the first enabled matching target", async () => {
    await withTempDir(async (dir) => {
      const filePath = join(dir, "rules", "one.md");
      await mkdir(join(dir, "rules"), { recursive: true });
      await writeFile(filePath, "one\n");

      const match = await resolveFullReadPath(
        filePath,
        dir,
        [
          target({
            name: "first",
            enabled: false,
            baseDir: "rules",
            include: ["**/*.md"],
          }),
          target({
            name: "second",
            maxBytes: 10,
            baseDir: "rules",
            include: ["**/*.md"],
          }),
          target({
            name: "third",
            maxBytes: 20,
            baseDir: "rules",
            include: ["**/*.md"],
          }),
        ],
        new Set()
      );

      expect(match?.target.name).toBe("second");
      expect(match?.target.maxBytes).toBe(10);
    });
  });

  it("enforces target max cap", async () => {
    await withTempDir(async (dir) => {
      const filePath = join(dir, "rule.md");
      await writeFile(filePath, "123456");
      const match = {
        path: filePath,
        target: target({ name: "small", maxBytes: 5 }),
      };

      await expect(readFullReadText(match, {})).rejects.toThrow(
        "exceeds tool-display read cap"
      );
    });
  });

  it("ignores pagination when ignorePagination is true", async () => {
    await withTempDir(async (dir) => {
      const filePath = join(dir, "SKILL.md");
      await writeFile(filePath, "one\ntwo\nthree\n");

      const result = await readFullReadText(
        {
          path: filePath,
          target: target({
            source: "registeredSkills",
            ignorePagination: true,
          }),
        },
        { offset: 2, limit: 1 }
      );

      expect(result.content).toEqual("one\ntwo\nthree\n");
      expect(result.details).toMatchObject({
        toolDisplay: {
          fullRead: true,
          targetName: "target",
          bytes: Buffer.byteLength("one\ntwo\nthree\n", "utf8"),
          ignoredOffset: 2,
          ignoredLimit: 1,
        },
      });
      expect(isToolDisplayReadDetails(result.details)).toBe(true);
    });
  });

  it("applies pagination before target cap when ignorePagination is false", async () => {
    await withTempDir(async (dir) => {
      const filePath = join(dir, "rule.md");
      await writeFile(filePath, "12345\n67890\n");

      const result = await readFullReadText(
        {
          path: filePath,
          target: target({ maxBytes: 6, ignorePagination: false }),
        },
        { offset: 2, limit: 1 }
      );

      expect(result.content).toBe("67890");
      expect(result.details.toolDisplay.ignoredOffset).toBeUndefined();
      expect(result.details.toolDisplay.ignoredLimit).toBeUndefined();
    });
  });

  it("enforces the hard cap before paginating full-read content", async () => {
    await withTempDir(async (dir) => {
      const filePath = join(dir, "rule.md");
      await writeFile(filePath, "x".repeat(TOOL_DISPLAY_READ_MAX_BYTES + 1));

      await expect(
        readFullReadText(
          {
            path: filePath,
            target: target({ ignorePagination: false }),
          },
          { offset: 1, limit: 1 }
        )
      ).rejects.toThrow("exceeds tool-display hard read cap");
    });
  });

  it("rejects project-provenance pattern baseDirs outside the workspace", async () => {
    await withTempDir(async (dir) => {
      const outsideDir = join(dir, "..", `outside-${Date.now()}`);
      await mkdir(outsideDir, { recursive: true });
      try {
        const outsideRule = join(outsideDir, "secret.md");
        await writeFile(outsideRule, "secret\n");

        await expect(
          resolveFullReadPath(
            outsideRule,
            dir,
            [
              target({
                baseDir: outsideDir,
                include: ["**/*.md"],
                provenance: "project",
              }),
            ],
            new Set()
          )
        ).resolves.toBeNull();
      } finally {
        await rm(outsideDir, { recursive: true, force: true });
      }
    });
  });

  it("allows global-provenance pattern baseDirs outside the workspace", async () => {
    await withTempDir(async (dir) => {
      const outsideDir = join(dir, "..", `outside-${Date.now()}`);
      await mkdir(outsideDir, { recursive: true });
      try {
        const outsideRule = join(outsideDir, "global.md");
        await writeFile(outsideRule, "global\n");

        await expect(
          resolveFullReadPath(
            outsideRule,
            dir,
            [
              target({
                baseDir: outsideDir,
                include: ["**/*.md"],
                provenance: "global",
              }),
            ],
            new Set()
          )
        ).resolves.toMatchObject({ path: await realpath(outsideRule) });
      } finally {
        await rm(outsideDir, { recursive: true, force: true });
      }
    });
  });

  it("rejects symlink escapes from pattern baseDir", async () => {
    await withTempDir(async (dir) => {
      const baseDir = join(dir, "rules");
      const outsideDir = join(dir, "outside");
      await mkdir(baseDir, { recursive: true });
      await mkdir(outsideDir, { recursive: true });
      const outsideRule = join(outsideDir, "secret.md");
      const linkPath = join(baseDir, "secret.md");
      await writeFile(outsideRule, "secret\n");
      await symlink(outsideRule, linkPath);

      await expect(
        resolveFullReadPath(
          linkPath,
          dir,
          [target({ baseDir: "rules", include: ["**/*.md"] })],
          new Set()
        )
      ).resolves.toBeNull();
    });
  });

  it("matches source paths through realpath-aware containment", async () => {
    await withTempDir(async (dir) => {
      const realBase = join(dir, "real-rules");
      const linkBase = join(dir, "linked-rules");
      await mkdir(realBase, { recursive: true });
      const rulePath = join(realBase, "rule.md");
      await writeFile(rulePath, "rule\n");
      await symlink(realBase, linkBase);

      await expect(
        resolveFullReadPath(
          join(linkBase, "rule.md"),
          dir,
          [target({ baseDir: "linked-rules", include: ["**/*.md"] })],
          new Set()
        )
      ).resolves.toMatchObject({ path: await realpath(rulePath) });
    });
  });
});
