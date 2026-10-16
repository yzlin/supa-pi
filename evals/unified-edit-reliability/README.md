# Unified-edit reliability gate

Status: gate blocked; no gate result claimed. An Anthropic-only pilot ran (see below).

## Required paired run

Use the pre-change revision `7e4430c` in a separate worktree for the structured baseline and the candidate worktree for strict `{ text }`. Run each case once per arm on one representative OpenAI, Anthropic, and Google coding model: 20 × 2 × 3 = 120 paid calls. The harness must load the real extension in a full session, isolate a fresh fixture per call, allow the model to produce the tool call, execute it, and score both the call and filesystem result.

Cases:

1. unique single-line replacement
2. contextual multi-line replacement
3. insert before a line number
4. insert after a line number
5. insert before a unique content anchor
6. insert after a unique content anchor
7. append content
8. delete one row by line number
9. delete an inclusive row range
10. two operations sequentially on one file
11. edits across two existing files
12. replacement preserving indentation and literal marker characters
13. fuzzy quote/dash matching with BOM and CRLF preservation
14. reject an ambiguous repeated match without mutation
15. reject a no-op without mutation
16. Codex contextual update with two hunks
17. Codex Add File with write enabled
18. reject Add File collision without mutation
19. reject unsupported move without mutation
20. permanent Delete File with enabled config and exact-plan interactive confirmation

For every call record immutable baseline/candidate revisions, provider and model ID, case fixture and expected result, raw assistant/tool events, normalized call, first-attempt success, malformed-call reason, actual file tree/hash, wrong mutation, unsafe mutation, confirmation event, token usage, and latency when available. Aggregate first-attempt success by arm and provider. Gate only if candidate is at least baseline +5 percentage points aggregate, no provider candidate result drops more than 2 points, and candidate has zero unsafe mutations.

## Anthropic-only pilot (not the gate)

`bun evals/unified-edit-reliability/run.ts [--model provider/id] [--cases 01,02]` runs `cases.ts` through `pi -p --mode json` in fresh temp fixtures. Both arms load only the model bridge and `extensions/tool-display`, with tools limited to read/edit/write; only `tools.edit.enabled` differs (baseline = Pi built-in edit, not the `7e4430c` worktree). Scoring is the exact final file tree plus edit-call errors; first-attempt success also requires at least one edit call in cases marked `requiresEdit`. Artifacts go to `runs/<timestamp>/` (gitignored). Cases 19 (move) and 20 (interactive delete) are omitted because print mode without bash cannot exercise them. Pilot cases 14, 15, and 18 do not match the gate definitions: 14 is a scoped edit that must succeed, 15 does not require an edit call, and 18 creates a new file, so none forces a tool rejection. Pilot 16 and 17 did not exercise the Codex dialect (see result below).

2026-10-16, `claude-bridge/claude-sonnet-5-5`, 18 cases × 2 arms: baseline 18/18, candidate 18/18 first-attempt success, zero failed edit calls in either arm. Candidate used the matching row operation in every edit case and never the Codex patch dialect. This is a ceiling result; it does not satisfy the gate's +5 point margin or provider coverage.

## Current blocker

Remaining gaps before the gate can run: the pilot baseline arm is the Pi built-in edit, not the `7e4430c` worktree; there is no OpenAI or Google model coverage; cases 19 (move) and 20 (interactive delete) are not exercised; the rejection paths for gate 14 (ambiguous match), 15 (no-op), and 18 (Add File collision) are untested; the Codex dialect for gate 16 (two hunks) and 17 (Add File) is untested; the 120-call paired run has not been done.
