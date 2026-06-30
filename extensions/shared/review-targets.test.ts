import { describe, expect, it } from "bun:test";

import {
  type GitExec,
  getChangedPaths,
  normalizeStatusPaths,
  parseReviewPaths,
  parseReviewTargetArgs,
  tokenizeReviewTargetArgs,
} from "./review-targets";

function reviewers(value: string): string[] {
  return value
    .split(",")
    .map((item) => item.trim())
    .filter(Boolean);
}

describe("review target parsing", () => {
  it("parses direct targets", () => {
    expect(parseReviewTargetArgs("uncommitted").target).toEqual({
      type: "uncommitted",
    });
    expect(parseReviewTargetArgs("branch main").target).toEqual({
      type: "baseBranch",
      branch: "main",
    });
    expect(parseReviewTargetArgs("commit abc123 Fix bug").target).toEqual({
      type: "commit",
      sha: "abc123",
      title: "Fix bug",
    });
    expect(parseReviewTargetArgs("pr 42").target).toEqual({
      type: "pr",
      ref: "42",
    });
  });

  it("tokenizes and parses quoted folder args", () => {
    expect(tokenizeReviewTargetArgs("folder \"src one\" 'docs two'")).toEqual([
      "folder",
      "src one",
      "docs two",
    ]);
    expect(
      parseReviewTargetArgs("folder \"src one\" 'docs two'").target
    ).toEqual({
      type: "folder",
      paths: ["src one", "docs two"],
    });
  });

  it("parses --extra", () => {
    expect(parseReviewTargetArgs('branch main --extra "focus perf"')).toEqual({
      target: { type: "baseBranch", branch: "main" },
      extraInstruction: "focus perf",
      reviewers: undefined,
      useAutoReviewers: false,
      yes: false,
    });
  });

  it("parses --yes", () => {
    expect(parseReviewTargetArgs("folder src --yes")).toMatchObject({
      target: { type: "folder", paths: ["src"] },
      yes: true,
    });
  });

  it("keeps unknown args as no target", () => {
    expect(parseReviewTargetArgs("unknown thing")).toMatchObject({
      target: null,
      useAutoReviewers: false,
      yes: false,
    });
  });

  it("parses reviewer flags with caller-provided validation", () => {
    expect(
      parseReviewTargetArgs("uncommitted --reviewers a,b", {
        parseReviewers: reviewers,
      })
    ).toMatchObject({ reviewers: ["a", "b"] });
  });
});

describe("review path parsing", () => {
  it("parses whitespace-separated paths", () => {
    expect(parseReviewPaths("src docs\nREADME.md")).toEqual([
      "src",
      "docs",
      "README.md",
    ]);
  });

  it("normalizes status and rename paths", () => {
    expect(
      normalizeStatusPaths([
        " M src/index.ts",
        "?? new file.ts",
        "R  old.ts -> new.ts",
      ])
    ).toEqual(["src/index.ts", "new file.ts", "new.ts"]);
  });
});

describe("changed path resolution", () => {
  it("resolves uncommitted paths from status including untracked files", async () => {
    const gitExec: GitExec = (args) => {
      expect(args).toEqual(["status", "--porcelain", "--untracked-files=all"]);
      return Promise.resolve({
        stdout: " M src/index.ts\nR  old.ts -> new.ts\n?? newdir/file.ts\n",
        code: 0,
      });
    };

    await expect(
      getChangedPaths({ type: "uncommitted" }, gitExec)
    ).resolves.toEqual(["src/index.ts", "new.ts", "newdir/file.ts"]);
  });

  it("resolves branch paths via upstream merge base", async () => {
    const calls: string[][] = [];
    const gitExec: GitExec = (args) => {
      calls.push(args);
      if (args[0] === "rev-parse") {
        return Promise.resolve({ stdout: "origin/main\n", code: 0 });
      }
      if (args[0] === "merge-base") {
        return Promise.resolve({ stdout: "base123\n", code: 0 });
      }
      return Promise.resolve({ stdout: "src/a.ts\ndb/schema.sql\n", code: 0 });
    };

    await expect(
      getChangedPaths({ type: "baseBranch", branch: "main" }, gitExec)
    ).resolves.toEqual(["src/a.ts", "db/schema.sql"]);
    expect(calls).toEqual([
      ["rev-parse", "--abbrev-ref", "main@{upstream}"],
      ["merge-base", "HEAD", "origin/main"],
      ["diff", "--name-only", "base123"],
    ]);
  });

  it("resolves commit and folder paths", async () => {
    const commitCalls: string[][] = [];
    const gitExec: GitExec = (args) => {
      commitCalls.push(args);
      return Promise.resolve({ stdout: "src/commit.ts\n", code: 0 });
    };

    await expect(
      getChangedPaths({ type: "commit", sha: "abc123" }, gitExec)
    ).resolves.toEqual(["src/commit.ts"]);
    expect(commitCalls).toEqual([
      ["diff-tree", "--root", "--no-commit-id", "--name-only", "-r", "abc123"],
    ]);

    await expect(
      getChangedPaths({ type: "folder", paths: ["src"] }, gitExec)
    ).resolves.toEqual(["src"]);
  });
});
