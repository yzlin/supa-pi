# Goal Extension

Goal Extension adds `/goal`, a checkpointed objective runner for Pi sessions.

## Commands

```text
/goal <objective>
/goal task --tasks N <objective>
/goal status
/goal statusbar
/goal pause
/goal resume
/goal clear
/goal stop
```

Options:

- `--tasks N` — required for task mode start. On `/goal resume`, adds N more task slots to a budget-limited task goal.
- `--max-attempts-per-task N` — task-mode retry budget per task. Defaults to `2`.
- `--max-runs N` — optional limit on agent runs, for both modes. One run is one prompt or continuation, counted at `agent_end`. When `runsUsed` reaches the limit, the goal becomes `budget_limited` and no continuation is queued. On `/goal resume`, adds N runs to the current limit (on a goal with no limit, it sets a limit of N more runs); a goal stopped by its run limit requires it. Without the flag, a goal has no run limit.
- `--checkpoint <path>` — parsed by the command layer for checkpoint-aware flows.
- `--dry-run` — parsed by the command layer for non-mutating previews.

`/goal <objective>` starts classic mode. It sends a continuation prompt that works toward the objective until the goal is complete or blocked.

`/goal task --tasks N <objective>` starts task mode. It creates `N` placeholder tasks and prompts the main-session orchestrator to dispatch executor tasks sequentially. Each assignment uses one blocking `subagent({agent: "executor", task, schema})` call with a self-contained task, exact write scope, and the six-field executor report schema (`status`, `summary`, `filesTouched`, `validation`, `followUps`, `blockers`). Executors submit through internal `StructuredOutput`; main reads the report from the "Validated StructuredOutput" JSON in the tool result (it opens `result.json` only when the result says the report was capped), independently inspects changes and runs current checks before recording success. Schema validity is not completion proof; the orchestrator updates the checkpoint, selects the next task, and stops when the goal is complete, blocked, or budget-limited.

Goal task mode uses only `goal_checkpoint`, not the `spec_log` tool or retired Task tools; main verifies each executor result as the execute Playbook describes. The existing goal budgets, statuses, and checkpoint model are unchanged. Child abort/parent shutdown cancels owned queued/active children; `/goal stop` itself still clears goal state without interrupting the turn (see below).

## Budgets

- Classic mode has no task budget. Either mode can have a run limit with `--max-runs N`; the checkpoint stores `runLimit` (`null` when unset) and `runsUsed`.
- Task mode requires `--tasks N` and stores it as `taskBudget`.
- Each task starts with `budget.maxAttempts` from `--max-attempts-per-task` and tracks `usedAttempts`. Tool calls are not counted; checkpoints that still hold `maxToolCalls` or `usedToolCalls` load with those fields dropped.
- A task or goal can become `budget_limited` when available attempts, task budget, or the run limit are exhausted.
- `goal_checkpoint` cannot change `runLimit` or `runsUsed`; only the extension counts runs. Checkpoints written before run limits existed load with no limit.
- The run limit counts agent runs, not model turns, tool calls, tokens, or cost. Nothing caps spend directly.

## Statuses

Goal statuses:

- `active`
- `paused`
- `blocked`
- `budget_limited`
- `complete`
- `cleared`

Task statuses:

- `pending`
- `active`
- `blocked`
- `budget_limited`
- `complete`

The status bar shows `goal:<status>` with task counts while a goal is active, paused, blocked, budget-limited, or complete. `clear` removes the status bar entry.

`/goal stop` is an alias for clearing the active goal. It clears Goal Extension state and status display after the command is handled, but it does not interrupt the current agent turn. Press Esc to interrupt the current turn immediately.

## Checkpoints

The extension writes checkpoints under:

```text
.pi/goal/<goalId>.json
```

Each checkpoint records:

- objective and normalized objective
- mode, status, current milestone, and task budget
- coarse plan, milestones, tasks, and executor summaries
- evidence ledger, candidate follow-ups, blocker state, and dirty git baseline

The `goal_checkpoint` tool is registered by the extension and added to active tools only while a goal is active or resumed. Use it when goal state changes. It persists status patches, milestone changes, coarse plans, candidate follow-ups, and blocker state. `currentMilestone` and `blockerState.reason` take plain strings; pass an empty string to clear one (stored as `null`). The schema has no `null` variants because `pi-claude-code` strips them.

## Safety notes

- Do not read/import/edit legacy `.pi/execute/` records or manage parent checkpoints from detached workers.
- Keep Goal Extension code isolated under `extensions/goal`; do not import from sibling extensions.
- Treat checkpoint files as local runtime state. Do not commit sensitive objectives, private notes, credentials, or raw logs.
- If task mode needs more work, return follow-up suggestions instead of scheduling tasks directly from an executor.

## Registration

Goal Extension is active when `package.json -> pi.extensions` includes:

```json
"./extensions/goal"
```

## Upstream attribution

Goal Extension is adapted from upstream `pi-goal` work. Preserve upstream attribution and license notices with copied or adapted material. Verify upstream `pi-goal` license terms before redistributing this extension outside this repo.
