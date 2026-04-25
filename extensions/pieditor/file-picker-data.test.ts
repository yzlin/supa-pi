import { afterEach, describe, expect, it } from "bun:test";
import { execFileSync } from "node:child_process";
import {
  mkdirSync,
  mkdtempSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { listAllFiles, listGitFiles } from "./file-picker/data";

const tempDirs: string[] = [];

function createTempDir(): string {
  const dir = mkdtempSync(join(tmpdir(), "pi-file-picker-data-"));
  tempDirs.push(dir);
  return dir;
}

function relativePaths(entries: { relativePath: string }[]): string[] {
  return entries.map((entry) => entry.relativePath);
}

afterEach(() => {
  for (const dir of tempDirs.splice(0)) {
    rmSync(dir, { recursive: true, force: true });
  }
});

describe("file picker data listing", () => {
  it("recursively includes files inside symlinked directories", () => {
    const root = createTempDir();
    mkdirSync(join(root, "target", "nested"), { recursive: true });
    writeFileSync(join(root, "target", "nested", "alpha.txt"), "alpha");
    symlinkSync(join(root, "target"), join(root, "linked"), "dir");

    const paths = relativePaths(listAllFiles(root, root, [], true, []));

    expect(paths).toContain("target/nested/alpha.txt");
    expect(paths).toContain("linked/nested/alpha.txt");
  });

  it("does not recurse forever through symlink cycles", () => {
    const root = createTempDir();
    mkdirSync(join(root, "src"), { recursive: true });
    writeFileSync(join(root, "src", "alpha.txt"), "alpha");
    symlinkSync(root, join(root, "src", "loop"), "dir");

    const paths = relativePaths(listAllFiles(root, root, [], true, []));

    expect(paths).toContain("src/alpha.txt");
    expect(paths).toContain("src/loop");
    expect(paths).not.toContain("src/loop/src/loop/src/loop");
  });

  it("adds symlinked directory contents to git-backed search results", () => {
    const root = createTempDir();
    const repo = join(root, "repo");
    const target = join(root, "external-target");
    mkdirSync(join(target, "nested"), { recursive: true });
    writeFileSync(join(target, "nested", "alpha.txt"), "alpha");
    mkdirSync(repo, { recursive: true });
    execFileSync("git", ["init", "-q"], { cwd: repo });
    symlinkSync(target, join(repo, "linked"), "dir");

    const paths = relativePaths(listGitFiles(repo, true, []));

    expect(paths).toContain("linked");
    expect(paths).toContain("linked/nested/alpha.txt");
  });

  it("honors gitignore rules for symlinked directory contents in git-backed search", () => {
    const root = createTempDir();
    const repo = join(root, "repo");
    const target = join(root, "external-target");
    mkdirSync(target, { recursive: true });
    writeFileSync(join(target, "private.secret"), "private");
    writeFileSync(join(target, "public.txt"), "public");
    mkdirSync(repo, { recursive: true });
    execFileSync("git", ["init", "-q"], { cwd: repo });
    writeFileSync(join(repo, ".gitignore"), "*.secret\n");
    symlinkSync(target, join(repo, "linked"), "dir");

    const paths = relativePaths(listGitFiles(repo, true, []));

    expect(paths).toContain("linked/public.txt");
    expect(paths).not.toContain("linked/private.secret");
  });

  it("does not traverse symlink roots skipped by hidden and skip-pattern options in git-backed search", () => {
    const root = createTempDir();
    const repo = join(root, "repo");
    const target = join(root, "external-target");
    mkdirSync(target, { recursive: true });
    writeFileSync(join(target, "alpha.txt"), "alpha");
    mkdirSync(repo, { recursive: true });
    execFileSync("git", ["init", "-q"], { cwd: repo });
    symlinkSync(target, join(repo, ".cache"), "dir");
    symlinkSync(target, join(repo, "vendor"), "dir");

    const paths = relativePaths(listGitFiles(repo, true, ["vendor"]));

    expect(paths).not.toContain(".cache");
    expect(paths).not.toContain(".cache/alpha.txt");
    expect(paths).not.toContain("vendor");
    expect(paths).not.toContain("vendor/alpha.txt");
  });
});
