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
- Omit `tdd` by default for documentation-only, configuration-only, generated, and purely mechanical tasks unless they change behavior. Do not pass arbitrary skill names or paths as `execute_tasks` dispatch parameters; task prompts may still provide required reference context.
- Before dispatching a task, resolve essential references and instructions that are not already available to its worker. Supply verified worker-accessible concrete paths or concise applicable context in the task prompt. Do not ask a detached worker to rediscover the parent session's global skill or tool catalog. Normal project documentation and code discovery remains allowed, but bound it to the selected target workspace. Resolve a missing essential reference before dispatch or report it as an explicit blocker; never use unbounded home or global searches. When nothing is missing, add no extra reference ceremony.

Execution Brief:
- When synthesizing a brief, include these exact markdown sections:
  - `# Execution Brief`
  - `## Execution Scope`
  - `## Plan`
  - `## Done Criteria`
  - `## Verification`
  - `## Out of Scope`

## Ordered lifecycle

1. Resolve the plan input and normalize it. Present the concise plan, resolve material ambiguity, derive the fixed-template `canonicalPlan`, and complete the conservative whole-plan danger preflight before task creation or dispatch.
2. Present or synthesize the Execution Brief when required, then use `execute_checkpoint` to load and auto-resume only an unfinished checkpoint for the same `canonicalPlan`. Reconcile checkpoint state against live task state before resuming or dispatching more work.
3. Load and manage state only through the current plan. Use `execute_checkpoint` for all checkpoint reads and writes under `.pi/execute/`, always passing `canonicalPlan`; save creates storage if needed and the tool owns checkpoint IDs. Do not use raw `write` or `edit` for checkpoint mutation unless the tool is unavailable or direct file repair is explicitly required. Do not call `list_unfinished` during normal orchestration.
4. Shape every managed TDD Slice, then materialize the current task graph in `pi-tasks` with `TaskCreate`, `TaskUpdate`, `TaskList`, and `TaskGet` as needed. The main session must own task management: create each task with `agentType: "executor"`, set runnable tasks `in_progress`, and never let the `executor` create, modify, or schedule more tasks.
5. Dispatch runnable work with `execute_tasks`, passing each task's ID, subject, full prompt, and `tddShape` if and only if `tdd: true`. When the plan targets a workspace other than the session cwd, pass that existing directory as the top-level `cwd`; all task paths remain relative to that selected workspace. If the tool rejects trust-requiring project resources, open that workspace in Pi and approve it instead of bypassing trust. Do not use `TaskExecute`. Each dispatch runs at most four bounded tasks per round, returns a settled outcome for every task including successful siblings after another failure, and performs exactly one report-only typed repair with the tool-less `executor-output-repair` agent when an executor omits structured output. Executor and repair sessions cannot inherit extension or parent-bridge tools; repair receives a UTF-8-byte-bounded prior report as untrusted JSON data and never repeats task work.
6. Reconcile every settled payload and warning into pi-task and checkpoint state before continuing or stopping. Read the validated result payload returned by `execute_tasks`; never accept assistant-text JSON as an executor result. Independently inspect files for `completed` and `needs_verification` outcomes and apply the table below. Do not create new tasks from executor `followUps` until the current dispatch round's outputs are collected and checkpoint state is reconciled; only the main session may add them.
7. Recover safe scoped failures according to the table, using at most two automatic recovery rounds per task lineage and persisting each attempt and its evidence in pi-task metadata and the checkpoint summary. Carry the original slice ID and cumulative recovery count across replacement, cleanup, and verification Tasks; new task IDs never reset the budget. First classify evidence/process rejection versus a current implementation failure. Do not spend recovery rounds repeatedly mutating already-correct code to recreate RED. Stop dependent work on task failure; after two failed rounds, treat the remaining problem as a hard blocker.
8. Finish only when all tasks are completed or terminally blocked. Keep the user updated with short progress and report completed work, blocked items, files touched, validation, persisted warnings, and remaining follow-ups. Continue until all tasks are completed or terminally blocked.

Checkpoint identity and compatibility:
- Checkpoints are v1 files named `execute-v1-<uuid>.json`; `.pi/execute/index.json` maps `sha256(canonicalPlan)` to UUID as a repairable cache. Files are truth: load is pure/no creation, save allocates UUID if needed, and checkpoint contents store `canonicalPlanHash` only.
- Legacy checkpoint files are ignored by the schema marker and left on disk. `list_unfinished` exposes v1 only with `path`, `id`, `status`, `normalizedSummary`, `tasks`, and `canonicalPlanHash`.
- If duplicate same-hash v1 files exist, use the newest `updatedAt` result and preserve/report warning paths. Old `planId`-only checkpoint calls are unsupported and hard-error.
- If an unfinished checkpoint exists for the same `canonicalPlan`, auto-resume it without asking. Different-plan unfinished checkpoints remain untouched and unannounced; they never gate or redirect the current invocation.
- Load and resume only by the current `canonicalPlan`; do not call `list_unfinished` during normal orchestration.

