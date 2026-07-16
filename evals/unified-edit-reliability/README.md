# Unified-edit reliability gate

Status: blocked; no paid calls made and no gate result claimed.

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

## Current blocker

The repository has prompt-component evaluation only (`scripts/eval-prompts.ts`); it has no full-session, extension-capable paired edit harness or scorer that preserves the baseline worktree and validates actual filesystem outcomes. No OpenAI, Anthropic, Google, or Gemini credential variables are available in this worker environment. Therefore model IDs and 120-call evidence cannot be produced here without fabricating results.
