---
summary: "Behavior and safety boundaries for scoped code-improvement commands."
read_when:
  - "Changing /simplify, /improve-codebase-architecture, scope parsing, consent gates, or code-improvement prompts."
---

# Code-improvement extension

Read when changing `/simplify`, `/improve-codebase-architecture`, or code-improvement prompt files.

## `/simplify` behavior

`/simplify` runs in the main session; it does not delegate. `skills/simplify/SKILL.md` owns the scope contract, the simplification craft, and the Audit. The former `code-simplifier` agent was retired on 2026-10-30 after a live A/B (`simplify-command-scoped`, claude-opus-5-5, 2 repetitions) showed equal scores (1.00 in both arms) at about 43% lower cost and 46% lower latency for the main-session path. The skill also owns the former dead-code, duplicate-consolidation, and dependency-cleanup safeguards; its default remains recently modified code, and broader cleanup requires explicit assignment.

Within the assigned `Editable files`, `/simplify` may replace an in-scope custom mechanism with an existing repository, standard-library, native-platform, or already-installed dependency capability when actual safety, correctness, accessibility, edge-case, and public-contract requirements remain supported. It must stop and report rather than widen scope when another file or new package research is needed.

`/simplify` applies a comment keep list (license headers, non-obvious behavior forced by external constraints, public API doc comments, issue/RFC links for constraints code cannot express) and audits lint/type suppressions in scope. When a safe in-scope fix is not possible, it reports a reshape flag (symbol, problem, suggested refactor) instead of rewording the comment. Before editing, main records a baseline (git status, copies of editable files, hashes of changed paths outside them). After editing, main checks its own diff for behavior changes, scope escapes, keep-list deletions, and false flags; it never reverts paths outside editable files, uses no git revert commands, and retries a failed audit once before reporting it open. `skills/simplify/SKILL.md` owns the exact Audit steps.

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

`/simplify` may inspect context outside editable files, but may edit only `Editable files`. If useful simplification needs another file, stop and report the missing path instead of widening scope. Lockfile-only scopes no-op after reporting ignored lockfiles. If Git ignore checks are unavailable, `/simplify` warns and falls back without ignore-based pruning.

`--extra <guidance>` adds extra guidance to the `/simplify` packet. It does not widen editable files.

`--yes` skips confirmation prompts that are otherwise required for large scopes, PR checkout, or unsupported non-lock files. In no-UI mode, large scopes, PR checkout, and unsupported non-lock files require `--yes`.

With no arguments, UI sessions prompt for a scope using a smart default. No-UI sessions keep the legacy behavior: simplify recent feature implementation or recently modified code.

## `/improve-codebase-architecture` behavior

The read-only architecture review keeps its existing candidate report contract. Complexity findings must name an exact location, the unnecessary mechanism to cut, its replacement or `none`, and evidence/verification that required contracts remain supported; safety findings remain in scope.

Architecture exploration delegates to blocking `subagent({agent: "explorer", task})` only for broad scope (no scope instruction, or several unfamiliar Modules), passing self-contained scope, durable context paths, and read-only evidence requirements; main awaits every report, verifies specific findings, and synthesizes candidates. If delegation is unavailable for a broad scope, report the blocker and stop. Narrow scopes are explored directly in the main session; a live A/B (`architecture-narrow-scope`/`architecture-broad-scope`, 2026-10-29, claude-opus-5-5, 2 repetitions) moved narrow runs from 0/2 to 2/2 pass with broad delegation unchanged. Interface alternatives require human candidate selection or an explicit request; parallel generic children receive self-contained read-only briefs. This command does not authorize implementation, execution-ledger assignments, or goal-state changes. `skills/simplify/SKILL.md` is canonical for `/simplify`.
