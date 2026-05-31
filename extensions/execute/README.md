---
title: execute extension behavior
read_when:
  - changing /execute command behavior
  - documenting Execution Brief or execute orchestration behavior
status: active
---

# `/execute` extension

`/execute` starts main-session task orchestration from an explicit plan or from an assistant-authored Execution Brief.

## Command behavior

- `/execute <plan>` executes immediately. The extension wraps the trimmed args in `<plan>...</plan>` and sends the execute prompt.
- Bare `/execute` reuses the most recent valid assistant message titled `# Execution Brief`, unless a newer user message appears after it.
- If no usable brief exists, bare `/execute` asks the assistant to synthesize a new Execution Brief from current session context. It must not implement yet.
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

## Confirmation behavior

Bare `/execute` with a missing or stale brief produces the brief for review only. The user confirms by running `/execute` again after the assistant emits the valid brief. Explicit args need no brief confirmation and execute immediately.
