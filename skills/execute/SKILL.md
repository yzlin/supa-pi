---
name: execute
description: Execute a safe, unambiguous plan in the current main session with native SubagentWorkflow and pi-tasks.
---

# Execute

You are the main-session orchestrator for `/execute`, not the worker. Execute the requested plan in this session when it is safe and unambiguous.

An explicit `/execute` invocation is the user's opt-in to this workflow. Its invocation packet authorizes the main session to call `SubagentWorkflow` for the accepted plan. Do not infer that authorization for unrelated work, a later plan, or a new workflow after a stop.

## Input and plan contract

- If the request includes `<plan>...</plan>`, treat only the content inside that tag pair as the executable plan input.
- Support inline plans and file-backed plans such as `@plan.md` or `implement @plan.md`. Read a referenced file in the target workspace and extract its executable items; prefer markdown list items, then use line-based parsing.
- Explicit plan arguments execute immediately through this workflow. For bare `/execute`, use the latest assistant-authored Execution Brief only when no later user message makes it stale.
- If a bare invocation has no usable brief, synthesize one from the current session context and continue in the same run when safe and unambiguous; do not require a second `/execute`.
- Before dispatch, present a concise plan containing the normalized goal, task breakdown, constraints, and verification approach.
- Ask concise clarifying questions before execution when an answer could change scope, the task graph, safety posture, or done criteria. In non-interactive contexts, questions are terminal: report the exact answers required instead of guessing.

A reusable Execution Brief must contain these exact headings:

```markdown
# Execution Brief
## Execution Scope
## Plan
## Done Criteria
## Verification
## Out of Scope
```

After ambiguity is resolved, keep one canonical plan summary in the current conversation and pass that same summary to each task and workflow invocation. Include the goal, ordered tasks, done criteria, verification, and out-of-scope boundaries. Do not read, import, repair, or migrate legacy `.pi/execute` state.

## Safety gates

- Perform a conservative danger preflight over the whole canonical plan before creating tasks or dispatching workers. Treat destructive or irreversible actions, secret exposure, production data or service changes, broad filesystem operations, and external side effects as dangerous unless the plan clearly rules them out.
- For a dangerous plan, ask for explicit user approval before task creation or dispatch. Do not infer approval from a plan, prior unrelated approval, or a worker report. Keep the approved plan and approval together in the current task metadata or conversation; never reuse approval for a materially different plan.
- Use the session's target workspace only. Alternate-workspace dispatch is outside this workflow. Never bypass Pi trust or safety controls.
- Safe, reversible local repair inside the accepted brief does not need a new approval. Stop for human prerequisites, ambiguous ownership, credentials, inaccessible state, or consequential external effects.

## Native task and workflow orchestration

1. Use the upstream `@tintinweb/pi-tasks` tools in the main session for multi-step work. Create atomic tasks with `TaskCreate`, dependencies where needed, and `agentType: "executor"`. Keep task subjects, prompts, done criteria, and relevant lineage information in task metadata. Use `TaskUpdate`, `TaskList`, and `TaskGet` to reconcile state.
2. Only the main session creates, updates, starts, completes, or blocks tasks. Set runnable tasks to `in_progress` before dispatch. Do not ask a worker to manage tasks.
3. Use the upstream `SubagentWorkflow` tool for worker orchestration, not a custom execution tool. The explicit `/execute` invocation authorizes this call for the accepted plan. Pass an inline JavaScript workflow script and actual JSON `args`; do not write a coordinator script into the repository first. The script should use the native `agent(prompt, options)` API, `parallel()` for independent disjoint tasks, and `pipeline()` when stages can overlap.
4. A worker call has this shape:

```javascript
export const meta = {
  name: "execute-tasks",
  description: "Execute the approved repository tasks",
  phases: [{ title: "Execute" }],
};

const RESULT_SCHEMA = {
  type: "object",
  properties: {
    status: { type: "string", enum: ["done", "blocked", "needs_followup"] },
    summary: { type: "string", minLength: 1 },
    filesTouched: { type: "array", items: { type: "string" } },
    validation: { type: "array", items: { type: "string" } },
    followUps: { type: "array", items: { type: "string" } },
    blockers: { type: "array", items: { type: "string" } },
  },
  required: ["status", "summary", "filesTouched", "validation", "followUps", "blockers"],
  additionalProperties: false,
};

const results = await parallel(args.tasks.map((task) => async () => ({
  taskId: task.taskId,
  result: await agent(task.prompt, {
    agentType: "executor",
    label: task.subject,
    phase: "Execute",
    schema: RESULT_SCHEMA,
  }),
})));
return { plan: args.canonicalPlan, results };
```

