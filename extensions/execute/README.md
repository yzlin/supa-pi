---
title: execute extension behavior
read_when:
  - changing /execute command behavior
  - documenting Execution Brief or execute orchestration behavior
status: active
---

# `/execute`

`/execute` sends a plan packet to the main Pi session and grants session-scoped checkpoint authorization. Main owns approval, assignments, blocking `subagent` calls, and independent verification. There is no background workflow, general task runtime, or task dashboard.

## Command modes

- `/execute <plan>` preserves the trimmed explicit plan inside `<plan>...</plan>`, including file references for main to resolve.
- Bare `/execute` reuses the latest assistant-authored `# Execution Brief` only if no later user message makes it stale. Required sections: `Execution Scope`, `Plan`, `Done Criteria`, `Verification`, `Out of Scope` (level-two headings).
- Without a usable brief, main synthesizes a safe, unambiguous one from current context and continues in the same invocation, or asks for exact missing answers.
- Busy invocations queue the same packet as a follow-up and notify the user. Each packet carries its own `invocationId`; queuing does not replace active ledger state before that packet is consumed.
- The command leaves attached images in parent context. Main resolves image-derived requirements into worker task text; children do not inherit parent conversation/images.

## Native-session ledger

[`skills/execute/SKILL.md`](../../skills/execute/SKILL.md) specifies the exact `execute_checkpoint` API and blocking delegation example. Exported schemas/types are in `schema.ts`; pure ledger transitions, validation, branch restoration, call binding and report recording are in `ledger.ts`; Pi hooks and tool registration are in `runtime.ts`.

The registered `CheckpointParametersSchema` has an object root for provider compatibility, with `invocationId` and `action` required. Action-specific fields are optional in that declaration; the local `CheckpointSchema` union still requires each action's fields and rejects fields from other actions before any ledger mutation.

The checkpoint accepts only `inspect`, `accept`, `start`, `verify`, `block`, `repair`, `stop`, with the explicit packet's `invocationId`. It stores one canonical plan and approval/preflight decision, stable assignment IDs and dependencies, literal workspace-relative write scopes, pending/running/blocked/completed outcomes, child claims, main evidence, run/call/attempt identity, and repair lineage. Unknown fields, invalid graphs, duplicate identities, cycles, invalid patches and malformed persisted state fail closed. Marked execution dispatch rejects alternate `cwd`: omit it or use the session workspace's exact path. At most four assignments are running; declared overlapping scopes cannot start together. Dependencies follow the latest repair and cannot start before main-verified completion. Scopes are declarations, not an OS sandbox or symlink-containment proof.

`start` returns an exact task prefix and fresh attempt ID. Main calls `subagent({agent: 'executor', task: dispatchPrefix + completeTask, schema: WorkerReportSchema})`. Hooks bind that observed direct/nested call, then record only its object-valued `structuredContent.structuredOutput` and `runId`. There is no report-submission checkpoint, and prose is not fallback evidence. Missing/error/invalid results block the assignment. Stale calls/results cannot resolve a different session, invocation or attempt; duplicate results/run IDs cannot be replayed. This is logical runtime correlation, not cryptographic provenance or code correctness proof.

A valid child `done` report stays running, not completed. Only main's `verify` with a bound done claim and non-empty independent evidence completes it. Blocked/needs-followup reports require exact blockers. Repairs inherit original scope, dependencies and lineage; a new assignment ID cannot reset the maximum of two mutation repairs. Read-only re-verification does not consume repair budget. An unfinished accepted plan cannot be replaced to erase that budget. A later explicit command may accept a new plan only after all effective assignments complete; use a separate session for a different plan while terminal blockers remain.

Snapshots use `pi.appendEntry('execute-ledger-v1', ledger)`. `session_start` and `session_tree` reconstruct only `getBranch()`, never all session entries. These boundaries clear live authorization/bindings and never dispatch work. Foreign-session or corrupt ledger data blocks checkpoints. New explicit authorization marks interrupted running assignments blocked; main must inspect current workspace and tests before fresh children or read-only verification. There is no automatic cross-session recovery, old-state import, child conversation resume, or `.pi/execute` file access. `/goal` checkpoints are unrelated and unchanged.

## Safety, lifecycle and completion

Main records whole-plan conservative danger preflight and explicit user approval for consequential actions, respects trust, and scopes work to the session workspace. Stored approval text is a decision record, not independent consent enforcement. Workers receive the canonical plan, exact write scope, references, done criteria, and canonical TDD guidance for behavior changes/fixes. Detached executors cannot manage the ledger.

Calls block, with at most four children per parent. Runner cancellation kills owned queued/active children on tool abort or parent shutdown, preserves saved owner-only evidence, and cleans finished tmux sessions. It does not undo edits or terminate independently detached processes. Checkpoint `stop` revokes ledger/marked-dispatch authorization and aborts the parent operation to cancel active runner calls. Abort/error settlement and shutdown revoke authorization. No automatic continuation follows a stop/reload/tree boundary; a new explicit command and current-state reconciliation are required.

Internal `StructuredOutput` validates report shape, with one runner end-of-run correction if absent; this is not a mutation-repair attempt. It does not prove model adherence or correctness. Main independently inspects files, runs current targeted tests and diagnostics/checks, records actual evidence, and reports unresolved IDs, exact blockers and non-blocking follow-ups. These deterministic boundaries have mocked integration/unit coverage; real child lifecycle validation belongs to the subagent runner, not these ledger tests.
