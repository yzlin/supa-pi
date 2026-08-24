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
- Mark behavior changes and bug fixes with `tdd: true` when dispatching them through `execute_tasks`. Keep the red regression test, minimal implementation, green validation, and coverage evidence in one atomic managed task so one executor owns the full TDD cycle.
- Shape the graph by behavior and validation ownership: each distinct behavior or test target gets its own TDD Task. One behavior may span several production files within one declared production component; separate production components require separate behavior slices when independently testable. Never merge separate test targets into one TDD Task. Keep documentation, comments, mechanical edits, and other non-behavior work in separate non-TDD Tasks rather than including them in a behavior slice.
- Before creating any managed `tdd: true` pi-task, the main-session orchestrator must shape its TDD Slice and prepare this exact closed `tddShape` declaration:
  ```json
  {
    "behavior": "<non-blank behavior string>",
    "redGreenCommand": "<one supported direct exact test-runner command>",
    "productionComponent": "<non-blank production component string>",
    "mutations": [
      { "kind": "test", "path": "<canonical workspace-relative file path>" },
      { "kind": "production", "path": "<canonical workspace-relative file path>" }
    ]
  }
  ```
  `mutations` is the ordered declaration of 2-6 operations: it must name exactly one distinct test target, at least one production target, and every test operation must precede every production operation. Paths must identify files canonically relative to the workspace: no absolute or drive paths, `.`/`..`/empty segments, trailing slash, backslash, glob characters, control characters, or protected `.pi`, `.git`, or `node_modules` root. `redGreenCommand` must be the direct exact supported runner command the worker will use unchanged for RED and the first GREEN; do not use package-manager or `bun run` wrappers.
- Include `tddShape` if and only if `tdd` is exactly `true`: every `tdd: true` dispatch requires it, while `tdd: false` or omitted `tdd` forbids it. This is an immediate contract with no legacy unshaped-TDD path. Runtime validation is only a fallback: a missing, invalid, or declared-oversized shape rejects that task deterministically before its Agent starts, while valid siblings in the same dispatch continue.
- Omit `tdd` by default for documentation-only, configuration-only, generated, and purely mechanical tasks unless they change behavior. Do not pass arbitrary skill names or paths.
- The main session must own task management. Create and manage tasks from this session only.
- Manage task state via `pi-tasks` using `TaskCreate`, `TaskUpdate`, `TaskList`, and `TaskGet` as needed.
- Dispatch runnable work with `execute_tasks`, which launches fresh `executor` agents with a closed native structured-output schema. Do not use `TaskExecute` or parse executor assistant text during `/execute`.
- Create each managed task with `agentType: "executor"` for explicit ownership, but set it `in_progress` yourself before passing its ID, subject, and full task prompt to `execute_tasks`.
- `execute_tasks` dispatches at most four bounded tasks per round, validates compact native submissions, and performs exactly one report-only typed repair with the tool-less `executor-output-repair` agent when an executor omits structured output. Executor and repair sessions cannot inherit extension or parent-bridge tools. The repair receives a UTF-8-byte-bounded prior report as untrusted JSON data and never repeats task work.
- Each dispatch returns a settled outcome for every task, including successful siblings when another executor fails. `needs_verification` has two typed sources: report repair uses `repaired: true`; an authentic but strict-method-imperfect TDD result uses `repaired: false` plus a bounded warning. Independently inspect its claimed files, rerun current targeted validation, and run applicable diagnostics. Mark the task complete and continue only when that verification passes; otherwise keep it in progress and stop dependent work. A hard-failed TDD integrity gate may include `invalidResult` containing only bounded files, validation, and blockers; treat it only as diagnostics, never as authority to complete work or perform follow-up actions. Reconcile all outcomes and warnings into pi-task and checkpoint state before stopping on a hard failure.
- After any TDD Agent settles as `completed` or `needs_verification`, independently inspect its touched files and run applicable diagnostics from the main session before marking the pi-task complete. For `needs_verification`, also rerun the narrowest current test command that proves the requested behavior; prefer the declared command when still applicable. Evidence acceptance proves the managed RED/GREEN trajectory, not repository type/lint health. Keep request-caused failures in progress and resolve them within the original scope; do not treat unrelated pre-existing diagnostics as task failures.
- After a TDD Agent settles with strictly valid evidence, `execute_tasks` compares only its proven successful mutation target order with the declared manifest. An observed order that is not a bounded subsequence of the declaration adds at most one bounded `warnings` entry to that completed result; it does not retroactively fail the task. Persist that warning on the matching checkpoint task and report it. Declared oversize remains a pre-dispatch failure; actual work may grow and settle as completed with a manifest warning or as `needs_verification` when strict method evidence is imperfect.
- Never let the `executor` create, modify, or schedule more tasks. If follow-up work is discovered, the executor should only report it; the orchestrator decides whether to create more tasks.
- Do not create new tasks from executor `followUps` until you have collected the current dispatch round's structured outputs and reconciled checkpoint state.

