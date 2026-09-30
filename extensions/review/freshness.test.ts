import { spawn } from "bun";
import { afterEach, describe, expect, it } from "bun:test";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";

import {
  captureReviewTargetFreshness,
  ReviewFreshnessError,
  type ReviewFreshnessErrorReason,
} from "./freshness";

const temporaryDirectories: string[] = [];

async function runGit(cwd: string, ...args: string[]): Promise<string> {
  const process = spawn(["git", ...args], {
    cwd,
    stderr: "pipe",
    stdout: "pipe",
  });
  const [stdout, stderr, exitCode] = await Promise.all([
    new Response(process.stdout).text(),
    new Response(process.stderr).text(),
    process.exited,
  ]);
  if (exitCode !== 0) {
    throw new Error(`git ${args.join(" ")} failed: ${stderr}`);
  }
  return stdout;
}

async function makeRepository(): Promise<string> {
  const cwd = await fs.mkdtemp(path.join(os.tmpdir(), "review-freshness-"));
  temporaryDirectories.push(cwd);
  await runGit(cwd, "init", "--quiet");
  await runGit(cwd, "config", "user.email", "review-freshness@example.test");
  await runGit(cwd, "config", "user.name", "Review Freshness");
  return cwd;
}

async function commitAll(cwd: string, message: string): Promise<void> {
  await runGit(cwd, "add", "--all");
  await runGit(cwd, "commit", "--quiet", "-m", message);
}

async function expectFreshnessError(
  promise: Promise<unknown>,
  reason: ReviewFreshnessErrorReason,
) {
  // Bun's rejects.toSatisfy does not unwrap promises in all supported versions.
  const error = await promise.then(
    () => null,
    (failure: unknown) => failure,
  );
  expect(error).toBeInstanceOf(ReviewFreshnessError);
  expect(error instanceof ReviewFreshnessError && error.reason).toBe(reason);
  expect(error instanceof Error && error.message.includes(reason)).toBe(true);
}

afterEach(async () => {
  await Promise.all(
    temporaryDirectories
      .splice(0)
      .map((directory) => fs.rm(directory, { force: true, recursive: true })),
  );
});

