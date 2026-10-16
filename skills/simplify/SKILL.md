---
name: simplify
description: Simplify recent or scoped code using code-simplifier with strict edit boundaries. Use for /simplify command packets.
---

# Simplify

Simplify code without changing behavior.

## Contract

- Delegate to `code-simplifier` with a blocking `subagent({agent: "code-simplifier", task: <complete scope and instructions>})` call. Do not select reviewers.
- Pass a self-contained task: children do not inherit parent conversation. Include editable files, stale-check results, constraints, and validation requirements.
- Preserve behavior and public command syntax.
- Make code clearer, smaller, and easier to maintain.
- Keep changes within the provided editable file list.
- You may read outside editable files for context only.
- Do not edit ignored lockfiles or unsupported changed files.
- If needed edits fall outside editable files, stop and report the missing file path.
- Before delegating scoped work, re-resolve scope and compare editable files only when a stale-check is provided. Ignore lockfile drift. Stop if editable files changed or new unsupported non-lock files appeared.
- If the run has no `Editable files` list, first resolve the recent-session files named by the focus instruction, write that list down, and pass it to the subagent as `Editable files`. That list is the edit boundary for the baseline and the Audit.
- Before delegating, record a baseline without modifying the working tree: run `git status --porcelain --untracked-files=all` for detection only, then copy every editable file to a temp directory outside the repo and record `git hash-object <path>` for each path that status lists outside editable files. Note editable paths that do not exist. This covers scoped and recent-session runs; recent-session runs use the resolved list.
- Run targeted validation for touched code where practical.

## Audit

After the subagent reports, rerun the same status, rehash those paths, and diff editable files against their saved copies.

- Any path outside editable files whose status line changed or whose hash differs from the baseline is a scope escape: reject the report and list those paths for the user, but never revert, restore, or trash paths outside editable files; main cannot tell who changed them.
- Also reject behavior changes, reshape flags that name code outside scope or misstate the problem, and deleted comments that meet the simplifier keep list: license headers; non-obvious behavior forced by an external dependency, platform, vendor, or protocol; doc comments that define a public API contract; issue or RFC links for constraints code cannot express.
- Revert a rejected report only inside editable files: restore each saved copy and move editable paths noted as not existing to Trash with `trash`.
- Then rerun once with the failure named from the restored baseline. If the rerun is also rejected, restore the baseline again and report the failure as open.
- Never use `git checkout`, `git restore`, `git reset`, or `git stash` push/pop/apply to revert /simplify results.

Report accepted changes, deleted comment count, reshape flags, reruns, validation, and open risks.
