---
name: simplify
description: Simplify recent or scoped code using code-simplifier with strict edit boundaries. Use for /simplify command packets.
---

# Simplify

Simplify code without changing behavior.

## Contract

- Delegate to `code-simplifier`. Do not select reviewers.
- Do not set `max_turns` on the `code-simplifier` Agent call.
- Preserve behavior and public command syntax.
- Make code clearer, smaller, and easier to maintain.
- Keep changes within the provided editable file list.
- You may read outside editable files for context only.
- Do not edit ignored lockfiles or unsupported changed files.
- If needed edits fall outside editable files, stop and report the missing file path.
- Before delegating scoped work, re-resolve scope and compare editable files only when a stale-check is provided. Ignore lockfile drift. Stop if editable files changed or new unsupported non-lock files appeared.
- Run targeted validation for touched code where practical.