describe("captureReviewTargetFreshness", () => {
  it("captures repository-wide branch and PR changes from a nested cwd", async () => {
    const root = await makeRepository();
    await fs.mkdir(path.join(root, "nested"));
    await fs.mkdir(path.join(root, "sibling"));
    await fs.writeFile(path.join(root, "nested", "local.txt"), "base\n");
    await fs.writeFile(path.join(root, "sibling", "changed.txt"), "base\n");
    await commitAll(root, "base");
    await runGit(root, "branch", "baseline");
    await fs.writeFile(path.join(root, "sibling", "changed.txt"), "changed\n");
    await commitAll(root, "change sibling");
    const cwd = path.join(root, "nested");
    const reviewerPaths = await runGit(
      cwd,
      "diff",
      "--name-only",
      "baseline...HEAD",
      "--",
    );
    expect(reviewerPaths).toContain("sibling/changed.txt");

    for (const target of [
      { type: "baseBranch", branch: "baseline" } as const,
      {
        type: "pullRequest",
        baseBranch: "baseline",
        prNumber: 1,
        title: "nested",
      } as const,
    ]) {
      const before = await captureReviewTargetFreshness(cwd, target);
      expect(before.fileCount).toBe(1);
      await fs.writeFile(path.join(root, "sibling", "changed.txt"), "edited\n");
      expect((await captureReviewTargetFreshness(cwd, target)).digest).not.toBe(
        before.digest,
      );
      await fs.writeFile(
        path.join(root, "sibling", "changed.txt"),
        "changed\n",
      );
    }
  });

  it("captures repository-wide uncommitted changes from a nested cwd", async () => {
    const root = await makeRepository();
    await fs.mkdir(path.join(root, "nested"));
    await fs.mkdir(path.join(root, "sibling"));
    await fs.writeFile(path.join(root, "sibling", "staged.txt"), "base\n");
    await fs.writeFile(path.join(root, "sibling", "unstaged.txt"), "base\n");
    await commitAll(root, "base");
    await fs.writeFile(path.join(root, "sibling", "staged.txt"), "staged\n");
    await runGit(root, "add", "sibling/staged.txt");
    await fs.writeFile(
      path.join(root, "sibling", "unstaged.txt"),
      "unstaged\n",
    );
    await fs.writeFile(path.join(root, "sibling", "untracked.txt"), "new\n");
    const cwd = path.join(root, "nested");

    const before = await captureReviewTargetFreshness(cwd, {
      type: "uncommitted",
    });
    expect(before.fileCount).toBe(3);
    await fs.writeFile(path.join(root, "sibling", "untracked.txt"), "edited\n");
    expect(
      (await captureReviewTargetFreshness(cwd, { type: "uncommitted" })).digest,
    ).not.toBe(before.digest);
  });

  it("fingerprints reviewed dot-directory and dependency paths in Git status", async () => {
    const cwd = await makeRepository();
    await fs.mkdir(path.join(cwd, ".pi"));
    await fs.mkdir(path.join(cwd, "node_modules"));
    await fs.writeFile(path.join(cwd, ".pi", "staged.json"), "one\n");
    await fs.writeFile(path.join(cwd, ".pi", "unstaged.json"), "one\n");
    await fs.writeFile(path.join(cwd, "node_modules", "source.ts"), "one\n");
    await commitAll(cwd, "base");
    await fs.writeFile(path.join(cwd, ".pi", "staged.json"), "two\n");
    await runGit(cwd, "add", ".pi/staged.json");
    await fs.writeFile(path.join(cwd, ".pi", "unstaged.json"), "two\n");
    await fs.writeFile(path.join(cwd, ".pi", "untracked.json"), "one\n");
    await fs.writeFile(path.join(cwd, "node_modules", "source.ts"), "two\n");

    const reviewerPacketPaths = await runGit(
      cwd,
      "status",
      "--porcelain",
      "--untracked-files=all",
    );
    expect(reviewerPacketPaths).toContain(".pi/staged.json");
    expect(reviewerPacketPaths).toContain(".pi/unstaged.json");
    expect(reviewerPacketPaths).toContain(".pi/untracked.json");
    expect(reviewerPacketPaths).toContain("node_modules/source.ts");

    const target = { type: "uncommitted" } as const;
    const before = await captureReviewTargetFreshness(cwd, target);
    expect(before.fileCount).toBe(4);
    await fs.writeFile(path.join(cwd, ".pi", "untracked.json"), "two\n");
    expect((await captureReviewTargetFreshness(cwd, target)).digest).not.toBe(
      before.digest,
    );
  });

  it("includes reviewed .pi and node_modules files in folder snapshots", async () => {
    const cwd = await makeRepository();
    await fs.mkdir(path.join(cwd, ".pi"));
    await fs.mkdir(path.join(cwd, "node_modules"));
    await fs.writeFile(path.join(cwd, ".pi", "settings.json"), "one\n");
    await fs.writeFile(path.join(cwd, "node_modules", "source.ts"), "one\n");
    const target = { type: "folder", paths: ["."] } as const;
    const before = await captureReviewTargetFreshness(cwd, target);
    expect(before.fileCount).toBe(2);
    await fs.writeFile(path.join(cwd, ".pi", "settings.json"), "two\n");
    expect((await captureReviewTargetFreshness(cwd, target)).digest).not.toBe(
      before.digest,
    );
  });

  it("keeps folder snapshots relative to a nested cwd", async () => {
    const root = await makeRepository();
    await fs.mkdir(path.join(root, "nested"));
    await fs.writeFile(path.join(root, "nested", "selected.txt"), "one\n");
    await fs.writeFile(path.join(root, "sibling.txt"), "one\n");
    const target = { type: "folder", paths: ["."] } as const;
    const before = await captureReviewTargetFreshness(
      path.join(root, "nested"),
      target,
    );
    await fs.writeFile(path.join(root, "sibling.txt"), "two\n");
    expect(
      await captureReviewTargetFreshness(path.join(root, "nested"), target),
    ).toEqual(before);
  });

  it("is stable when uncommitted tracked content is unchanged", async () => {
    const cwd = await makeRepository();
    const file = path.join(cwd, "tracked.txt");
    await fs.writeFile(file, "base\n");
    await commitAll(cwd, "base");
    await fs.writeFile(file, "edit\n");

    const first = await captureReviewTargetFreshness(cwd, {
      type: "uncommitted",
    });
    const second = await captureReviewTargetFreshness(cwd, {
      type: "uncommitted",
    });

    expect(second).toEqual(first);
  });

  it("detects same-size content changes even when timestamps are restored", async () => {
    const cwd = await makeRepository();
    const file = path.join(cwd, "tracked.txt");
    await fs.writeFile(file, "aaaa\n");
    await commitAll(cwd, "base");
    await fs.writeFile(file, "bbbb\n");
    // Date round-trips milliseconds, not the filesystem sub-millisecond precision.
    await fs.utimes(
      file,
      new Date(1_700_000_000_000),
      new Date(1_700_000_000_000),
    );
    const before = await fs.stat(file);
    const first = await captureReviewTargetFreshness(cwd, {
      type: "uncommitted",
    });

    await fs.writeFile(file, "cccc\n");
    await fs.utimes(file, before.atime, before.mtime);
    const after = await fs.stat(file);
    const second = await captureReviewTargetFreshness(cwd, {
      type: "uncommitted",
    });

    expect(after.size).toBe(before.size);
    expect(after.mtimeMs).toBe(before.mtimeMs);
    expect(second.digest).not.toBe(first.digest);
  });

  it("detects a HEAD-only change with the same staged index and worktree", async () => {
    const cwd = await makeRepository();
    const file = path.join(cwd, "tracked.txt");
    await fs.writeFile(file, "first\n");
    await commitAll(cwd, "first");
    const previousCommit = (await runGit(cwd, "rev-parse", "HEAD")).trim();
    await fs.writeFile(file, "second\n");
    await commitAll(cwd, "second");
    await fs.writeFile(file, "third\n");
    await runGit(cwd, "add", "tracked.txt");

    const target = { type: "uncommitted" } as const;
    const beforeStatus = await runGit(cwd, "status", "--porcelain=v1");
    const beforeIndex = await runGit(cwd, "ls-files", "--stage");
    const before = await captureReviewTargetFreshness(cwd, target);

    await runGit(cwd, "reset", "--soft", previousCommit);

    expect(await runGit(cwd, "status", "--porcelain=v1")).toBe(beforeStatus);
    expect(await runGit(cwd, "ls-files", "--stage")).toBe(beforeIndex);
    expect(await fs.readFile(file, "utf8")).toBe("third\n");
    expect((await captureReviewTargetFreshness(cwd, target)).digest).not.toBe(
      before.digest,
    );
  });

  it("captures an unborn repository and changes identity after its first commit", async () => {
    const cwd = await makeRepository();
    const target = { type: "uncommitted" } as const;
    const unborn = await captureReviewTargetFreshness(cwd, target);

    await runGit(cwd, "commit", "--allow-empty", "--quiet", "-m", "first");

    const firstCommit = await captureReviewTargetFreshness(cwd, target);
    expect(firstCommit.digest).not.toBe(unborn.digest);
  });

  it("captures untracked membership additions and removals", async () => {
    const cwd = await makeRepository();
    await fs.writeFile(path.join(cwd, "tracked.txt"), "base\n");
    await commitAll(cwd, "base");
    const target = { type: "uncommitted" } as const;

    const before = await captureReviewTargetFreshness(cwd, target);
    await fs.writeFile(path.join(cwd, "new.txt"), "untracked\n");
    const added = await captureReviewTargetFreshness(cwd, target);
    await fs.rm(path.join(cwd, "new.txt"));
    const removed = await captureReviewTargetFreshness(cwd, target);

    expect(added.digest).not.toBe(before.digest);
    expect(removed.digest).toBe(before.digest);
  });

  it("scopes folder membership and bytes without unrelated files", async () => {
    const cwd = await makeRepository();
    await fs.mkdir(path.join(cwd, "selected"));
    await fs.writeFile(path.join(cwd, "selected", "one.txt"), "one\n");
    await fs.writeFile(path.join(cwd, "unrelated.txt"), "one\n");
    await commitAll(cwd, "base");
    const target = { type: "folder" as const, paths: ["selected"] };

    const before = await captureReviewTargetFreshness(cwd, target);
    await fs.writeFile(path.join(cwd, "unrelated.txt"), "changed\n");
    const unrelated = await captureReviewTargetFreshness(cwd, target);
    await fs.writeFile(path.join(cwd, "selected", "two.txt"), "two\n");
    const added = await captureReviewTargetFreshness(cwd, target);

    expect(unrelated.digest).toBe(before.digest);
    expect(added.digest).not.toBe(before.digest);
  });

  it("rejects symlinked folder traversal", async () => {
    const cwd = await makeRepository();
    const outside = await fs.mkdtemp(
      path.join(os.tmpdir(), "review-freshness-outside-"),
    );
    temporaryDirectories.push(outside);
    await fs.writeFile(path.join(outside, "secret.txt"), "secret\n");
    await fs.symlink(outside, path.join(cwd, "selected"));

    await expectFreshnessError(
      captureReviewTargetFreshness(cwd, {
        type: "folder",
        paths: ["selected"],
      }),
      "unsafe-path",
    );
  });

  it("fails closed on cancellation and finite limits", async () => {
    const cwd = await makeRepository();
    await fs.writeFile(path.join(cwd, "one.txt"), "one\n");
    await fs.writeFile(path.join(cwd, "two.txt"), "two\n");
    await commitAll(cwd, "base");

    const controller = new AbortController();
    controller.abort();
    await expectFreshnessError(
      captureReviewTargetFreshness(
        cwd,
        { type: "folder", paths: ["one.txt"] },
        { signal: controller.signal },
      ),
      "cancelled",
    );
    await expectFreshnessError(
      captureReviewTargetFreshness(
        cwd,
        { type: "folder", paths: ["."] },
        {
          maxFiles: 1,
        },
      ),
      "file-limit",
    );
    await expectFreshnessError(
      captureReviewTargetFreshness(
        cwd,
        { type: "folder", paths: ["one.txt"] },
        {
          maxBytes: 1,
        },
      ),
      "byte-limit",
    );
  });
});

