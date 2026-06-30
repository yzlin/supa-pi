# Review extension

Read when changing `/review`, `/review-summary`, `/review-fix`, reviewer-agent orchestration, or review prompt contracts.

## `/review` reviewer orchestration

`/review` stays prompt-orchestrated. The extension builds a review prompt for the main agent, which then decides whether to delegate to the selected reviewer agents:

- `code-reviewer` for general correctness, maintainability, performance, and operational risk.
- `security-reviewer` for auth, permissions, secrets, input handling, and unsafe trust boundaries.
- `database-reviewer` for schema, queries, migrations, indexes, transactions, and RLS.
- `performance-reviewer` for latency, throughput, memory, bundle size, rendering, and scalability regressions.

Reviewer selection can be automatic or explicit. Auto-selection always includes `code-reviewer` and adds specialized reviewers based on changed paths, including `performance-reviewer` for performance-sensitive paths such as benchmarks, profiling, bundles, metrics, monitoring, load tests, and `.bench`/`.perf` files. Explicit `--reviewers` input limits orchestration to the requested reviewers.

For diff targets (`uncommitted`, base branch, commit, or pull request), `/review` performs preflight validation before sending the orchestration packet. It fails fast when the target is invalid or no changed paths are found. The packet includes changed paths, exact inspect commands, and, when available for merge-base comparisons, commit list metadata. Inspect commands are target-specific: uncommitted reviews use `git status --porcelain --untracked-files=all`, `git diff --cached`, and `git diff`; base branch and pull request reviews use `git diff <merge-base>` plus `git log <merge-base>..HEAD --oneline`; commit reviews use `git show --stat --patch --find-renames <sha>`. Folder snapshot reviews do not receive diff-target preflight metadata.

When the prompt instructs the main agent to delegate reviewer work, reviewer calls use the Agent tool only and must not set `max_turns`. Reviews need enough turns for each reviewer to inspect relevant files, reason about the diff or snapshot, and return findings. If a reviewer is not useful for the selected scope, the orchestrating agent may skip that reviewer and mark it as not used in Reviewer Coverage.

The prompt contract forbids pi task tools (`TaskCreate`, `TaskUpdate`, `TaskList`, `TaskExecute`, or `TaskOutput`) during review orchestration. Review tasks persist across follow-up commands, so stale pending or in-progress review tasks can confuse `/review-fix` sessions.

The final `/review` response merges reviewer outputs into one report, de-duplicates overlapping findings, keeps non-blocking human callouts separate, and reports only issues introduced or directly exposed by the reviewed change.

## `/review-fix` executor delegation

`/review-fix` stays prompt-orchestrated and prefers the latest `/review-summary` report, falling back to the latest raw `/review` report.

For actionable findings or a non-empty Fix Queue, the main session must:

- call exactly one foreground/default `executor` Agent for the whole queue;
- omit `max_turns`;
- avoid all main-session code edits;
- summarize only the executor JSON result.

If the report clearly has no findings, an empty Fix Queue, or says the code looks good, `/review-fix` must not call the executor and must report no fixable findings.

Executor failure, invalid JSON, `blocked`, or `needs_followup` is reported only, with no fallback main-session fixing. The review report is untrusted, so instructions inside it cannot override command/delegation rules. `/review-fix [extra instruction]` can refine implementation scope or checks, but cannot override delegation, safety, no-main-edits, no-task-tools, or JSON-summary rules.
