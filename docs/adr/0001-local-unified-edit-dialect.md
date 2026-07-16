# ADR 0001: Local unified-edit dialect

- Status: Proposed; deterministic implementation complete, live reliability gate pending
- Date: 2026-07-14

## Context

Tool-display previously exposed classic `path`/`oldText`/`newText`, batch `multi`/`edits`, and patch bridge schemas. We want one model-facing edit contract without changing the separate `write` tool.

The parser, planner, matcher, and migration logic are ported from Armin Ronacher and contributors' Apache-2.0 [`mitsuhiko/agent-stuff`](https://github.com/mitsuhiko/agent-stuff) `extensions/unified-edit.ts`, pinned to immutable commit [`4bce45560fa55ace2f5dc8634a63a2af464ddc8b`](https://github.com/mitsuhiko/agent-stuff/commit/4bce45560fa55ace2f5dc8634a63a2af464ddc8b). This is a local dialect, not a claim of full upstream or Codex compatibility.

## Decision

- The candidate local `edit` override is default-off while the live reliability gate is pending, leaving Pi's built-in edit available by default. Explicit config may enable the candidate for evaluation or deliberate local use.
- `text` accepts selected row grammar: repeated `[path]` sections with `@INS.PRE`, `@INS.POST`, `@INS.BEFORE`, `@INS.AFTER`, `@APPEND`, `@REPLACE`, and `@DEL`; or Codex-style Add/Update/Delete patches. Moves are rejected.
- Keep `write` unchanged and separately registered. Add File through edit requires `write` to be enabled.
- Pi `prepareArguments` normalizes upstream raw strings and single `text`/`patch`/`input`/`content` aliases. Retired classic, `multi`, and `edits` calls are rejected. New callers must emit `{ text }`.
- Make the strict `{ text: string }` schema, with no `reasoning` field or other public properties, the default only after the live reliability gate passes; do not run both public edit schemas indefinitely.

## Local safety deviations

Planning reads all targets before mutation. Ambiguous fuzzy matches, overlapping/canonical-alias targets, no-ops, add collisions, and unsupported moves fail. Source snapshots are revalidated under canonical per-file mutation locks before any write. Adds use exclusive creation. The implementation does not promise filesystem transactionality after mutation begins.

The candidate edit override defaults to disabled, and permanent delete remains disabled even when the candidate is enabled. Scalar config precedence is defaults, then `~/.pi/agent/tool-display.json`, then project `.pi/tool-display.json`. When enabled, delete still requires one TUI/RPC confirmation containing the exact deleted paths and complete planned diff. JSON and print modes reject delete. Any stale snapshot aborts under locks.

## Rendering

Completed edit output renders the actual execution diff when it fits the preview ceiling. Oversized non-delete diffs are omitted without rejecting the edit. Delete confirmation requires the complete planned diff and fails before prompting if that diff exceeds the ceiling. Expanded completed arguments may asynchronously show a planned preview; partial arguments are not parsed, stale previews are discarded, and final execution details supersede previews.

## Limits

Hard ceilings bound payload bytes/lines, operation count, target bytes/lines, aggregate staged bytes, matcher comparisons, rendered diff bytes/lines, canonicalization path work, and mutation queue depth. These are safety limits, not a compatibility promise.

## Migration

Retire direct classic/patch schema tests, dead bridge execution code, and local legacy argument migration. Preserve parser/planner/execution tests and upstream-compatible `prepareArguments` normalization. Preserve exported `resolveToCwd` and `withFileMutationQueue` because `write` and registration use them.

## Evaluation gate

Before hard cutover, run 20 representative full-session edit cases against the pre-change structured baseline and candidate `{ text }` contract on one representative OpenAI, Anthropic, and Google coding model: 20 cases × 2 arms × 3 providers = 120 paid calls. Score actual safe file outcomes and first-attempt success; record malformed calls, wrong/unsafe mutations, model IDs, cases, usage, latency, and raw artifacts. Candidate must beat baseline by at least 5 aggregate percentage points, no provider may drop more than 2 points, and candidate must have zero unsafe mutations. Missing credentials, provider access, cost approval, baseline worktree, or a full-session extension-capable harness blocks the gate; results must never be inferred or fabricated.

## Upstream sync policy

There is no automatic sync. Maintainers manually review upstream changes against the pinned commit, port only intentional pieces, preserve Apache-2.0 notices, rerun deterministic tests and the live gate when model-facing behavior changes, and update this ADR and the pin together.
