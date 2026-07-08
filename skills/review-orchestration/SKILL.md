---
name: review-orchestration
description: Orchestrate compact multi-agent code reviews for /review. Use when reviewing uncommitted changes, branches, commits, pull requests, or folder snapshots.
---

# Review Orchestration

Review the requested change with selected reviewer agents. In the current `/review` implementation, the extension performs direct pi-subagents orchestration and renders the final Markdown report from validated JSON.

## Reviewer agents

- `code-reviewer`: general correctness, maintainability, performance, and operational risk
- `security-reviewer`: auth, permissions, secrets, input handling, and unsafe trust boundaries
- `database-reviewer`: schema, queries, migrations, indexes, transactions, and RLS
- `performance-reviewer`: latency, throughput, memory, bundle size, rendering, and scalability regressions

## Direct workflow contract

- Treat the `/review` invocation packet as the canonical review contract.
- For diff targets, use the packet's changed paths, exact inspect commands, and commit list metadata to inspect the reviewed change; do not expect full diff output in the packet.
- For folder snapshots, review the snapshot basis without diff-target preflight metadata.
- When invoked as a selected reviewer agent, do not delegate to other reviewers; inspect only your assigned concerns and return the JSON schema requested by the prompt.
- The extension validates reviewer JSON, performs one repair retry on invalid JSON, merges nearby duplicate candidates, and prefers the highest-severity candidate before verifier review.
- `review-verifier` independently inspects changed code/cited locations before accepting candidates; low-confidence verifier findings are filtered from the rendered report.
- If reviewer agents return no findings, the extension skips `review-verifier` and renders a compatible “Code looks good” report.
- Human reviewer callouts come deterministically from reviewer outputs and stay separate from findings; verifier callouts are ignored.
- Do not include speculative issues.
- Only report issues introduced by the reviewed change or directly exposed by it.
- Keep non-blocking human callouts separate from findings.
- Do not use pi task tools (`TaskCreate`, `TaskUpdate`, `TaskList`, `TaskExecute`, or `TaskOutput`) for review orchestration. If manually orchestrating outside the extension workflow, use reviewer Agent calls directly and synthesize the final report in this conversation.

## Review guidelines

Flag issues that meaningfully impact accuracy, performance, security, or maintainability; are discrete and actionable; were introduced in the reviewed change; and the author would likely fix if aware.

Be especially careful with untrusted input, redirects, SQL parameterization, server-side fetches, escaping, migrations, dependency churn, auth/permissions, compatibility, destructive operations, back pressure, operational risk, and error checks against stable identifiers.

Prefer fail-fast error handling. Flag catch blocks that hide failure signals, return fake success, swallow parse failures, or recover locally without boundary-level justification.

## Finding style

- Be clear, brief, and matter-of-fact.
- Keep code snippets under 3 lines.
- Use suggestion blocks only for concrete replacement code.
- State scenario/environment where the issue occurs.
- Do not flag trivial style issues unless they obscure meaning or violate documented standards.
- Do not generate a full PR fix.

## Reviewer JSON output

When the prompt requests JSON, return only that JSON object with:

- `reviewer`
- `verdict`: `correct` or `needs attention`
- `findings`: prioritized `P0`..`P3` findings with `title`, `file`, `line`, `why`, and `change`
- `humanReviewerCallouts`: non-blocking callouts only
- `notes`

## Manual final report shape

If running review orchestration manually instead of through the extension, synthesize this Markdown shape:

## Review Scope
- what was reviewed
- selected reviewer agents
- diff basis or snapshot basis

## Verdict
- correct
- needs attention

## Findings
For each finding, include:
- `[P0]`..`[P3]` and short title
- File location (`path/to/file.ext:line`)
- Source reviewer (`code-reviewer`, `security-reviewer`, `database-reviewer`, or `performance-reviewer`)
- Verifier opinion (`accepted (high|medium) — <one-sentence evidence reason>`) for verified findings
- Why it matters
- What should change

If there are no qualifying findings, explicitly state the code looks good.

## Human Reviewer Callouts (Non-Blocking)
Include only applicable callouts.

## Reviewer Coverage
- code-reviewer: used / not used
- security-reviewer: used / not used
- database-reviewer: used / not used
- performance-reviewer: used / not used
