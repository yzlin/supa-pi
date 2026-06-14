---
title: execute extension behavior
read_when:
  - changing /execute command behavior
  - documenting Execution Brief or execute orchestration behavior
status: active
---

# `/execute` extension

`/execute` starts main-session task orchestration from an explicit plan or from an assistant-authored Execution Brief. The orchestrator should produce a concise plan, resolve ambiguity and danger, then run.

## Command behavior

- `/execute <plan>` executes immediately. The extension wraps the trimmed args in `<plan>...</plan>` and sends the execute prompt.
- Bare `/execute` reuses the most recent valid assistant message titled `# Execution Brief`, unless a newer user message appears after it.
- If no usable brief exists, or the last brief is stale, bare `/execute` asks the assistant to synthesize a new Execution Brief from current session context and then continue through normal execute orchestration in the same run if safe and unambiguous. No second `/execute` is required.
- Explicit plan args and valid, fresh assistant-authored briefs execute immediately through orchestration.
- When the agent is busy, `/execute` queues the same message as a follow-up and notifies the user.

## Execution Brief contract

A usable brief must be assistant-only and include these exact markdown headings:

```markdown
# Execution Brief
## Execution Scope
## Plan
## Done Criteria
## Verification
## Out of Scope
```

User-authored briefs are not accepted as reusable briefs. Any user message after the last assistant brief makes that brief stale, so bare `/execute` synthesizes a fresh brief instead.

## Orchestration behavior

The execute prompt instructs the main-session orchestrator to:

- present a concise plan before dispatching executor tasks;
- ask concise ambiguity questions before execution when the answer could change scope, safety, task breakdown, or done criteria;
- stop in non-interactive contexts and report the exact answers required to proceed instead of guessing;
- run a conservative whole-plan danger preflight before creating or dispatching any task;
- checkpoint progress under `.pi/execute/` with `execute_checkpoint` and stop/checkpoint/report on task failure;
- auto-resume an unfinished checkpoint for the same normalized plan;
- ask whether to resume or replace when a different unfinished plan checkpoint exists;
- persist dangerous-action approval in checkpoint state only for the same plan checkpoint and planId/fingerprint; never reuse approval for a different normalized plan.
