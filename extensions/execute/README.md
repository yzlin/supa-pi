---
title: execute extension behavior
read_when:
  - changing /execute command behavior
  - documenting Execution Brief or execute orchestration behavior
status: active
---

# `/execute` extension

`/execute` sends an execution packet to the main Pi session. An explicit `/execute` invocation is the user's opt-in and authorizes the main session to call native `SubagentWorkflow` for that accepted plan. The main session owns the plan, safety decisions, `pi-tasks` state, workflow invocation, and final verification.

## Command behavior

- `/execute <plan>` sends the trimmed plan immediately inside `<plan>...</plan>`.
- Bare `/execute` reuses the most recent assistant-authored message containing `# Execution Brief`, unless a later user message makes it stale.
- If no usable brief exists, bare `/execute` asks the assistant to synthesize one and continue in the same run when safe and unambiguous.
- When the session is busy, the same packet is queued as a follow-up and the user is notified.

The command does not register an execution tool, read `.pi/execute`, maintain custom checkpoints, or run a private orchestration runtime.

## Execution Brief contract

A reusable brief contains these exact headings:

```markdown
# Execution Brief
## Execution Scope
## Plan
## Done Criteria
## Verification
## Out of Scope
```

## Native orchestration

The canonical procedure is [`skills/execute/SKILL.md`](../../skills/execute/SKILL.md). It preserves:

- explicit plans and Execution Brief synthesis;
- concise plan presentation and ambiguity questions;
- conservative danger preflight and explicit approval before consequential work;
- main-session ownership of upstream `@tintinweb/pi-tasks` tasks and dependencies;
- upstream `@tintinweb/pi-subagents` `SubagentWorkflow` scripts for bounded worker dispatch;
- native `StructuredOutput` schemas for worker report shape only;
- same-session upstream workflow-journal resume with live task and workspace verification; a parent/main-session stop does not cancel a background workflow, and after a user stop `/agents` → `Workflows` is the user-controlled stop surface with no automatic resume or dispatch;
- `null` or missing worker results remain attached to their originating unresolved task with blocker metadata rather than being dropped; `pi-tasks` has no `blocked` status, so terminal blockers retain `pending` or `in_progress` task status;
- main-session inspection, tests, and diagnostics as completion authority; and
- bounded, metadata-tracked repair for safe local failures.

Workers use the `executor` agent definition. Behavior changes and bug fixes receive `skills/tdd-workflow/SKILL.md` as guidance, but TDD trajectory capture and evidence enforcement are not part of the runtime. Independent writes may run together only when their scopes are disjoint; dependent work waits for verified prerequisites.

There is no compatibility path for the retired custom execution tools or for legacy `.pi/execute` state. Existing files are left untouched and are not imported or migrated.