it("captures branch and commit identity and current affected bytes", async () => {
  const cwd = await makeRepository();
  await fs.writeFile(path.join(cwd, "tracked.txt"), "base\n");
  await commitAll(cwd, "base");
  await runGit(cwd, "branch", "baseline");
  await fs.writeFile(path.join(cwd, "tracked.txt"), "changed\n");
  await commitAll(cwd, "change");
  const branch = { type: "baseBranch", branch: "baseline" } as const;
  const commit = { type: "commit", sha: "HEAD" } as const;
  const firstBranch = await captureReviewTargetFreshness(cwd, branch);
  const firstCommit = await captureReviewTargetFreshness(cwd, commit);
  await runGit(
    cwd,
    "commit",
    "--allow-empty",
    "--quiet",
    "-m",
    "identity only",
  );
  expect((await captureReviewTargetFreshness(cwd, branch)).digest).not.toBe(
    firstBranch.digest,
  );
  expect((await captureReviewTargetFreshness(cwd, commit)).digest).not.toBe(
    firstCommit.digest,
  );
  const sha = (await runGit(cwd, "rev-parse", "HEAD~1")).trim();
  const fixed = { type: "commit", sha } as const;
  const before = await captureReviewTargetFreshness(cwd, fixed);
  await fs.writeFile(path.join(cwd, "tracked.txt"), "working\n");
  expect((await captureReviewTargetFreshness(cwd, fixed)).digest).not.toBe(
    before.digest,
  );
});