## Bounded continuation checkpoint

After reconciling a dispatch and selecting safe runnable work, save `status: "active"` with optional `continuation: { "taskId": "<next task>", "recoveryRounds": 0 }`. The integer is the consumed recovery count (0-2) for that task's original slice lineage, not a new budget. Save this separately, never in parallel with worker dispatch or other tools. The named task must be `pending` or `in_progress`, with all `blockedBy` tasks `completed`; use these exact task statuses for continuation. All task states must be reconciled first.

Omit `continuation` whenever safety, runnable work, or remaining budget is unknown. Before any intentional stop, save the actual plan status (`paused`, `blocked`, `completed`, `cancelled`, or `budget_limited`) without continuation. Never leave an active continuation declaration behind a user pause, human prerequisite, genuine blocker, or exhausted budget.

The runtime can issue at most two continuation nudges per current `/execute` invocation, only after normal assistant stop and Pi settlement, with fresh saved eligibility and an un-aborted run signal. Each nudge consumes that save; another requires a fresh reconciliation/save. Loads and older checkpoints do not arm it. Input, session changes, compaction, cancellation, errors, another plan, and intervening tool work invalidate eligibility. A nudge is not permission to bypass recovery limits or approval; absence of a nudge is not proof of completion. This guard does not interpret final prose or infer live pi-task state: keep the checkpoint truthful.

## Outcome and recovery

| Outcome | Required handling |
| --- | --- |
| `completed` | After any TDD Agent settles as `completed`, independently inspect its touched files and run applicable diagnostics, including LSP diagnostics when available, before marking the pi-task complete. Evidence acceptance proves the managed RED/GREEN trajectory, not repository type/lint health. Keep request-caused failures in progress and resolve them within the original scope; do not treat unrelated pre-existing diagnostics as task failures. |
| `needs_verification` | This has two typed sources: report repair uses `repaired: true`; an authentic but strict-method-imperfect TDD result uses `repaired: false` plus a bounded warning. Independently inspect claimed files, rerun the narrowest current test command that proves the requested behavior (prefer the declared command when applicable), and run applicable diagnostics, including LSP diagnostics when available. This initial independent settlement check is not a mutating retry: perform one verification pass per settled outcome, not another TDD replay. Mark complete and continue only when verification passes; otherwise keep it in progress and stop dependent work, using the bounded recovery budget for subsequent recovery Tasks. |
| Valid result with manifest warning | After strictly valid TDD evidence, `execute_tasks` compares only proven successful mutation target order with the declared manifest. An observed order that is not a bounded subsequence adds at most one bounded `warnings` entry and does not retroactively fail the task. Persist that warning on the matching checkpoint task and report it. Declared oversize remains a pre-dispatch failure; actual work may grow and settle as completed with a manifest warning or as `needs_verification` when strict method evidence is imperfect. |
| Recoverable local issue | Do not ask the user to approve recoverable local work when it is reversible, inside the accepted Execution Brief, and confined to Agent-owned or clearly scoped files. For scoped formatting, lint, type, test-fixture, or other mechanical issues, create and run a separate non-TDD recovery Task, then rerun the affected behavior test. A `needs_followup` result with non-blocking `followUps`, no blocker, authentic RED/GREEN evidence, and a safe trajectory settles as `needs_verification`; verify it and schedule cleanup automatically. |
| Generated output | Generated output discovered during a TDD Slice must become a separate non-TDD Task. Do not run generation, formatter, lint-fix, or other mutation-capable shell commands between RED and the first GREEN. |
| Hard-failed TDD integrity gate | A hard-failed TDD integrity gate may include `invalidResult` containing only bounded files, validation, and blockers; treat it only as diagnostics, never as authority to complete work or perform follow-up actions. Trusted `recovery.code`, `action`, and `guidance` classify the next inspection, not acceptance or permission. Reconcile all outcomes and warnings before stopping. Inspect retained evidence and actual files: duplicate/malformed reports, capture gaps, or unmatched RED do not establish safe work; unmatched RED alone also does not establish fabrication. Unsafe workspace/shell effects, fabricated claims, unrelated failures, and currently failing tests stay hard failures. Only if inspection establishes safe, scoped work, create a separate non-TDD independent-verification recovery Task with fresh current targeted tests and applicable diagnostics. Preserve the original rejection and count this against the original slice's recovery budget. That new evidence, never `invalidResult`, supplies recovery completion authority; do not relabel the rejected attempt as strict TDD or manufacture RED by undoing correct code. If current behavior is wrong, use a scoped behavior-change recovery Task with fresh honest evidence instead. Stop on unresolved integrity/safety concerns or human prerequisites; do not waive the hard failure through a questionnaire. |
| Blocked or human-dependent | Ask the user only when recovery needs human input or approval: destructive or irreversible action, external or production side effects, credentials or inaccessible environment state, ambiguous file ownership, material scope or behavior choice, or a hard blocker after the bounded recovery rounds. Report exact choices required, keep blocked dependencies stopped, and reconcile checkpoint state. |

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
