---
summary: "Historical upstream-companion execution and public-workflow review contracts, superseded by the repo-owned subagent runtime."
read_when:
  - "Interpreting historical @tintinweb/pi-subagents or @tintinweb/pi-tasks execution or review decisions."
  - "Comparing the repo-owned subagent, execute, or review runtime with the earlier upstream-companion design."
---

# Upstream-companion history

**Historical:** moved from `CONTEXT.md`. These sections are not active instructions. `CONTEXT.md` "Subagent replacement: repository implemented; live activation pending" supersedes them. For current behavior, read `extensions/subagent/README.md`, `extensions/execute/README.md`, and `extensions/review/README.md`.

## Upstream-native execution

**Historical:** this section records the earlier upstream-companion migration. The repository implementation supersedes its runtime, recovery, and cancellation contracts. See `extensions/execute/README.md` for the current execution ledger; the historical bullets are not active instructions.

- Standardize execution on `@tintinweb/pi-subagents` workflows and `@tintinweb/pi-tasks`, rather than preserving the fork's custom execution runtime. Load only one subagents implementation.
- Preserve explicit-plan and Execution Brief command behavior, ambiguity resolution, and dangerous-action approval.
- Main-session independent verification remains completion authority. Upstream structured output validates report shape, not code correctness. TDD becomes worker guidance rather than runtime-enforced trajectory proof.
- Permit parallel writes only for disjoint scopes; dependent work requires verified prerequisites. Safe local repair remains bounded to two attempts per original task lineage.
- Use upstream workflow journals for same-session resume, with current-state verification; retire execute-specific checkpoint recovery and automatic continuation. Existing `.pi/execute` records remain untouched, without automatic import or reuse. Cross-session automatic recovery is outside this target.
- Execute only in the session's target workspace; alternate-workspace dispatch is outside this target.

## Public-workflow review

**Historical:** these observations describe the earlier public-workflow implementation and inspected upstream 0.19.0 artifacts. The repo-owned review pipeline supersedes that runtime. Current publication uses private captured outputs, not public journals; see `extensions/review/README.md`. Historical validation does not certify the replacement or live activation.

- `/review` prepares one exact public `SubagentWorkflow` run after local configuration/trust/preflight, visible in the native Workflows UI. The main session submits a compact run-bound marker; the public Pi `tool_call` hook validates and expands it in memory to the authorized inline source, avoiding model regeneration of the full program. Repository-owned deterministic code validates reviewer coverage and lossless clustering between stages; model instructions do not replace these checks.
- `review_finalize({runId})` accepts no results or paths, binds observed public call/result/native completion, reads the complete bounded journal rather than previews, and checks target freshness before/after. Local finalization remains report authority: bind results to the prepared run, target, and model configuration; validate findings and derive provenance/support before rendering and persisting the existing report contract. Reject unknown, duplicate, already-finalized, cancelled, session-switched, or stale-target submissions.
- Preserve target selection, model configuration/trust and preflight, role-by-model coverage and concurrency limits, independent verification, and `/review-summary` and `/review-fix` integration. Reviewer jobs use awaited native parallel batches of at most four inside one workflow, retaining dispatch/result order. Reject unsupported `off` in preflight/preparation without changing saved configs; supported efforts pass through. Provider schemas explicitly type every enum, use singleton reviewer enums, and require notes arrays (local validation still allows omission).
- Use upstream schema retry only. Semantic validation failures receive no additional local repair; reviewer failures follow existing degraded-coverage rules, while invalid downstream stages fail review.
- Synthesizer tool isolation becomes upstream agent configuration rather than override-proof local enforcement. `/review cancel` invalidates report publication; native Workflows UI stops workers. Parent cancellation no longer guarantees worker termination.
- Interrupted reviews require a fresh invocation; workflow resume is outside this migration. The unused fork SDK dependency is removed. Setup does not detect or reject duplicate subagents runtimes; verify registration manually. Missing/incompatible journals fail closed; at most one report is published. No private upstream API adapter is used.
