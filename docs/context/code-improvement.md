---
summary: "Behavior and safety boundaries for scoped code-improvement commands."
read_when:
  - "Changing /simplify, /improve-codebase-architecture, scope parsing, consent gates, or code-improvement prompts."
---

# Code-improvement extension

Read when changing `/simplify`, `/improve-codebase-architecture`, or code-improvement prompt files.

## `/simplify` behavior

`/simplify` still delegates implementation work to the `code-simplifier` subagent. The main session may do only minimal preflight before delegation, such as resolving a scope, checking consent, or re-checking that a queued scoped simplify still resolves to the same file allowlist. Use blocking `subagent({agent: "code-simplifier", task})` with a self-contained scope and validation instructions; children do not inherit parent conversation. Main independently checks the result. The code-simplifier also owns the former dead-code, duplicate-consolidation, and dependency-cleanup safeguards; its default remains recently modified code, and broader cleanup requires explicit assignment.

Within the assigned `Editable files`, the simplifier may replace an in-scope custom mechanism with an existing repository, standard-library, native-platform, or already-installed dependency capability when actual safety, correctness, accessibility, edge-case, and public-contract requirements remain supported. It must stop and report rather than widen scope when another file or new package research is needed.

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

## `/improve-codebase-architecture` behavior

The read-only architecture review keeps its existing candidate report contract. Complexity findings must name an exact location, the unnecessary mechanism to cut, its replacement or `none`, and evidence/verification that required contracts remain supported; safety findings remain in scope.

Architecture exploration begins with blocking `subagent({agent: "explorer", task})`, passing self-contained scope, durable context paths, and read-only evidence requirements. Main awaits the report, verifies specific findings, and synthesizes candidates. If delegation is unavailable, report the blocker and stop. Interface alternatives require human candidate selection or an explicit request; parallel generic children receive self-contained read-only briefs. This command does not authorize implementation, execution-ledger assignments, or goal-state changes. `skills/simplify/SKILL.md` remains canonical; the retained `extensions/code-improvement/SIMPLIFY.md` reference is not a separate active command prompt.
