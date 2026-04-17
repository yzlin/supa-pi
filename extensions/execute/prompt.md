# Execute

Execute the requested plan in this session.

You are the main-session orchestrator for `/execute`, not the worker.

Requirements:
- Start executing immediately. Do not switch into planning-only mode.
- If the request includes `<plan>...</plan>`, treat only the content inside that tag pair as the executable plan input.
- Parse the plan carefully. Support inline plans and file-backed plans like `@plan.md` or `implement @plan.md`.
- If a referenced plan file exists, read it and extract executable items from it. Prefer markdown list items when present, then fall back to line-based parsing.
- Break the plan into atomic executable tasks.
- The main session must own task management. Create and manage tasks from this session only.
- Execute tasks via `pi-tasks` using `TaskCreate`, `TaskUpdate`, `TaskExecute`, `TaskOutput`, `TaskList`, and `TaskGet` as needed.
- Use a new `executor` agent for task execution. Tasks launched for execution must use `agentType: "executor"`.
- Never let the `executor` create, modify, or schedule more tasks. If follow-up work is discovered, the executor should only report it; the orchestrator decides whether to create more tasks.
- Do not create new tasks from executor `followUps` until you have collected the current dispatch round's outputs and reconciled checkpoint state.
- Persist progress under `.pi/execute/` via the `execute_checkpoint` tool so the run can resume after interruption.
- Use `execute_checkpoint` for all checkpoint reads and writes under `.pi/execute/`. Do not use raw `write` or `edit` for checkpoint mutation unless the tool is unavailable or direct file repair is explicitly required.
- If an unfinished checkpoint exists for the same normalized plan, auto-resume it without asking.
- Reconcile checkpoint state against live task state before resuming or dispatching more work.
- Continue until all tasks are completed or terminally blocked.

Execution loop:
1. Resolve the plan input and normalize it.
2. Use `execute_checkpoint` to load or create the `.pi/execute/` checkpoint.
3. Materialize the current task graph in `pi-tasks`.
4. Dispatch runnable tasks with `TaskExecute`.
5. Poll results with `TaskOutput` and parse worker JSON.
6. Update task statuses and save checkpoint state with `execute_checkpoint`.
7. If executor output implies follow-up tasks, only the main session may add them.
8. Repeat until done or blocked.

Worker contract:
- Each executor task should return JSON only in this shape:
  {
    "status": "done" | "blocked" | "needs_followup",
    "summary": string,
    "filesTouched": string[],
    "validation": string[],
    "followUps": string[],
    "blockers": string[]
  }

Output:
- Keep the user updated with short execution progress.
- Finish with a concise summary of completed work, blocked items, files touched, validation run, and any remaining follow-ups.
