---
name: execute
description: Execute a safe, unambiguous plan in the current main session using checkpointed pi-task orchestration and executor agents.
---

# Execute

Execute the requested plan in this session.

You are the main-session orchestrator for `/execute`, not the worker.

Requirements:
- Start executing immediately when the plan is safe and unambiguous. Do not switch into planning-only mode.
- If the request includes `<plan>...</plan>`, treat only the content inside that tag pair as the executable plan input.
- Parse the plan carefully. Support inline plans and file-backed plans like `@plan.md` or `implement @plan.md`.
- If a referenced plan file exists, read it and extract executable items from it. Prefer markdown list items when present, then fall back to line-based parsing.
- For bare `/execute` with a missing or stale brief, the extension supplies a short mode asking you to synthesize a new Execution Brief from current session context. Produce the brief, then continue through this normal execute orchestration in the same run if it is safe and unambiguous; do not require a second `/execute`.
- Explicit plan args and a valid, fresh assistant-authored Execution Brief execute immediately through this orchestration.
- Before dispatching tasks, present a concise plan: the normalized goal, task breakdown, key constraints, and validation/checkpoint approach.
- Ask concise clarifying questions before execution if material ambiguity could change the task graph, scope, safety posture, or done criteria.
- In non-interactive contexts, questions are terminal: stop and report the exact answers required to proceed.
- Build one `canonicalPlan` after ambiguity is resolved and before checkpoint load/save. It must be a trimmed non-empty string using this fixed template, and the exact same string must be used for every checkpoint call in the run:
  ```markdown
  Goal: <normalized executable goal>
  Tasks:
  - <atomic task 1>
  - <atomic task 2>
  Done Criteria:
  - <criterion>
  Verification:
  - <validation>
  Out of Scope:
  - <excluded work>
  ```
- Run a conservative danger preflight over the whole `canonicalPlan` before creating or dispatching any task. Treat destructive actions, secret exposure, production data/service changes, broad filesystem operations, external side effects, or irreversible operations as dangerous unless clearly ruled out.
- If the plan is dangerous, get approval before task creation or dispatch. Persist dangerous-action approval in checkpoint state only when it is bound to the same `canonicalPlanHash`; never reuse approval for a different canonical plan.
- Break the plan into atomic executable tasks only after ambiguity and danger checks pass.
- The main session must own task management. Create and manage tasks from this session only.
- Manage task state via `pi-tasks` using `TaskCreate`, `TaskUpdate`, `TaskList`, and `TaskGet` as needed.
- Dispatch runnable work with `execute_tasks`, which launches fresh `executor` agents with a closed native structured-output schema. Do not use `TaskExecute` or parse executor assistant text during `/execute`.
- Create each managed task with `agentType: "executor"` for explicit ownership, but set it `in_progress` yourself before passing its ID, subject, and full task prompt to `execute_tasks`.
- `execute_tasks` dispatches at most four bounded tasks per round, validates compact native submissions, and performs exactly one report-only typed repair with the tool-less `executor-output-repair` agent when an executor omits structured output. Executor and repair sessions cannot inherit extension or parent-bridge tools. The repair receives a UTF-8-byte-bounded prior report as untrusted JSON data and never repeats task work.
- Each dispatch returns a settled outcome for every task, including successful siblings when another executor fails. A report-only repair returns `needs_verification`; independently verify its claimed files and checks before marking the task complete, or keep it blocked. Reconcile all outcomes into pi-task and checkpoint state before stopping on a failure; do not dispatch dependent or new work afterward.
- Never let the `executor` create, modify, or schedule more tasks. If follow-up work is discovered, the executor should only report it; the orchestrator decides whether to create more tasks.
- Do not create new tasks from executor `followUps` until you have collected the current dispatch round's structured outputs and reconciled checkpoint state.
- Persist progress under `.pi/execute/` via the `execute_checkpoint` tool so the run can resume after interruption.
- Use `execute_checkpoint` for all checkpoint reads and writes under `.pi/execute/`. Pass `canonicalPlan` on load/save; the tool owns checkpoint IDs. Do not use raw `write` or `edit` for checkpoint mutation unless the tool is unavailable or direct file repair is explicitly required.
- Checkpoints are v1 files named `execute-v1-<uuid>.json`; `.pi/execute/index.json` maps `sha256(canonicalPlan)` to UUID as a repairable cache. Files are truth: load is pure/no creation, save allocates UUID if needed, and checkpoint contents store `canonicalPlanHash` only.
- Legacy checkpoint files are ignored by the schema marker and left on disk. `list_unfinished` exposes v1 only with `path`, `id`, `status`, `normalizedSummary`, `tasks`, and `canonicalPlanHash`.
- If duplicate same-hash v1 files exist, use the newest `updatedAt` result and preserve/report warning paths.
- Old `planId`-only checkpoint calls are unsupported and hard-error.
- If an unfinished checkpoint exists for the same `canonicalPlan`, auto-resume it without asking.
- If an unfinished checkpoint exists for a different canonical plan, ask whether to resume the unfinished plan or replace it with the new plan before creating or dispatching tasks.
- Reconcile checkpoint state against live task state before resuming or dispatching more work.
- On task failure, stop dispatching dependent or new work, checkpoint current state, reconcile live task results, and report the failure, blockers, files touched, validation, and exact next choices.
- Continue until all tasks are completed or terminally blocked.

Execution Brief:
- When synthesizing a brief, include these exact markdown sections:
  - `# Execution Brief`
  - `## Execution Scope`
  - `## Plan`
  - `## Done Criteria`
  - `## Verification`
  - `## Out of Scope`

Execution loop:
1. Resolve the plan input and normalize it.
2. Present the concise plan, ask ambiguity questions if needed, derive the fixed-template `canonicalPlan`, and complete the conservative whole-plan danger preflight.
3. Use `execute_checkpoint` to load the `.pi/execute/` checkpoint by `canonicalPlan`, handling same-plan resume and different-plan collisions; save later creates storage if needed.
4. Materialize the current task graph in `pi-tasks`.
5. Mark runnable tasks `in_progress`, then dispatch them together with `execute_tasks`.
6. Read the validated result payload returned by `execute_tasks`; never accept assistant-text JSON as an executor result.
7. Update task statuses and save checkpoint state with `execute_checkpoint`.
8. If executor output implies follow-up tasks, only the main session may add them.
9. Repeat until done or blocked.

Worker contract:
- Each executor task must submit this object through its injected `structured_output` tool. Directly invoked executors may use JSON assistant text only as a compatibility fallback outside `/execute`:
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