`schema` uses upstream native `StructuredOutput`: it validates the worker report shape and returns an object; it does not prove that code is correct. Keep schemas small and filter or explicitly handle `null` results. Never parse assistant prose as a substitute for a missing structured result. The workflow returns immediately; do not poll or sleep. Wait for its completion notification and inspect the returned results. A `null` or missing result is not an empty slot: preserve its originating task ID and subject, leave that task unresolved, and attach the reason as blocker metadata. Never drop it, mark it completed, or silently replace it with a new task.

- Dispatch independent writes in parallel only when their scopes are disjoint. Sequence dependent tasks in separate workflow rounds after verifying prerequisites. Keep each workflow invocation bounded to the approved task batch.
- Give every worker its complete task prompt, target paths, done criteria, and applicable repository guidance. Resolve essential references in the main session first and provide concrete worker-accessible paths or concise context. Do not require a detached worker to rediscover the parent's global skill or tool catalog. Normal code and documentation discovery is allowed only within the target workspace; resolve missing essential references or report a blocker rather than doing unbounded home/global searches.
- For behavior changes and bug fixes, include the canonical `skills/tdd-workflow/SKILL.md` guidance in the worker prompt or point to its verified target-workspace path. TDD is worker guidance, not a runtime-enforced trajectory or completion gate. Documentation-only, configuration-only, generated, and mechanical tasks normally omit TDD guidance unless they change behavior.
- Upstream workflow journals support same-session resume. If a workflow is paused or its script needs correction, reuse its reported script path with `resumeFromRunId` only in the same session and after stopping the live run. A parent/main-session stop does not cancel a background workflow; the user stops it through `/agents → Workflows`. After a user stop, do not automatically resume or dispatch that workflow or its tasks until the user explicitly requests it. Resume is not cross-session recovery. Reconcile live pi-task state, workspace contents, and current tests before trusting replayed results. Never use old `.pi/execute` files as workflow input.

## Main-session verification and recovery

- Reconcile every workflow result into the matching pi-task before starting dependent work. A worker's `done` report is a claim, not completion authority.
- For every settled task, inspect claimed files in the main session, run the narrowest current test or validation command that proves the behavior, and run applicable diagnostics/LSP checks when available. Verify dependencies and workspace state before marking the task `completed`.
- Treat `blocked` and `needs_followup` as explicit worker outcomes. Keep blocked dependencies from running and report exact missing prerequisites. Schedule non-blocking follow-ups only after the current workflow batch has been reconciled.
- `@tintinweb/pi-tasks` has no `blocked` task status. For a terminal blocker, leave the originating task `pending` when it never started or `in_progress` when dispatch began, and record terminal blocker metadata on that task. Do not invent a blocked status, drop the task, or mark it completed. A `null` or missing result follows the same unresolved path.
- If verification finds a current, scoped, reversible defect, schedule a bounded recovery task. Allow at most two mutation-capable repair attempts per original task lineage; carry the lineage and attempt count in pi-task metadata so a new task ID cannot reset the budget. A read-only verification pass does not consume that budget. Do not undo correct code to manufacture a failing test, and do not create an unbounded verification-only chain.
- Stop and ask the user for destructive actions, external/production effects, credentials, ambiguous ownership, material behavior choices, or a blocker that remains after the bounded repair budget. Do not waive a safety or integrity concern because a worker report looks plausible.
- Finish only when every task is `completed` or has a terminal blocker recorded in metadata while retaining `pending` or `in_progress` status. Report completed work, unresolved tasks, blockers, files touched, validation actually run, and remaining follow-ups.

## Worker output

The executor submits this object through upstream `StructuredOutput`:

```json
{
  "status": "done" | "blocked" | "needs_followup",
  "summary": "what happened",
  "filesTouched": ["workspace-relative/path"],
  "validation": ["commands and observed results"],
  "followUps": ["non-blocking work for the main session"],
  "blockers": ["exact missing prerequisite or reason"]
}
```

`needs_followup` requires a non-empty blocker. `blocked` is a worker report outcome, not a pi-task status; the main session records its terminal blocker in metadata while retaining `pending` or `in_progress`. Use `done` only after the worker has completed its scoped work and reported its actual validation; the main session still performs independent verification.

## Output

Keep the user updated with short execution progress. Finish with a concise summary of completed work, blocked items, files touched, validation run, and remaining follow-ups.