it("captures folder dependencies, detects removal, and rejects escapes and nested symlinks", async () => {
  const cwd = await makeRepository();
  await fs.mkdir(path.join(cwd, "selected"));
  await fs.writeFile(path.join(cwd, "selected", "one"), "one");
  const target = { type: "folder", paths: ["."] };
  const before = await captureReviewTargetFreshness(cwd, {
    type: "folder",
    paths: target.paths,
  });
  await fs.mkdir(path.join(cwd, "node_modules"));
  await fs.writeFile(path.join(cwd, "node_modules", "artifact"), "ignored");
  expect(
    (
      await captureReviewTargetFreshness(cwd, {
        type: "folder",
        paths: target.paths,
      })
    ).digest,
  ).not.toBe(before.digest);
  await fs.rm(path.join(cwd, "selected", "one"));
  expect(
    (
      await captureReviewTargetFreshness(cwd, {
        type: "folder",
        paths: target.paths,
      })
    ).digest,
  ).not.toBe(before.digest);
  await expectFreshnessError(
    captureReviewTargetFreshness(cwd, { type: "folder", paths: ["../escape"] }),
    "unsafe-path",
  );
  await fs.symlink(cwd, path.join(cwd, "selected", "link"));
  await expectFreshnessError(
    captureReviewTargetFreshness(cwd, {
      type: "folder",
      paths: ["selected/link/selected"],
    }),
    "unsafe-path",
  );
});

