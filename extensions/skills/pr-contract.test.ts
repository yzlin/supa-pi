import { describe, expect, it } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const prCommandEntry = /["']?pr["']?\s*:\s*\{/u;
const githubCommand = /`(gh (?:pr|repo view) [^`]+)`/gu;
const repositoryFlag = /(?:-R|--repo) <repo>$/u;

function readRepositoryFile(path: string): string {
  return readFileSync(join(process.cwd(), path), "utf8");
}

const skill = readRepositoryFile("skills/pr/SKILL.md");

describe("pr skill contract", () => {
  it.each([
    "name: pr",
    "Accept an optional `--base <branch>`",
    "Reject malformed or extra arguments",
    "if origin is missing, report it and stop",
    "store `.nameWithOwner` as `<repo>` and stop if the URL is not a GitHub repository or resolution fails",
    "Without `--base`, use the resolved `.defaultBranchRef.name`",
    "git symbolic-ref refs/remotes/origin/HEAD",
    "remove the `refs/remotes/origin/` prefix",
    "If neither works, ask for `--base` and stop",
    "git fetch origin <base>",
    "Use `origin/<base>` for every comparison below",
    'current branch equals the base, report "create a branch first" and stop',
    "git status --porcelain --untracked-files=all",
    "uncommitted or untracked changes, list the files, ask the user to commit or stash them, and stop",
    "Count `origin/<base>..HEAD`",
    "no commits ahead of base, report that and stop",
    "Never create a branch, commit, or stash for the user",
    "A preflight stop ends the workflow before drafting or submitting",
    "regardless of `gh repo set-default`",
    "fork→upstream PRs are out of scope",
    "git log origin/<base>..HEAD",
    "git diff origin/<base>...HEAD",
    "gh pr view <branch> --json number,url,state,baseRefName -R <repo>",
    "Retain its number, URL, and `baseRefName` only when its state is open",
    "Run evidence against the current `HEAD`",
    "Choose targeted tests for the changed files and run them",
    "Run the repository's check command",
    "bun run check",
    "Never invent or upgrade evidence",
    "Record **Before** from base-branch evidence only when it is already available or cheap to capture without disruptive work. Otherwise write literally `not captured`",
    "Failing checks do not block drafting",
    "Record each failure under Evidence and flag failures prominently in the confirmation",
    "<type>: <description>",
    "feat, fix, refactor, build, ci, chore, docs, style, perf, test",
    "## Summary",
    "Apply the `showing-me` skill to the diff",
    "Choose the smallest useful view",
    "## Evidence",
    "**Before:**",
    "**After:**",
    "## Merge Danger",
    "**Door:** <one-way or two-way>",
    "**Blast Radius:** <one-word description>",
    "Exactly one confirmation is allowed before any outward-facing mutation",
    "First, print the complete title and body as a normal assistant message, outside the confirmation prompt",
    "Then use the `ask` tool when available",
    "Keep that single prompt short; never repeat the title or body in it",
    "a one-line reference to the draft printed above",
    "the resolved origin repository `<repo>` and base branch",
    "whether this will create a PR or update the detected open PR",
    "when the open PR's `baseRefName` differs from the resolved base, a prominent `retarget <baseRefName> → <base>` notice",
    "a prominent failing-check flag when any check failed",
    "the choice to approve submission or decline",
    "Approval covers only the displayed title, body, base, push, and create-or-update action, including any displayed retarget",
    "Never change them silently or confirm push separately",
    "If the user declines, stop, print the title and body, and leave nothing pushed",
    "Only after approval:",
    "git push -u origin <branch>",
    "If no open PR was detected, create a ready-for-review PR",
    "gh pr create --base <base> --title <title> --body-file <tmp>",
    "For an open PR whose `baseRefName` matches the resolved base",
    "gh pr edit <n> --title <title> --body-file <tmp>",
    "When its `baseRefName` differs, apply the approved retarget",
    "gh pr edit <n> --base <base> --title <title> --body-file <tmp>",
    "Report the final PR URL",
    "If submission fails after approval, report the exact completed step and failure",
    "do not claim a PR exists or retry mutations without fresh user direction",
    "Matt Pocock's MIT-licensed",
    "c55ee46073ed923f86ce59a5eb3b6d895095d1b7",
    "HumanLayer's MIT-licensed `show-me`; credit is carried by `skills/showing-me`",
  ])("preserves %s", (requirement) => {
    expect(skill).toContain(requirement);
  });

  it("detects untracked files regardless of git config", () => {
    expect(skill).toContain("git status --porcelain --untracked-files=all");
    expect(skill).not.toContain("git status --short");
  });

  it("pins GitHub commands to origin and creates ready PRs", () => {
    const commands = Array.from(
      skill.matchAll(githubCommand),
      ([, command]) => command
    );
    expect(commands).toHaveLength(5);
    for (const command of commands) {
      if (command.startsWith("gh repo view ")) {
        expect(command).toBe(
          'gh repo view "$(git remote get-url origin)" --json nameWithOwner,defaultBranchRef'
        );
      } else {
        expect(command).toMatch(repositoryFlag);
      }
    }
    expect(skill).not.toContain("--draft");
  });

  it("keeps /pr as a thin canonical prompt wrapper", () => {
    const prompt = readRepositoryFile("prompts/pr.md");
    expect(prompt).toContain('argument-hint: "[--base <branch>]"');
    expect(prompt).toContain(
      "Use the `pr` skill as canonical for this explicit command."
    );
    expect(prompt).toContain(
      ["$", "{@:-Use the repository default branch as base.}"].join("")
    );
    expect(
      readRepositoryFile("extensions/prompt-commands/index.ts")
    ).not.toMatch(prCommandEntry);
  });
});