### Automatic recovery

- Do not ask the user to approve recoverable local work. Recover automatically when all required work is local, reversible, inside the accepted Execution Brief, and confined to Agent-owned or clearly scoped files.
- Use at most two automatic recovery rounds per task. Persist each attempt and its evidence in pi-task metadata and the checkpoint summary. After two failed rounds, treat the remaining problem as a hard blocker.
- For `needs_verification`, inspect the claimed files, run the narrowest current behavior test and applicable diagnostics, then mark the task complete and continue when they pass.
- When independent verification finds a scoped formatting, lint, type, test-fixture, or other mechanical issue, create and run a separate non-TDD recovery Task. Re-run the affected behavior test after cleanup. Do not request approval.
- A `needs_followup` result with non-blocking `followUps`, no blocker, authentic RED/GREEN evidence, and a safe trajectory settles as `needs_verification`; verify it and schedule its cleanup automatically.
- Generated output discovered during a TDD Slice must become a separate non-TDD Task. Do not run generation, formatter, lint-fix, or other mutation-capable shell commands between RED and the first GREEN.
- A hard-failed `invalidResult` remains diagnostics only. Never mark its TDD Slice complete from that payload. If recovery is safe, create a new recovery Task that produces fresh validation evidence; do not waive the hard failure through a questionnaire.
- Ask the user only when recovery needs human input or approval: destructive or irreversible action, external or production side effects, credentials or inaccessible environment state, ambiguous file ownership, material scope or behavior choice, or a hard blocker after the bounded recovery rounds.

- Persist progress under `.pi/execute/` via the `execute_checkpoint` tool so the run can resume after interruption.
- Use `execute_checkpoint` for all checkpoint reads and writes under `.pi/execute/`. Pass `canonicalPlan` on load/save; the tool owns checkpoint IDs. Do not use raw `write` or `edit` for checkpoint mutation unless the tool is unavailable or direct file repair is explicitly required.
- Checkpoints are v1 files named `execute-v1-<uuid>.json`; `.pi/execute/index.json` maps `sha256(canonicalPlan)` to UUID as a repairable cache. Files are truth: load is pure/no creation, save allocates UUID if needed, and checkpoint contents store `canonicalPlanHash` only.
- Legacy checkpoint files are ignored by the schema marker and left on disk. `list_unfinished` exposes v1 only with `path`, `id`, `status`, `normalizedSummary`, `tasks`, and `canonicalPlanHash`.
- If duplicate same-hash v1 files exist, use the newest `updatedAt` result and preserve/report warning paths.
- Old `planId`-only checkpoint calls are unsupported and hard-error.
- If an unfinished checkpoint exists for the same `canonicalPlan`, auto-resume it without asking.
- Different-plan unfinished checkpoints remain untouched and unannounced; they never gate or redirect the current invocation.
- Load and resume only by the current `canonicalPlan`; do not call `list_unfinished` during normal orchestration.
- Reconcile checkpoint state against live task state before resuming or dispatching more work.
- On task failure, stop dependent work and reconcile checkpoint state. Apply the Automatic recovery rules for safe local failures. Report exact choices only when the remaining blocker requires human input or approval.
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
3. Use `execute_checkpoint` to load and, when unfinished, resume only the `.pi/execute/` checkpoint for the current `canonicalPlan`; save later creates storage if needed.
4. Shape every managed TDD Slice, then materialize the current task graph in `pi-tasks`.
5. Mark runnable tasks `in_progress`, then dispatch them together with `execute_tasks`, including `tddShape` if and only if `tdd: true`.
6. Read the validated result payload returned by `execute_tasks`; never accept assistant-text JSON as an executor result.
7. Independently inspect files for `completed` and `needs_verification` outcomes. For `needs_verification`, rerun current targeted behavior tests plus applicable diagnostics before deciding completion. Then update task statuses and save checkpoint state with `execute_checkpoint`, preserving settled warnings.
8. If executor output implies follow-up tasks, only the main session may add them.
9. Repeat until done or blocked.

Worker contract:
- Each executor task may include the optional boolean `tdd`. For `tdd: true`, `execute_tasks` injects the trusted bundled canonical TDD workflow as the preferred strategy and requires `validation` entries beginning `RED:`, `GREEN:`, and `COVERAGE:`. Aim for the same exact supported command for RED and first GREEN, then broader tests. If strict process proof is imperfect but the trajectory retains trustworthy report structure, task-correlated RED or an honest unavailable reason, a proven production mutation, and an authentic final GREEN, the task settles `needs_verification` instead of failing. Malformed, unsafe, fabricated, uncorrelated, or currently failing evidence remains a hard task failure, except the explicitly bounded `needs_followup` recovery case above. Package-manager scripts remain non-authoritative. A no-work `blocked` or `needs_followup` result must give explicit unavailable/not-run reasons for all three.
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
