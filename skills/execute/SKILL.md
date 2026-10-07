---
name: execute
description: Execute one accepted plan with blocking subagents, a native-session execution ledger, and independent main verification.
---

# Execute

You are the main-session orchestrator for `/execute`, not the worker. An explicit `/execute` invocation is the user's opt-in to this workflow. Its packet includes an `invocationId` authorizing execution checkpoints in this session only. Do not infer authorization for unrelated work, a different plan, or continuation after a stop, reload, or tree navigation. There is no automatic continuation or replay.

## Input and plan contract

- Treat `<plan>...</plan>` as executable input, supporting inline plans and file references such as `implement @plan.md`. Read referenced files in the target workspace and extract executable items (prefer Markdown lists, then lines).
- Bare `/execute` reuses the latest assistant Execution Brief only if no later user message has made it stale. Without a usable brief, synthesize one from current context and continue in the same run only when safe and unambiguous; no second invocation is needed.
- Busy invocations arrive as queued follow-ups. Consume each packet's own `invocationId`; do not use a queued packet to replace the currently running plan prematurely.
- Attached images remain in the main conversation. Inspect them in main and translate relevant requirements into concrete task text before dispatch. Children receive only their self-contained task and role/workspace guidance, not parent history or attached images.
- Present a concise normalized goal, atomic assignments, constraints, dependency graph, done criteria, verification, and out-of-scope boundaries before dispatch. Ask concise questions when answers could change scope, graph, safety, or done criteria. In non-interactive contexts, report the exact missing answers rather than guessing.
- Keep one canonical plan summary in the conversation and accepted ledger. Pass that same summary to every worker, with concrete paths and task-specific criteria. Never read, import, repair, or migrate legacy `.pi/execute` files.

A reusable brief has these exact headings:

```markdown
# Execution Brief
## Execution Scope
## Plan
## Done Criteria
## Verification
## Out of Scope
```

## Safety gates

Perform a conservative danger preflight over the whole canonical plan before accepting it or dispatching. Destructive/irreversible actions, broad filesystem operations, secret exposure, production changes, and external side effects require explicit user approval covering those actions. Record the preflight and approval in the conversation and the ledger's `approval` text. For safe local plans, record why separate approval is not needed. The checkpoint stores this decision; it cannot independently prove consent or safety.

Use only the session's target workspace and honor Pi trust controls. Omit `cwd` on execution calls (or supply the exact session path); marked execution dispatch rejects alternate paths. Do not bypass untrusted project agent definitions. Safe, reversible local repair inside the accepted plan needs no new approval. Stop for human prerequisites, credentials, inaccessible state, ambiguous ownership, material behavior choices, or consequential external effects. A worker report is never approval.

## Execution-owned checkpoint API

Only main calls `execute_checkpoint`; a detached executor must never manage the ledger. All calls require the packet's `invocationId`. Inputs reject unknown keys. Output is `{ ledger, dispatchPrefix }` in tool `structuredContent` (also rendered as JSON text). `dispatchPrefix` is non-null only for `start`.

| action | Other required fields | Decision |
| --- | --- | --- |
| `inspect` | none | Read current accepted plan, assignments, evidence, blockers and lineage counts. |
| `accept` | `plan`, `approval`, `assignments` | Accept exactly one canonical plan. Each assignment is `{id, task, scope, dependencies}`. IDs are stable unique alphanumeric/underscore/hyphen strings; dependencies are assignment IDs, unique, known, acyclic. |
| `start` | `assignmentId` | Change pending to running only after all effective prerequisites are main-verified. Returns fresh `attemptId` in the assignment and an exact `dispatchPrefix`. |
| `verify` | `assignmentId`, `attemptId`, `passed`, `evidence`, `blockers` | Main's independent decision after an observed bound `done` report. Non-empty evidence lists actual file inspection, commands/results and diagnostics. Passing requires empty blockers; failing requires exact blockers. Read-only re-verification does not consume repairs. |
| `block` | `assignmentId`, `blockers` | Keep pending/running work unresolved with non-empty exact prerequisites or reasons. Does not complete or reset a completed assignment. |
| `repair` | `assignmentId`, `newAssignmentId`, `task` | Replace a blocked assignment with a fresh pending scoped repair. Inherits scope, dependencies, original `lineageId`, and incremented `repairCount` (maximum two). Old assignment remains blocked and links through `supersededBy`. |
| `stop` | none | Revoke execution authorization, block running assignments, and abort the parent operation (cancelling owned runner children); no further checkpoints or dispatch until explicit `/execute`. |

