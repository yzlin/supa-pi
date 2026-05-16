# Code-improvement extension

Read when changing `/simplify`, `/improve-codebase-architecture`, or code-improvement prompt files.

## `/simplify` behavior

`/simplify` still delegates implementation work to the `code-simplifier` subagent. The main session may do only minimal preflight before delegation, such as resolving a scope, checking consent, or re-checking that a queued scoped simplify still resolves to the same file allowlist.

Scoped grammar is strict:

```text
/simplify [uncommitted|branch <base>|commit <sha>|pr <ref>|folder <paths>] [--extra <guidance>] [--yes]
```

Supported scopes:

- `uncommitted` — files changed in the working tree.
- `branch <base>` — files changed relative to the base branch.
- `commit <sha>` — files changed by a commit.
- `pr <ref>` — checkout a PR number or GitHub PR URL, then simplify files changed by that PR.
- `folder <paths>` — explicit files or folders.

Scoped runs build an allowlist preview. That list is a hard file boundary for the agent prompt: inspect and edit only those files. If useful simplification needs another file, stop and report the missing path instead of widening scope.

`--extra <guidance>` adds extra guidance to the simplifier prompt. It does not widen the file allowlist.

`--yes` skips confirmation prompts that are otherwise required for large scopes or PR checkout. In no-UI mode, large scopes and PR checkout require `--yes`.

With no arguments, UI sessions prompt for a scope using a smart default. No-UI sessions keep the legacy behavior: simplify recent feature implementation or recently modified code.
