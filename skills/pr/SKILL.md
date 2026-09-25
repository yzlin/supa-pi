---
name: pr
description: Draft a PR body and submit a branch for review against its base. Use for /pr or requests to write, open, or submit a pull request.
origin: Matt Pocock pr skill (in-progress), adapted
---

# Pull Request

Use for `/pr` or natural requests to write, open, or submit a pull request or PR body. Draft from verified branch state; submit only with approval.

## Inputs and Preflight

1. Accept an optional `--base <branch>`. Reject malformed or extra arguments rather than guessing.
2. Read `git remote get-url origin`; if origin is missing, report it and stop. Resolve origin with `gh repo view "$(git remote get-url origin)" --json nameWithOwner,defaultBranchRef`; store `.nameWithOwner` as `<repo>` and stop if the URL is not a GitHub repository or resolution fails. (`gh repo view` uses its positional repository selector instead of the unavailable `-R`/`--repo` flag.)
3. Without `--base`, use the resolved `.defaultBranchRef.name`. If it is unavailable, use `git symbolic-ref refs/remotes/origin/HEAD` and remove the `refs/remotes/origin/` prefix. If neither works, ask for `--base` and stop.
4. Fetch the base before comparing: `git fetch origin <base>`. Use `origin/<base>` for every comparison below.
5. Read the current branch. If the current branch equals the base, report "create a branch first" and stop.
6. Run `git status --porcelain --untracked-files=all`. If there are uncommitted or untracked changes, list the files, ask the user to commit or stash them, and stop.
7. Count `origin/<base>..HEAD`. If there are no commits ahead of base, report that and stop.

Never create a branch, commit, or stash for the user. A preflight stop ends the workflow before drafting or submitting. The skill always targets origin's repository regardless of `gh repo set-default`; fork→upstream PRs are out of scope.

## Gather

- Read the target repository's `CONTEXT.md` and use its domain language.
- Read the full branch commit history with `git log origin/<base>..HEAD`.
- Read the complete merge-base diff with `git diff origin/<base>...HEAD`.
- Inspect changed files and relevant repository guidance; do not infer behavior from commit subjects alone.
- Check for an open PR for the current branch with `gh pr view <branch> --json number,url,state,baseRefName -R <repo>` (`-R` requires the explicit branch); `no pull requests found` means no existing PR, while any other failure stops. Retain its number, URL, and `baseRefName` only when its state is open.

## Evidence

Run evidence against the current `HEAD`:

1. Choose targeted tests for the changed files and run them.
2. Run the repository's check command. Discover it from package scripts and `AGENTS.md`; in this repository use `bun run check`.
3. Record **After** from real current output only. Never invent or upgrade evidence; replace placeholders with concise exact commands or outputs and preserve failures honestly.
4. Record **Before** from base-branch evidence only when it is already available or cheap to capture without disruptive work. Otherwise write literally `not captured`.
5. Prefer screenshots for visual changes when the environment supports them; otherwise use execution output.
6. When relevant, show the exact failing or passing test as concise pseudocode.

Failing checks do not block drafting. Record each failure under Evidence and flag failures prominently in the confirmation so the user decides whether to submit or abort.

## Draft

Use a conventional-commit title:

`<type>: <description>`

Allowed types: feat, fix, refactor, build, ci, chore, docs, style, perf, test. Keep the description specific and brief.

Write the body with no preamble and brief prose:

```markdown
## Summary

<diagram, diff-sketch, or tree>

## Evidence

- **Before:** <screenshot/output/failing test run | not captured>
  **After:** <screenshot/output/passing test run>

## Merge Danger

**Door:** <one-way or two-way>

<optional: description>

**Blast Radius:** <one-word description>

<optional: potential ramifications of merge>
```

### Summary

Apply the `showing-me` skill to the diff, without copying its content. Choose the smallest useful view shaped to the topic: pseudocode, call tree, component tree, shallow file tree, Mermaid, or focused diff sketch. Use verified names and emphasize the change rather than restating prose.

### Merge Danger

A **two-way** door has a cheap rollback. A **one-way** door is destructive or hard to reverse, such as a migration, data deletion, public API or contract removal, or published release. Explain only when useful.

Choose a one-word **Blast Radius** after considering consumers, layout shift, mobile behavior, data, performance, and other affected surfaces. Add ramifications only when material.

## Confirm

Exactly one confirmation is allowed before any outward-facing mutation.

First, print the complete title and body as a normal assistant message, outside the confirmation prompt, so the draft stays readable in chat history.

Then use the `ask` tool when available. Keep that single prompt short; never repeat the title or body in it. It shows:

- a one-line reference to the draft printed above;
- the resolved origin repository `<repo>` and base branch;
- whether this will create a PR or update the detected open PR;
- when the open PR's `baseRefName` differs from the resolved base, a prominent `retarget <baseRefName> → <base>` notice;
- a prominent failing-check flag when any check failed; and
- the choice to approve submission or decline.

Approval covers only the displayed title, body, base, push, and create-or-update action, including any displayed retarget. Never change them silently or confirm push separately. If the user declines, stop, print the title and body, and leave nothing pushed.

## Submit

Only after approval:

1. Write the approved body to a temporary file.
2. Push with `git push -u origin <branch>`.
3. If no open PR was detected, create a ready-for-review PR with:
   `gh pr create --base <base> --title <title> --body-file <tmp> -R <repo>`
4. For an open PR whose `baseRefName` matches the resolved base, update it with:
   `gh pr edit <n> --title <title> --body-file <tmp> -R <repo>`
   When its `baseRefName` differs, apply the approved retarget with:
   `gh pr edit <n> --base <base> --title <title> --body-file <tmp> -R <repo>`
5. Remove the temporary file.

## Output

Report the final PR URL. If submission fails after approval, report the exact completed step and failure; do not claim a PR exists or retry mutations without fresh user direction.

## Attribution

Adapted from Matt Pocock's MIT-licensed in-progress [`pr` skill at commit `c55ee46073ed923f86ce59a5eb3b6d895095d1b7`](https://github.com/mattpocock/skills/tree/c55ee46073ed923f86ce59a5eb3b6d895095d1b7/skills/in-progress/pr). Its Summary section derives from HumanLayer's MIT-licensed `show-me`; credit is carried by `skills/showing-me`.
