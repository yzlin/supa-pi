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

For every call record immutable baseline/candidate revisions, provider and model ID, case fixture and expected result, raw assistant/tool events, normalized call, first-attempt success, malformed-call reason, actual file tree/hash, wrong mutation, unsafe mutation, confirmation event, token usage, and latency when available. Aggregate first-attempt success by arm and provider, then apply the interval rule in ADR 0001 with `evaluateGate` in `gate.ts`: fail on any unsafe candidate mutation or any provider with more regressed than improved pairs; otherwise the verdict is `better` (interval above 0), `non-inferior` (lower bound at or above −5 points), or `inconclusive` (lower bound below −5 points; blocks adoption). The old +5 point margin was below the run's detection floor.

Harder cases 21–28 (`cases.ts`) target the ceiling: a 300-row file with near-identical rows, three identical blocks, a CRLF multi-line insert, five separated hunks, tabs and trailing spaces, no final newline, a rename that must skip one file, and a block move. `cases.test.ts` pins each fixture's expected diff offline. No live run has scored them yet.

## Anthropic-only pilot (not the gate)

`bun evals/unified-edit-reliability/run.ts [--model provider/id] [--cases 01,02]` runs `cases.ts` through `pi -p --mode json` in fresh temp fixtures. Both arms load only the model's provider extension (`claude-code` or `claude-bridge`, mapped in `run.ts`; default model `claude-code/claude-sonnet-5-5`) and `extensions/tool-display`, with tools limited to read/edit/write; only `tools.edit.enabled` differs (baseline = Pi built-in edit, not the `7e4430c` worktree). Scoring is the exact final file tree plus edit-call errors; first-attempt success also requires at least one edit call in cases marked `requiresEdit`. Artifacts go to `runs/<timestamp>/` (gitignored). Cases 19 (move) and 20 (interactive delete) are omitted because print mode without bash cannot exercise them. Pilot cases 14, 15, and 18 do not match the gate definitions: 14 is a scoped edit that must succeed, 15 does not require an edit call, and 18 creates a new file, so none forces a tool rejection. Pilot 16 and 17 did not exercise the Codex dialect (see result below).

The pilot also prints the paired interval and a single-provider gate verdict; it is not the ADR gate. Its `unsafeMutation` is a proxy: a changed file that should stay unchanged, or a file that should not exist.

2026-10-16, `claude-bridge/claude-sonnet-5-5`, 18 cases × 2 arms: baseline 18/18, candidate 18/18 first-attempt success, zero failed edit calls in either arm. Candidate used the matching row operation in every edit case and never the Codex patch dialect. This is a ceiling result; it does not satisfy the gate's +5 point margin or provider coverage.

2026-10-24, `claude-code/claude-sonnet-5-5`, same 18 cases × 2 arms: baseline 18/18, candidate 18/18 first-attempt success, zero failed edit calls in either arm. Same ceiling caveat.

2026-11-09, `claude-code/claude-sonnet-5-5`, harder cases 21–28 × 2 arms (16 calls): every final file tree was correct in both arms. First-attempt success: baseline 8/8, candidate 7/8. The one miss was case 28 (move a block): the candidate read the file and rewrote it with `write`, not `edit`, so the `requiresEdit` rule failed it. Zero failed edit calls and zero unsafe mutations in either arm. Paired delta −12.5 pp, 95% CI [−37.5, +0.0] pp; pilot gate verdict `fail` (1 regressed, 0 improved pairs). One run per case cannot separate this from noise; it shows that a block move is where the candidate prefers a full rewrite. Cases 21–27 still hit the ceiling in both arms.

## Current blocker

Remaining gaps before the gate can run: the pilot baseline arm is the Pi built-in edit, not the `7e4430c` worktree; there is no OpenAI or Google model coverage; cases 19 (move) and 20 (interactive delete) are not exercised; the rejection paths for gate 14 (ambiguous match), 15 (no-op), and 18 (Add File collision) are untested; the Codex dialect for gate 16 (two hunks) and 17 (Add File) is untested; the 120-call paired run has not been done.
