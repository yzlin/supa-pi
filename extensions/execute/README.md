---
title: execute extension behavior
read_when:
  - changing /execute command behavior
  - documenting Execution Brief or execute orchestration behavior
  - changing /to-spec, Spec logs, Snapshot refs, or explicit Spec resume
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

## `/to-spec` command modes

- `/to-spec [slug] [instructions]` sends a synthesis packet naming the canonical [`to-spec` skill](../../skills/to-spec/SKILL.md), with the supplied slug or an instruction to derive one from the goal. It queues as a follow-up when busy. The skill synthesizes the locked plan without interview; only an otherwise guessed Verification permits one testing-seam question. It writes the Spec, not implementation or context docs, and suggests `/execute @.pi/specs/<slug>.md` without starting execution.
- Slugs use 1–48 lowercase letters, digits or hyphens, starting with a letter or digit. Invalid supplied slugs are rejected. Any existing `.log.jsonl` refuses that slug, even if empty or corrupt; an existing `.md` without a log adds an overwrite-confirmation instruction. The skill rechecks collisions before writing and confirms replacement of a never-accepted Spec. Accepted/done Specs cannot be overwritten through `/to-spec`.
- `/to-spec status [slug]` displays a deterministic `spec-status` custom message (`display: true`), without an LLM turn. With no slug it lists Specs alphabetically and their last event (`ready` without a log, `corrupt` on read failure). Empty storage displays `No specs in .pi/specs/. Run /to-spec after locking a plan.` A selected Spec shows path, status, hash, event count, last-event timestamp, and lineage/latest-assignment/state/repairs-used rows; invalid, missing or corrupt targets are reported.

## Native-session ledger

[`skills/execute/SKILL.md`](../../skills/execute/SKILL.md) specifies the exact `execute_checkpoint` API and blocking delegation example. Exported schemas/types are in `schema.ts`; pure ledger transitions, validation, branch restoration, call binding and report recording are in `ledger.ts`; Pi hooks and tool registration are in `runtime.ts`.

`render.ts` draws each checkpoint as one `🎯 checkpoint` card line: action, assignment, outcome and effective `done/total` (superseded repairs excluded). Ctrl+O expands it with action details (plan/approval, task, evidence, blockers) and a board of effective assignments (status glyph, ID, first scope, latest evidence/blocker/attempt or unmet dependencies). Errors always show their message. The model still receives the full JSON `content`.

The registered `CheckpointParametersSchema` has an object root for provider compatibility, with `invocationId` and `action` required. Action-specific fields are optional in that declaration; the local `CheckpointSchema` union still requires each action's fields and rejects fields from other actions before any ledger mutation.

The checkpoint accepts only `inspect`, `accept`, `start`, `verify`, `block`, `repair`, `stop`, with the explicit packet's `invocationId`. It stores one canonical plan and approval/preflight decision, stable assignment IDs and dependencies, literal workspace-relative write scopes, pending/reverify/running/blocked/completed outcomes, child claims, main evidence, run/call/attempt identity, and repair lineage. Unknown fields, invalid graphs, duplicate identities, cycles, invalid patches and malformed persisted state fail closed. Marked execution dispatch rejects alternate `cwd`: omit it or use the session workspace's exact path. At most four assignments are running; declared overlapping scopes cannot start together. Dependencies follow the latest repair and cannot start before main-verified completion. Scopes are declarations, not an OS sandbox or symlink-containment proof.

`start` returns an exact task prefix and fresh attempt ID. Main calls `subagent({agent: 'executor', task: dispatchPrefix + completeTask, schema: WorkerReportSchema})`. Hooks bind that observed direct/nested call, then record only its object-valued `structuredContent.structuredOutput` and `runId`. There is no report-submission checkpoint, and prose is not fallback evidence. Missing/error/invalid results block the assignment. Stale calls/results cannot resolve a different session, invocation or attempt; duplicate results/run IDs cannot be replayed. This is logical runtime correlation, not cryptographic provenance or code correctness proof.

A valid child `done` report stays running, not completed. Only main's `verify` with a bound done claim and non-empty independent evidence completes it; Spec `reverify` instead requires fresh read-only evidence without an `attemptId`. Blocked/needs-followup reports require exact blockers. Repairs inherit original scope, dependencies and lineage; a new assignment ID cannot reset the maximum of two mutation repairs. Read-only re-verification does not consume repair budget. An unfinished accepted plan cannot be replaced to erase that budget. A later explicit command may accept a new plan only after all effective assignments complete; use a separate session for a different plan while terminal blockers remain.

Snapshots use `pi.appendEntry('execute-ledger-v1', ledger)`. `session_start` and `session_tree` reconstruct only `getBranch()`, never all session entries. These boundaries clear live authorization/bindings and never dispatch work. Foreign-session or corrupt ledger data blocks checkpoints. New explicit authorization marks interrupted running assignments blocked; main must inspect current workspace and tests before fresh children or read-only verification. There is no automatic cross-session recovery, old-state import, or child conversation resume. Spec resume is explicit and reads `.pi/specs/` only; legacy `.pi/execute` records are never read or imported. `/goal` checkpoints are unrelated and unchanged.

## Spec log and resume

