---
name: simplify
description: Simplify recent or scoped code in the main session with strict edit boundaries. Use for /simplify command packets.
---

# Simplify

Simplify code without changing behavior, outputs, public contracts, or supported edge cases. Work in the main session; do not delegate this task.

## Contract

- Preserve behavior and public command syntax.
- Make code clearer, smaller, and easier to maintain.
- Keep changes within the editable file list. You may read outside editable files for context only.
- Do not edit ignored lockfiles or unsupported changed files.
- If needed edits fall outside editable files, stop and report the missing file path.
- When a stale-check is provided, re-resolve scope and compare editable files only. Ignore lockfile drift. Stop if editable files changed or new unsupported non-lock files appeared.
- If the run has no `Editable files` list, first resolve the recent-session files named by the focus instruction and write that list down. That list is the edit boundary for the baseline and the Audit.
- Pass `Extra guidance` through as guidance, not as permission to widen scope.
- Before editing, record a baseline without modifying the working tree: run `git status --porcelain --untracked-files=all` for detection only, then copy every editable file to a temp directory outside the repo and record `git hash-object <path>` for each path that status lists outside editable files. Note editable paths that do not exist. This covers scoped and recent-session runs; recent-session runs use the resolved list.
- Run targeted validation for touched code where practical.

## Craft

Follow `AGENTS.md`, relevant rules, and existing local conventions. Prefer clear, explicit code over compact or clever code. Default to recently modified code; use broader scope only when explicitly assigned.

Improve only where safe:

- reduce unnecessary nesting, duplication, indirection, and single-use abstractions
- clarify names and related control flow
- remove dead code only when non-use is established
- preserve helpful abstractions and separation of concerns
- avoid nested ternaries and dense one-liners
- do not combine unrelated concerns or optimize merely for fewer lines

Comments in scope:

- Keep license headers; non-obvious behavior forced by an external dependency, platform, vendor, or protocol; doc comments that define a public API contract; and issue or RFC links for constraints code cannot express.
- Delete narration, banners, restated code, and commented-out code.
- Never reword a justification into a shorter one. Either it meets the keep list or it goes.
- When a comment explains a surprise in our own code, prefer the rename, extraction, or type that makes the comment unnecessary. If that fix is unsafe or outside editable files, delete the comment only when the code stays understandable; otherwise keep it and report a reshape flag.

Suppressions in scope (`@ts-ignore`, `@ts-expect-error`, `eslint-disable`, `biome-ignore`, and similar): look up the suppressed rule. Keep suppressions for style-only or pedantic rules. If the rule protects correctness or safety, fix the code when the fix is safe and in scope; otherwise keep the suppression and report a reshape flag.

A reshape flag names the exact symbol, what is surprising or unsafe, and the suggested rename, extraction, type, or redesign. Flags must name code inside the scope and must not be invented.

Within the assigned scope, consider replacing an in-scope custom mechanism with an existing repository, standard-library, native-platform, or already-installed dependency capability. Make that replacement only when it meets the actual safety, correctness, accessibility, edge-case, and public-contract requirements. Do not widen editable files for it; if another file or new package research is needed, stop and report it.

For explicitly assigned dead-code, unused-export/dependency, or duplicate cleanup:

- Treat unused-code tool output as evidence, not proof.
- Establish non-use proof across every applicable surface before deletion: static references, imports, re-exports, and type-only use; dynamic or string imports, reflection, runtime loading, and plugin discovery; config, configuration, registration, and scripts; generated entry points, artifacts, and their generators; tests; and public exports or public-consumer APIs.
- Inspect history when intent or compatibility is unclear. If any static, dynamic, config, generated, or public-consumer evidence is incomplete, retain the candidate and report the uncertainty rather than deleting it.
- Classify only candidates with no applicable references as high confidence. Retain uncertain candidates involving reflection, plugin loading, external consumers, incomplete searches, or unclear compatibility.
- For dependency removal, perform dependency manifest/lockfile checks along with source imports, scripts, configuration, type-only use, peer/optional roles, and tooling use. Use the repository package-manager commands to keep manifests and lockfiles aligned; never hand-edit a lockfile. Do not claim production bundle reduction without measurement.
- Duplicate consolidation requires matching semantics, not textual similarity: verify supported inputs and edge cases, outputs, errors, side effects, ordering/state, configuration/runtime loading, public contracts, and all consumers. Choose the established, better-tested implementation and update consumers only when the contracts match.

Inspect the scoped diff first, make the smallest useful refinement, and run targeted validation after each logical batch. If cleanup breaks behavior, restore it and explain the hidden dependency rather than suppressing the failure.

## Audit

After editing, rerun the same status, rehash those paths, and diff editable files against their saved copies.

- Any path outside editable files whose status line changed or whose hash differs from the baseline is a scope escape: report those paths for the user, but never revert, restore, or trash paths outside editable files; you cannot prove who changed them.
- Also check your own diff for behavior changes, reshape flags that name code outside scope or misstate the problem, and deleted comments that meet the keep list.
- If the diff fails the audit, restore each saved copy inside editable files and move editable paths noted as not existing to Trash with `trash`. Then retry once with the failure named from the restored baseline. If the retry also fails, restore the baseline again and report the failure as open.
- Never use `git checkout`, `git restore`, `git reset`, or `git stash` push/pop/apply to revert /simplify results.

Report accepted changes, removed symbols/files/dependencies with non-use evidence, deleted comment count, reshape flags, retries, validation, anything retained because of uncertainty, and open risks.