`scope` is a non-empty array of literal workspace-relative files/directories, without globs, traversal, or absolute paths (`.` deliberately owns the whole workspace). Include every potential write path; overlap of running scopes is rejected. Paths are declarations, not a filesystem sandbox; main must check symlink targets and actual writes. Initial assignments are `pending` with zero repairs. Outcomes are `pending`, `running`, `blocked`, `completed`; the child report is separate from the outcome.

The ledger uses native Pi session entries, not files or a general task service/dashboard. On session start or tree navigation it reads only the current branch, validates persisted unknown input, and clears live authorization/bindings. It does not dispatch or authorize recovery automatically. Corrupt or foreign-session ledger entries fail closed. After a new explicit `/execute`, inspect ledger/workspace/current tests before fresh delegation. Interrupted running assignments become blocked when a new packet is consumed; a fresh mutation-capable child uses `repair`, preserving the two-attempt lineage limit. A saved `done` claim may receive read-only current-state main verification, never blind acceptance. Pending unstarted assignments retain their IDs.

A new command cannot erase an unfinished accepted plan or reset repair counts. Resolve that plan or report its terminal blockers first; a different plan requires a separate session when unresolved work remains. After all effective assignments are verified completed, a later explicit command may accept a new plan. Dependencies on an original assignment follow its latest repair, so they remain blocked until that repair is verified. New IDs cannot reset counts. The ledger is not `/goal` state.

## Blocking delegation example

First accept the plan and start an assignment:

```js
const accepted = await execute_checkpoint({
  invocationId: "<packet invocationId>", action: "accept",
  plan: "<canonical brief: goal, ordered work, done criteria, verification, exclusions>",
  approval: "<whole-plan danger preflight and applicable explicit user approval>",
  assignments: [
    { id: "implement", task: "Implement the scoped feature", scope: ["src/feature", "tests/feature"], dependencies: [] },
    { id: "document", task: "Document verified behavior", scope: ["docs/feature.md"], dependencies: ["implement"] },
  ],
});
const started = await execute_checkpoint({
  invocationId: "<packet invocationId>", action: "start", assignmentId: "implement",
});
const RESULT_SCHEMA = {
  type: "object", additionalProperties: false,
  properties: {
    status: { anyOf: [{ const: "done", type: "string" }, { const: "blocked", type: "string" }, { const: "needs_followup", type: "string" }] },
    summary: { type: "string", minLength: 1, maxLength: 32000, pattern: "\\S" },
    filesTouched: { type: "array", maxItems: 100, items: { type: "string", minLength: 1, maxLength: 32000, pattern: "\\S" } },
    validation: { type: "array", maxItems: 100, items: { type: "string", minLength: 1, maxLength: 32000, pattern: "\\S" } },
    followUps: { type: "array", maxItems: 100, items: { type: "string", minLength: 1, maxLength: 32000, pattern: "\\S" } },
    blockers: { type: "array", maxItems: 100, items: { type: "string", minLength: 1, maxLength: 32000, pattern: "\\S" } },
  },
  required: ["status", "summary", "filesTouched", "validation", "followUps", "blockers"],
};
const result = await subagent({
  agent: "executor",
  task: started.dispatchPrefix + "<canonical brief>\n<complete assignment, target workspace, exact write scope, done criteria, references, safety gates>\nRead the verified workspace skills/tdd-workflow/SKILL.md for behavior changes and bug fixes; report matched RED/GREEN commands.\nYou are detached. Do not call execute_checkpoint or manage assignments. Report non-blocking followUps and exact blockers.",
  schema: RESULT_SCHEMA,
});
// The call blocks. The extension observes its tool call/result and records
// result.structuredOutput against this attempt and result.runId automatically.
// Main now inspects files and independently runs current tests/diagnostics.
await execute_checkpoint({
  invocationId: "<packet invocationId>", action: "verify", assignmentId: "implement",
  attemptId: started.ledger.assignments.find(a => a.id === "implement").attemptId,
  passed: true, evidence: ["<main inspection and actual commands/results>"], blockers: [],
});
```

