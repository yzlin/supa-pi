---
summary: "Remove the /review synthesizer stage; the verifier groups and verifies findings in one call and must account for every candidate ID."
read_when:
  - "Changing /review grouping, the verifier schema or prompt, rejected-candidate handling, or review model configuration."
---

# ADR 0004: Merged `/review` verifier

- Status: Accepted
- Date: 2026-10-30
- Deciders: Ethan
- Supersedes: none
- Superseded by: none

## Context

Before this change, `/review` ran two calls after the reviewer matrix:

1. `review-synthesizer` (no tools, default `openai-codex/gpt-6-luna`) clustered candidates. Every candidate ID had to occur in exactly one cluster.
2. `review-verifier` received the clusters and the original candidates, inspected code, and could split or merge clusters by `memberIds`. It rejected a candidate by leaving its ID out.

The report was built only from verifier output (`extensions/review/finalization.ts`). The synthesizer's lossless rule therefore protected only an intermediate step. The verifier could drop a candidate silently, and nothing recorded why.

A live A/B (`evals/prompt-optimization/corpus.json`, case `review-synthesis-verify`, `claude-code/claude-opus-5-5`, 3 repetitions per arm, 2026-10-30) used seven seeded candidates from three models: two duplicate pairs, one distinct finding, one same-file finding with a different fix, and one false positive. Both arms grouped and accepted correctly in all six runs. The merged verifier cost $0.106 vs $0.182 per run and took 24.9 s vs 37.2 s. The two-stage arm left the two rejected IDs unaccounted for in every run. The merged arm listed both with reasons.

## Decision

- `/review` makes one verifier call after the reviewer matrix. The verifier groups candidates (same root cause and materially the same fix) and verifies them.
- The verifier schema adds a required `rejected: [{id, reason}]`. Every candidate ID must occur exactly once across finding `memberIds` and `rejected`. Unknown, repeated, or omitted IDs fail review without a local repair (`extensions/review/portable-core.js`).
- `agents/review-synthesizer.md`, `synthesizerModel` config, `--synthesizer-model`, and `ReviewRawResult.synthesizerOutput` are removed. A config file that still has `synthesizerModel` fails validation as an unknown key. The flag fails with a removal message before any call.

## Consequences

The lossless guard now covers the final report, not an intermediate step, and every rejection has a recorded reason.

One model does both grouping and verification, so a grouping error is no longer cross-checked by a second model. The eval used one small case on one model; it did not test a large or noisy panel or the default Astra verifier.

Users with `synthesizerModel` in `~/.pi/agent/review.json` or a project `.pi/review.json` must delete the key. Raw results captured by an older build in a still-running review would fail finalization; reviews are not resumed across builds, so no migration is needed.
