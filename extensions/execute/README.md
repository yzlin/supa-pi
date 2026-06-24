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

- `/execute <plan>` executes immediately. The extension sends a concise execute-skill invocation packet and wraps the trimmed args in `<plan>...</plan>`.
- Bare `/execute` reuses the most recent valid assistant message titled `# Execution Brief`, unless a newer user message appears after it.
- If no usable brief exists, or the last brief is stale, bare `/execute` sends a concise mode line asking the assistant to synthesize a new Execution Brief from current session context and then continue through normal execute orchestration in the same run if safe and unambiguous. No second `/execute` is required.
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

Canonical orchestration workflow: `../../skills/execute/SKILL.md`. It instructs the main-session orchestrator to:

- present a concise plan before dispatching executor tasks;
- ask concise ambiguity questions before execution when the answer could change scope, safety, task breakdown, or done criteria;
- stop in non-interactive contexts and report the exact answers required to proceed instead of guessing;
- run a conservative whole-plan danger preflight before creating or dispatching any task;
- derive one fixed-template `canonicalPlan` from the normalized executable plan and pass that exact trimmed non-empty string to every `execute_checkpoint` load/save;
- checkpoint progress under `.pi/execute/` with `execute_checkpoint` and stop/checkpoint/report on task failure;
- auto-resume an unfinished checkpoint for the same `canonicalPlan` hash;
- ask whether to resume or replace when a different unfinished v1 checkpoint exists;
- persist dangerous-action approval only when bound to the same `canonicalPlanHash`; never reuse approval for a different canonical plan.

## Checkpoint storage

`execute_checkpoint` owns checkpoint identity and storage:

- callers provide `canonicalPlan`, not checkpoint IDs; old `planId`-only load/save calls hard-error;
- the checkpoint hash is `sha256(canonicalPlan.trim())`, so the same canonical plan resumes the same checkpoint;
- checkpoint files are `.pi/execute/execute-v1-<uuid>.json`; `.pi/execute/index.json` maps `canonicalPlanHash` to UUID as a repairable cache;
- checkpoint files are the source of truth: load is pure and does not create files, while save allocates the UUID when needed;
- v1 checkpoint files store `canonicalPlanHash`, not the canonical plan text;
- legacy checkpoint files are ignored by the v1 schema marker and left on disk;
- duplicate v1 files for the same hash use the newest `updatedAt` and return warning paths;
- `list_unfinished` returns v1 checkpoints only with `path`, `id`, `status`, `normalizedSummary`, `tasks`, and `canonicalPlanHash`.
