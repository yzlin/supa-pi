# Review extension

Read when changing `/review`, `/review-summary`, `/review-fix`, reviewer-agent orchestration, or review prompt contracts.

## `/review` reviewer orchestration

`/review` stays prompt-orchestrated. The extension builds a review prompt for the main agent, which then decides whether to delegate to the selected reviewer agents:

- `code-reviewer` for general correctness, maintainability, performance, and operational risk.
- `security-reviewer` for auth, permissions, secrets, input handling, and unsafe trust boundaries.
- `database-reviewer` for schema, queries, migrations, indexes, transactions, and RLS.
- `performance-reviewer` for latency, throughput, memory, bundle size, rendering, and scalability regressions.

Reviewer selection can be automatic or explicit. Auto-selection always includes `code-reviewer` and adds specialized reviewers based on changed paths, including `performance-reviewer` for performance-sensitive paths such as benchmarks, profiling, bundles, metrics, monitoring, load tests, and `.bench`/`.perf` files. Explicit `--reviewers` input limits orchestration to the requested reviewers.

When the prompt instructs the main agent to delegate reviewer work, reviewer calls use the Agent tool only and must not set `max_turns`. Reviews need enough turns for each reviewer to inspect relevant files, reason about the diff or snapshot, and return findings. If a reviewer is not useful for the selected scope, the orchestrating agent may skip that reviewer and mark it as not used in Reviewer Coverage.

The final `/review` response merges reviewer outputs into one report, de-duplicates overlapping findings, keeps non-blocking human callouts separate, and reports only issues introduced or directly exposed by the reviewed change.
