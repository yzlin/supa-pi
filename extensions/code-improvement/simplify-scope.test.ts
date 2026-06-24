import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { classifySimplifyScopePaths } from "./simplify-scope";

const originalCwd = process.cwd();
let tempDir: string | undefined;

beforeEach(() => {
  tempDir = mkdtempSync(join(tmpdir(), "simplify-scope-"));
  process.chdir(tempDir);
  spawnSync("git", ["init"], { stdio: "ignore" });
  writeFileSync(".gitignore", "ignored.txt\n");
});

afterEach(() => {
  process.chdir(originalCwd);
  tempDir = undefined;
});

describe("classifySimplifyScopePaths git ignore handling", () => {
  it("does not exclude git-ignored files for non-folder scopes", () => {
    writeFileSync("ignored.txt", "tracked ignored diff file");

    const result = classifySimplifyScopePaths(["ignored.txt"]);

    expect(result.editableFiles).toEqual(["ignored.txt"]);
    expect(result.unsupportedChangedFiles).toEqual([]);
    expect(result.gitIgnoreUnavailable).toBe(false);
  });

  it("reports explicit ignored folder-scope file targets as unsupported", () => {
    writeFileSync("ignored.txt", "explicit ignored folder file");

    const result = classifySimplifyScopePaths(["ignored.txt"], {
      expandDirectories: true,
    });

    expect(result.editableFiles).toEqual([]);
    expect(result.unsupportedChangedFiles).toEqual(["ignored.txt"]);
  });

  it("reports explicit ignored folder-scope directory targets as unsupported", () => {
    mkdirSync("ignored-dir");
    writeFileSync(".gitignore", "ignored-dir/\n");

    const result = classifySimplifyScopePaths(["ignored-dir"], {
      expandDirectories: true,
    });

    expect(result.editableFiles).toEqual([]);
    expect(result.unsupportedChangedFiles).toEqual(["ignored-dir"]);
  });

  it("keeps safe TypeScript files under src build folders editable", () => {
    mkdirSync("src/feature/build", { recursive: true });
    mkdirSync("src/feature/build/nested", { recursive: true });
    writeFileSync("src/feature/build/good.ts", "export const good = true;\n");
    writeFileSync(
      "src/feature/build/nested/good.tsx",
      "export function Good() { return null; }\n"
    );

    const result = classifySimplifyScopePaths(["src"], {
      expandDirectories: true,
    });

    expect(result.editableFiles).toContain("src/feature/build/good.ts");
    expect(result.editableFiles).toContain(
      "src/feature/build/nested/good.tsx"
    );
    expect(result.unsupportedChangedFiles).toEqual([]);
  });

  it("silently skips recursive ignored folder-scope descendants", () => {
    mkdirSync("src");
    writeFileSync("src/good.ts", "export const good = true;\n");
    writeFileSync("src/ignored.txt", "recursive ignored folder file");
    writeFileSync(".gitignore", "src/ignored.txt\n");

    const result = classifySimplifyScopePaths(["src"], {
      expandDirectories: true,
    });

    expect(result.editableFiles).toEqual(["src/good.ts"]);
    expect(result.unsupportedChangedFiles).toEqual([]);
  });

  it("does not keep git-ignore-unavailable state across calls", () => {
    const nonRepoDir = mkdtempSync(join(tmpdir(), "simplify-scope-nonrepo-"));
    writeFileSync(join(nonRepoDir, "ignored.txt"), "non-repo file");
    process.chdir(nonRepoDir);

    const unavailableResult = classifySimplifyScopePaths(["ignored.txt"], {
      expandDirectories: true,
    });
    expect(unavailableResult.gitIgnoreUnavailable).toBe(true);

    if (!tempDir) {
      throw new Error("missing tempDir");
    }
    process.chdir(tempDir);
    writeFileSync("ignored.txt", "explicit ignored folder file");

    const result = classifySimplifyScopePaths(["ignored.txt"], {
      expandDirectories: true,
    });

    expect(result.gitIgnoreUnavailable).toBe(false);
    expect(result.unsupportedChangedFiles).toEqual(["ignored.txt"]);
  });
});
