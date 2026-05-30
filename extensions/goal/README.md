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
- `--checkpoint <path>` — parsed by the command layer for checkpoint-aware flows.
- `--dry-run` — parsed by the command layer for non-mutating previews.

`/goal <objective>` starts classic mode. It sends a continuation prompt that works toward the objective until the goal is complete or blocked.

`/goal task --tasks N <objective>` starts task mode. It creates `N` placeholder tasks and prompts the main-session orchestrator to dispatch executor tasks sequentially. Executors return strict JSON to the orchestrator; the orchestrator updates the checkpoint, selects the next task, and stops when the goal is complete, blocked, or budget-limited.

## Budgets

- Classic mode has no task budget.
- Task mode requires `--tasks N` and stores it as `taskBudget`.
- Each task starts with `budget.maxAttempts` from `--max-attempts-per-task` and tracks `usedAttempts` plus `usedToolCalls`.
- A task or goal can become `budget_limited` when available attempts or task budget are exhausted.

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

The `goal_checkpoint` tool is registered by the extension and added to active tools only while a goal is active or resumed. Use it when goal state changes. It persists status patches, milestone changes, coarse plans, candidate follow-ups, and blocker state.

## Safety notes

- Do not edit `.pi/execute/` progress files from task executors.
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
