---
name: review-orchestration
description: Orchestrate compact multi-agent code reviews for /review. Use when reviewing uncommitted changes, branches, commits, pull requests, or folder snapshots.
---

# Review Orchestration

Orchestrate a code review with selected reviewer agents, then synthesize one final report.

## Reviewer agents

- `code-reviewer`: general correctness, maintainability, performance, and operational risk
- `security-reviewer`: auth, permissions, secrets, input handling, and unsafe trust boundaries
- `database-reviewer`: schema, queries, migrations, indexes, transactions, and RLS
- `performance-reviewer`: latency, throughput, memory, bundle size, rendering, and scalability regressions

## Orchestration contract

- Delegate to selected reviewer agents when useful.
- When delegating via the Agent tool, omit `max_turns` from reviewer Agent calls.
- Keep each reviewer focused on the reviewed change and relevant files only.
- Merge reviewer outputs into one final report.
- De-duplicate overlapping findings.
- Prefer the highest-confidence, highest-severity version of overlapping findings.
- Do not include speculative issues.
- Only report issues introduced by the reviewed change or directly exposed by it.
- Keep non-blocking human callouts separate from findings.
- Do not use pi task tools (`TaskCreate`, `TaskUpdate`, `TaskList`, `TaskExecute`, or `TaskOutput`) for review orchestration. Use reviewer Agent calls directly and synthesize the final report in this conversation.

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

## Required final output

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