A **Spec** is an Execution Brief persisted at `.pi/specs/<slug>.md`, immutable after write except a confirmed replacement before acceptance. The format adds `User Stories` and optional `Testing Seams` to the five required headings; the skill owns story/Done Criterion coverage. Storage is local and git-ignored. Main never edits the Spec or its log. The execute Extension alone owns the append-only `.pi/specs/<slug>.log.jsonl` schema, reader/writer, and Snapshot refs.

`accept` takes optional `specPath` (exact `.pi/specs/<slug>.md`, no `@`) and `reviseSpec`. The runtime reads the Spec and log and derives resume state; agents cannot supply resume state or repair counts. Each log event has `ts`; the fixed event fields are:

| Event | Fields beyond `ts`/`event` |
| --- | --- |
| `accepted` | SHA-256 `hash`, `invocationId`, `assignments` (`id`, `dependencies`) |
| `revised` | `hash`, `previousHash` |
| `started` | `assignment`, `lineageId`, `attemptId` |
| `verified` | `assignment`, `lineageId`, `repairCount`, `priorRepairs`, `resumed`, `evidence`, `head`, `snapshot`, optional `snapshotError` |
| `blocked` | `assignment`, `lineageId`, `repairCount`, `priorRepairs`, `blockers` |
| `repaired` | `assignment`, `lineageId`, `repairCount`, `priorRepairs`, `from` |
| `stopped` | `reason` |
| `done` | none |

Events track acceptance, starts, main verification, blockers, repair creation, explicit revision/stop, and completion of all effective assignments; not every native ledger snapshot adds an event. Status is the last event. Specs/logs remain after `done`.

Each `verified` event records `HEAD` (nullable for an unborn repository) and a Snapshot ref `refs/pi-specs/<slug>/<n>`. A temporary index stages the working tree, including untracked non-ignored files, and creates a snapshot commit without changing the user's index or working tree. Non-git workspaces record `head: null`, `snapshot: null`. Snapshot creation errors record `snapshot: null` and `snapshotError` rather than failing verification. Refs are deleted on `done`.

Spec log read/write failures are strict for `execute_checkpoint` `accept`, `start`, `verify`, `block` and `repair`: the checkpoint fails before saving its native ledger transition. `inspect` and `stop` are not blocked by log failures: they notify `Spec log failed` and still return/save the ledger; `stop` still saves the interrupted ledger, revokes authorization and aborts the parent. Snapshot ref cleanup after `done` runs after the log append, so its failure only notifies `Spec snapshot cleanup failed` and keeps the logged events and ledger transition; this prevents a retry from duplicating `verified`/`done`. Lifecycle/tool hooks instead retain native ledger state and notify `Spec log failed` when a context is available; logging failure must not prevent report binding or interruption handling. Corrupt logs fail closed on explicit acceptance/resume; report them, never edit or bypass them.

A later explicit `/execute @.pi/specs/<slug>.md` resumes from the log. Logged-verified lineages become `reverify`, not completed. Main supplies fresh read-only evidence to `verify` without `attemptId`: pass completes, fail blocks and permits scoped repair. Unverified lineages whose last logged event is `started`, `blocked` or `repaired` become `blocked`, carrying logged blockers or `Interrupted in a prior session; repair required`, so new mutation work must use `repair` and its budget check; only lineages without logged progress stay `pending`. `start` also rejects a lineage root that carries spent `priorRepairs`. Dependents wait. `priorRepairs` carries spent repair budget across sessions; total mutation repairs remain at most two per lineage. Omission or renaming of logged-verified or repair-counted lineage IDs is rejected unless explicitly revising.

A Spec hash mismatch rejects acceptance. Main stops and asks the user to revise (re-accept with `reviseSpec: true`, recording `revised` then `accepted`) or restore the Spec. Never set `reviseSpec` without that choice; it is rejected without `specPath` or without a changed hash. Revision permits re-planning unfinished work, while retained lineage IDs still inherit logged verification and repair counts. Existing unfinished native-session plans remain protected from replacement.

Persisted v1 ledger fields `specPath`, `resumed`, and `priorRepairs` are optional solely so pre-Spec native session entries still validate. This is persisted-state compatibility, not a legacy `.pi/execute` import path.

## Safety, lifecycle and completion

Main records whole-plan conservative danger preflight and explicit user approval for consequential actions, respects trust, and scopes work to the session workspace. Stored approval text is a decision record, not independent consent enforcement. Workers receive the canonical plan, exact write scope, references, done criteria, and canonical TDD guidance for behavior changes/fixes. Detached executors cannot manage the ledger.

Calls block, with at most four children per parent. Runner cancellation kills owned queued/active children on tool abort or parent shutdown, preserves saved owner-only evidence, and cleans finished tmux sessions. It does not undo edits or terminate independently detached processes. Checkpoint `stop` revokes ledger/marked-dispatch authorization and aborts the parent operation to cancel active runner calls. Abort/error settlement and shutdown revoke authorization. No automatic continuation follows a stop/reload/tree boundary; a new explicit command and current-state reconciliation are required.

Internal `StructuredOutput` validates report shape, with one runner end-of-run correction if absent; this is not a mutation-repair attempt. It does not prove model adherence or correctness. Main independently inspects files, runs current targeted tests and diagnostics/checks, records actual evidence, and reports unresolved IDs, exact blockers and non-blocking follow-ups. These deterministic boundaries have mocked integration/unit coverage; real child lifecycle validation belongs to the subagent runner, not these ledger tests.