it("captures staged identity and untracked bytes and supports pull requests", async () => {
  const cwd = await makeRepository();
  await fs.writeFile(path.join(cwd, "one"), "base");
  await commitAll(cwd, "base");
  await runGit(cwd, "branch", "baseline");
  await fs.writeFile(path.join(cwd, "one"), "edit");
  const target = { type: "uncommitted" } as const;
  const unstaged = await captureReviewTargetFreshness(cwd, target);
  await runGit(cwd, "add", "one");
  expect((await captureReviewTargetFreshness(cwd, target)).digest).not.toBe(
    unstaged.digest,
  );
  await fs.writeFile(path.join(cwd, "new"), "aaaa");
  const untracked = await captureReviewTargetFreshness(cwd, target);
  await fs.writeFile(path.join(cwd, "new"), "bbbb");
  expect((await captureReviewTargetFreshness(cwd, target)).digest).not.toBe(
    untracked.digest,
  );
  const pr = {
    type: "pullRequest",
    prNumber: 1,
    baseBranch: "baseline",
    title: "test",
  } as const;
  const branch = { type: "baseBranch", branch: "HEAD" } as const;
  const beforeBranch = await captureReviewTargetFreshness(cwd, branch);
  const before = await captureReviewTargetFreshness(cwd, pr);
  expect(before.fileCount).toBe(1);
  await fs.writeFile(path.join(cwd, "new"), "cccc");
  expect(await captureReviewTargetFreshness(cwd, pr)).toEqual(before);
  await fs.writeFile(path.join(cwd, "one"), "more");
  expect((await captureReviewTargetFreshness(cwd, branch)).digest).not.toBe(
    beforeBranch.digest,
  );
  expect((await captureReviewTargetFreshness(cwd, pr)).digest).not.toBe(
    before.digest,
  );
  await expectFreshnessError(
    captureReviewTargetFreshness(cwd, target, { maxBytes: 1 }),
    "byte-limit",
  );
  await expectFreshnessError(
    captureReviewTargetFreshness(cwd, { type: "commit", sha: "--invalid" }),
    "git-error",
  );
  await expectFreshnessError(
    captureReviewTargetFreshness(cwd, target, {
      maxFiles: Number.POSITIVE_INFINITY,
    }),
    "invalid-limit",
  );
});

it("rejects special files without opening them", async () => {
  const cwd = await makeRepository();
  const child = spawn(["mkfifo", path.join(cwd, "pipe")]);
  expect(await child.exited).toBe(0);
  await expectFreshnessError(
    captureReviewTargetFreshness(cwd, { type: "folder", paths: ["pipe"] }),
    "special-file",
  );
});