Use the exact report schema above, matching exported `WorkerReportSchema`; main must retain the `dispatchPrefix` unchanged at the beginning of the task. The extension binds one observed direct or nested `subagent` call to each running attempt. Missing prefix is not ledger dispatch. A stale prefix, duplicate call, wrong agent, or different schema fails closed for marked execution calls. Main cannot release an active child's write reservation with `block`/`repair` or consume a new packet while that child is still running; await completion or abort first. Reports are taken only from tool `structuredContent.structuredOutput`, never parsed from assistant prose or manually submitted to a checkpoint. No report checkpoint exists.

Schema-bound children submit an object through internal `StructuredOutput`. The runner validates shape, offers one end-of-run correction if no valid report is captured, and fails if still absent. This correction is not an execution mutation repair. Parent semantic checks require `done` with no blockers; `blocked`/`needs_followup` require non-empty blockers and retain files, validation, and follow-ups. A missing, failed, invalid or stale result leaves its originating assignment unresolved, with exact reasons rather than fabricated completion. Duplicate/replayed run IDs cannot satisfy a different assignment. Schema validity and logical call binding are not proof of code correctness.

Workers are fresh task-only Pi children in the shared checkout. There is no child-conversation resume. Run independent calls together only for disjoint scopes, at most four active assignments/children per parent. Verify prerequisites before dispatching dependents. Resolve essential references in main and supply verified worker-accessible paths; do not require detached workers to rediscover the parent's global skill/tool catalog. Repository discovery is allowed within the target workspace, not unbounded home/global searches. Include canonical TDD guidance for behavior changes and fixes, not normally for docs/config/generated/mechanical work.

Tool abort or parent shutdown cancels owned active and queued children in the runner. A ledger `stop` revokes checkpoint/marked-dispatch authorization and aborts the parent tool operation. Cancellation does not undo edits or terminate independently detached processes. Do not automatically start fresh children after a stop.

## Main-session verification and recovery

A worker's `done` is only a claim. The main session still performs independent verification: inspect actual changed files and scope, run the narrowest current tests, and run applicable diagnostics/LSP and repository checks. Only then record `verify` with actual evidence. Do not complete from worker validation alone. Keep explicit blockers/follow-ups and stale outcomes attached to the original assignment. Report exact human prerequisites first when needed.

On a current scoped reversible defect, record failed verification and schedule a `repair`, at most two mutation-capable repairs per original lineage, even under new IDs. Read-only verification does not consume this budget and must not become an unbounded verification-only chain. Do not undo correct code to manufacture a failing test. Stop after budget exhaustion or safety/ownership ambiguity. Non-blocking follow-ups stay in the final report; they do not silently expand the accepted plan.

Finish only when all effective assignments are independently verified completed or have explicit terminal blockers. Report completed work, unresolved IDs/lineages, exact blockers, files touched, validation actually run, and remaining follow-ups. Never present terminal blockers as completion.
### Verification with codemode

When the `codemode` tool is available, run the narrowest targeted test command(s) and the repository's check command in one script, returning compact results:

```js
// @options: {"max_output_tokens": 2000}
const commands = ["<narrowest targeted test command>", "<repository check command>"];
const results = [];
for (const command of commands) {
  const r = await tools.bash({
    reasoning: "execute verification",
    command: `log=$(mktemp -t verify.XXXXXX); ( ${command} ) >"$log" 2>&1; code=$?; echo "LOG=$log"; tail -n 40 "$log"; exit $code`,
  });
  if (r.exit_code === 0) {
    results.push({ command, exit: 0 });
  } else {
    const [header, ...tail] = r.output.split("\n");
    results.push({ command, exit: r.exit_code, log: header.replace(/^LOG=/, ""), tail: tail.join("\n").trimEnd() });
  }
}
return results;
```

- Run sequentially as shown when commands share state; use `Promise.all` only for commands that do not contend for shared state.
- A passing script result is verification evidence (command + exit), but the main session still inspects claimed files and applicable diagnostics.
- On failure, `read` the returned log path with a `reasoning` argument for more context instead of rerunning blindly.
- Nested calls use the tools' declared arguments and the same validation and hooks as direct calls. The script runs commands; it does not judge completion or change the repair budget.
