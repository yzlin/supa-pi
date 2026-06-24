# Code-improvement extension

Read when changing `/simplify`, `/improve-codebase-architecture`, or code-improvement prompt files.

## `/simplify` behavior

`/simplify` still delegates implementation work to the `code-simplifier` subagent. The main session may do only minimal preflight before delegation, such as resolving a scope, checking consent, or re-checking that a queued scoped simplify still resolves to the same file allowlist. Delegation should not set `max_turns`; simplification often needs enough turns to inspect, edit, validate, and report.

Scoped grammar is strict:

```text
/simplify [uncommitted|branch <base>|commit <sha>|pr <ref>|folder <paths>] [--extra <guidance>] [--yes]
```

Supported scopes:

- `uncommitted` — files changed in the working tree.
- `branch <base>` — files changed relative to the base branch.
- `commit <sha>` — files changed by a commit.
- `pr <ref>` — checkout a PR number or GitHub PR URL, then simplify files changed by that PR.
- `folder <paths>` — explicit files or folders. Folder descendants are pruned recursively using Git ignore rules.

Scoped runs build a three-section file contract:

- `Editable files` — the hard edit boundary for the agent prompt.
- `Ignored lockfiles (read-only)` — lockfiles found in the scope; never editable, including folder scopes.
- `Unsupported changed files` — safe-filtered files such as missing, unsafe, generated/vendor, binary, non-text, or explicit ignored paths.

The simplifier may inspect context outside editable files, but may edit only `Editable files`. If useful simplification needs another file, stop and report the missing path instead of widening scope. Lockfile-only scopes no-op after reporting ignored lockfiles. If Git ignore checks are unavailable, `/simplify` warns and falls back without ignore-based pruning.

`--extra <guidance>` adds extra guidance to the simplifier prompt. It does not widen editable files.

`--yes` skips confirmation prompts that are otherwise required for large scopes, PR checkout, or unsupported non-lock files. In no-UI mode, large scopes, PR checkout, and unsupported non-lock files require `--yes`.

With no arguments, UI sessions prompt for a scope using a smart default. No-UI sessions keep the legacy behavior: simplify recent feature implementation or recently modified code.
