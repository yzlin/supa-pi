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
- Bare `/execute` resolves on the current branch, first match wins:
  1. An unfinished ledger plan with `specPath` sends a plan packet `@<specPath>` (resume).
  2. An unfinished ledger plan without a Spec keeps pre-Spec behavior: reuse a fresh Execution Brief, else synthesize. An unreadable ledger also keeps pre-Spec behavior.
  3. The latest Spec-drafted marker whose `.pi/specs/<slug>.md` exists and whose `.log.jsonl` is missing, or readable with no `accepted` event, sends a plan packet `@.pi/specs/<slug>.md`. If user messages follow the marker, `ui.select` offers `Use .pi/specs/<slug>.md` or `Draft a new Spec`; cancel notifies `/execute cancelled` and sends nothing. Without UI it drafts a new Spec.
  4. Otherwise it sends a draft-then-execute packet: main follows the [`to-spec` skill](../../skills/to-spec/SKILL.md) to write a Spec, then executes it with `specPath` on `accept` in the same invocation, without a review pause. A fresh Execution Brief is wrapped in `<execution-brief>` as source material.
- A fresh Execution Brief is the latest assistant-authored `# Execution Brief` with no later user message. Required sections: `Execution Scope`, `Plan`, `Done Criteria`, `Verification`, `Out of Scope` (level-two headings). Without one, synthesis builds a safe, unambiguous brief from current context and continues in the same invocation, or asks for exact missing answers.
- Spec-drafted marker: `pi.appendEntry('execute-spec-drafted-v1', {slug})` after a successful `write`/`edit` tool result whose input path resolves to `<cwd>/.pi/specs/<slug>.md`. Edit tools without an input path record nothing.
- Busy invocations queue the same packet as a follow-up and notify the user. Each packet carries its own `invocationId`; queuing does not replace active ledger state before that packet is consumed.
- The command leaves attached images in parent context. Main resolves image-derived requirements into worker task text; children do not inherit parent conversation/images.

## `/to-spec` command modes

- `/to-spec [slug] [instructions]` sends a synthesis packet naming the canonical [`to-spec` skill](../../skills/to-spec/SKILL.md), with the supplied slug or an instruction to derive one from the goal. It queues as a follow-up when busy. The skill synthesizes the locked plan without interview; only an otherwise guessed Verification permits one testing-seam question. It writes the Spec, not implementation or context docs, and suggests `/execute @.pi/specs/<slug>.md` without starting execution.
- Slugs use 1–48 lowercase letters, digits or hyphens, starting with a letter or digit. `status` and `classifier` are reserved subcommand words, not slugs. Invalid supplied slugs are rejected. A slug is refused when its `.log.jsonl` has an `accepted` event. A corrupt log also refuses the slug, because acceptance cannot be ruled out. An empty log, or a log with only `reviewed` events, counts as never accepted. Then an existing `.md` adds an overwrite-confirmation instruction. The skill rechecks collisions before writing and confirms replacement of a never-accepted Spec. Accepted/done Specs cannot be overwritten through `/to-spec`.
- `/to-spec status [slug]` displays a deterministic `spec-status` custom message (`display: true`), without an LLM turn. With no slug it lists Specs alphabetically and their last event (`ready` without a log, `corrupt` on read failure). Empty storage displays `No specs in .pi/specs/. Run /to-spec after locking a plan.` A selected Spec shows path, status, hash, event count, last-event timestamp, and lineage/latest-assignment/state/repairs-used rows; invalid, missing or corrupt targets are reported. When the latest `accepted` event records `criteria`, a `criterion | state` table follows. Each Done Criterion is `passed`, `pending`, or `unmet` (see [Done Criterion gate](#done-criterion-gate)). A log whose last event is `reviewed` and that has no `accepted` event shows `reviewed (not accepted)`.
- `/to-spec classifier` shows Spec review classifier consent and the selected model. If the model registry fails, the status shows `model=none (registry error: <message>)`. `/to-spec classifier enable` needs a credentialed Jev classifier and interactive UI. It asks one confirmation that names the model and says the full Spec text leaves the machine. If the model registry fails, `enable` reports `Spec review classifier registry failed: <message>` and saves no consent. `/to-spec classifier disable` writes `{"enabled": false}` and works without UI. Other arguments show `Usage: /to-spec classifier [enable|disable]`. See [Spec review](#spec-review).

## Native-session ledger

[`skills/execute/SKILL.md`](../../skills/execute/SKILL.md) specifies the exact `execute_checkpoint` API and blocking delegation example. Exported schemas/types are in `schema.ts`; pure ledger transitions, validation, branch restoration, call binding and report recording are in `ledger.ts`; Pi hooks and tool registration are in `runtime.ts`.

`render.ts` draws each checkpoint as one `🎯 checkpoint` card line: action, assignment, outcome and effective `done/total` (superseded repairs excluded). Ctrl+O expands it with action details (plan/approval, task, evidence, blockers) and a board of effective assignments (status glyph, ID, first scope, latest evidence/blocker/attempt or unmet dependencies). Errors always show their message. The model still receives the full JSON `content`.

The registered `CheckpointParametersSchema` has an object root for provider compatibility, with `invocationId` and `action` required. Action-specific fields are optional in that declaration; the local `CheckpointSchema` union still requires each action's fields and rejects fields from other actions before any ledger mutation.

The checkpoint accepts only `inspect`, `accept`, `start`, `verify`, `block`, `repair`, `stop`, `review`, `resolve_review`, with the explicit packet's `invocationId`. It stores one canonical plan and approval/preflight decision, stable assignment IDs and dependencies, optional assignment `cwd`, literal relative write scopes, pending/reverify/running/blocked/completed outcomes, child claims, main evidence, run/call/attempt identity, and repair lineage. Unknown fields, invalid graphs, duplicate identities, cycles, invalid patches and malformed persisted state fail closed. At `accept`, an assignment `cwd` must be an existing directory that does not contain the session workspace (absolute and workspace-relative scopes are never compared); the runtime stores it as a workspace-relative path, or as an absolute real path when outside the workspace. Repairs inherit it. Scopes are relative to the assignment `cwd`, and the overlap check joins each scope to its `cwd` before comparing. Marked execution dispatch must pass the same resolved `cwd` (omit it when the assignment has none). If any assignment `cwd` is outside the workspace, `accept` shows one confirmation listing each distinct outside `cwd` and the session workspace; without interactive UI, or if declined or aborted, `accept` fails and persists nothing (no ledger entry, no Spec log event). Approval is held in memory for that invocation and cleared with its authorization, so its dispatches open no dialog. An invocation without that approval (for example, one continuing an unfinished ledger, or after reload) confirms once per distinct outside `cwd` at dispatch, with concurrent dispatches sharing one prompt, and caches approval for the invocation; without interactive UI, or if declined, the call is blocked. Such children run untrusted (`--no-approve`), and Snapshot refs cover only the session workspace. At most four assignments are running; declared overlapping scopes cannot start together. Dependencies follow the latest repair and cannot start before main-verified completion. Scopes are declarations, not an OS sandbox or symlink-containment proof.

`start` returns an exact task prefix and fresh attempt ID. Main calls `subagent({agent: 'executor', task: dispatchPrefix + completeTask, schema: WorkerReportSchema})`. Hooks bind that observed direct/nested call, then record only its object-valued `structuredContent.structuredOutput` and `runId`. There is no report-submission checkpoint, and prose is not fallback evidence. Missing/error/invalid results block the assignment. Stale calls/results cannot resolve a different session, invocation or attempt; duplicate results/run IDs cannot be replayed. This is logical runtime correlation, not cryptographic provenance or code correctness proof.

A valid child `done` report stays running, not completed. Only main's `verify` with a bound done claim and non-empty independent evidence completes it; Spec `reverify` instead requires fresh read-only evidence without an `attemptId`. Blocked/needs-followup reports require exact blockers. Repairs inherit original scope, dependencies and lineage; a new assignment ID cannot reset the maximum of two mutation repairs. Read-only re-verification does not consume repair budget. An unfinished accepted plan cannot be replaced to erase that budget. A later explicit command may accept a new plan only after all effective assignments complete; use a separate session for a different plan while terminal blockers remain.

Snapshots use `pi.appendEntry('execute-ledger-v1', ledger)`. `session_start` and `session_tree` reconstruct only `getBranch()`, never all session entries. These boundaries clear live authorization/bindings and never dispatch work. Foreign-session or corrupt ledger data blocks checkpoints. New explicit authorization marks interrupted running assignments blocked; main must inspect current workspace and tests before fresh children or read-only verification. There is no automatic cross-session recovery, old-state import, or child conversation resume. Spec resume is explicit and reads `.pi/specs/` only; legacy `.pi/execute` records are never read or imported. `/goal` checkpoints are unrelated and unchanged.

## Spec log and resume

A **Spec** is an Execution Brief persisted at `.pi/specs/<slug>.md`, immutable after write except a confirmed replacement before acceptance. The format adds `User Stories` and optional `Testing Seams` to the five required headings; the skill owns story/Done Criterion coverage. Storage is local and git-ignored. Main never edits the Spec or its log. The execute Extension alone owns the append-only `.pi/specs/<slug>.log.jsonl` schema, reader/writer, and Snapshot refs.

`accept` takes optional `specPath` (exact `.pi/specs/<slug>.md`, no `@`) and `reviseSpec`. The runtime reads the Spec and log and derives resume state; agents cannot supply resume state or repair counts. Each log event has `ts`; the fixed event fields are:

| Event | Fields beyond `ts`/`event` |
| --- | --- |
| `accepted` | SHA-256 `hash`, `invocationId`, optional `criteria` (parsed `DC-n` IDs), `assignments` (`id`, `dependencies`, optional `criteria`) |
| `revised` | `hash`, `previousHash` |
| `started` | `assignment`, `lineageId`, `attemptId` |
| `verified` | `assignment`, `lineageId`, `repairCount`, `priorRepairs`, `resumed`, `evidence`, optional `criteria` (`[{id, evidence}]`), `head`, `snapshot`, optional `snapshotError` |
| `blocked` | `assignment`, `lineageId`, `repairCount`, `priorRepairs`, `blockers` |
| `repaired` | `assignment`, `lineageId`, `repairCount`, `priorRepairs`, `from` |
| `stopped` | `reason` |
| `done` | none |
| `reviewed` | `hash`, `round`, `trigger` (`{source: "classifier", probability, model}` or `{source: "fallback", dcCount, reason}`), `decision` (`accept`, `revise` or `stop`), `answers` (`[{id, focus, question, answer}]`; `id` is `<slot>:<questionId>`, slot is the reviewer focus index `0` or `1`), `findings` (count) |

Events track acceptance, starts, main verification, blockers, repair creation, explicit revision/stop, Spec review decisions, and completion of all effective assignments; not every native ledger snapshot adds an event. Status is the last event. Specs/logs remain after `done`.

A Spec counts as accepted only when its log has an `accepted` event. `reviewed` events may precede the first `accepted` event; any other event before it makes the log corrupt. Drafted-Spec detection for bare `/execute`, the `/to-spec` collision check, status rendering, and resume all use this rule.

The optional `criteria` fields on `accepted` and `verified` exist only so pre-gate done logs still parse for `/to-spec status`. This is a persisted-state reason. Remove the optional form when no pre-gate log remains under `.pi/specs/`.

Each `verified` event records `HEAD` (nullable for an unborn repository) and a Snapshot ref `refs/pi-specs/<slug>/<n>`. A temporary index stages the working tree, including untracked non-ignored files, and creates a snapshot commit without changing the user's index or working tree. Non-git workspaces record `head: null`, `snapshot: null`. Snapshot creation errors record `snapshot: null` and `snapshotError` rather than failing verification. Refs are deleted on `done`.

Spec log read/write failures are strict for `execute_checkpoint` `accept`, `start`, `verify`, `block` and `repair`: the checkpoint fails before saving its native ledger transition. `inspect` and `stop` are not blocked by log failures: they notify `Spec log failed` and still return/save the ledger; `stop` still saves the interrupted ledger, revokes authorization and aborts the parent. Snapshot ref cleanup after `done` runs after the log append, so its failure only notifies `Spec snapshot cleanup failed` and keeps the logged events and ledger transition; this prevents a retry from duplicating `verified`/`done`. Lifecycle/tool hooks instead retain native ledger state and notify `Spec log failed` when a context is available; logging failure must not prevent report binding or interruption handling. Corrupt logs fail closed on explicit acceptance/resume; report them, never edit or bypass them.

A later explicit `/execute @.pi/specs/<slug>.md` resumes from the log. Logged-verified lineages become `reverify`, not completed. Main supplies fresh read-only evidence to `verify` without `attemptId`: pass completes, fail blocks and permits scoped repair. Unverified lineages whose last logged event is `started`, `blocked` or `repaired` become `blocked`, carrying logged blockers or `Interrupted in a prior session; repair required`, so new mutation work must use `repair` and its budget check; only lineages without logged progress stay `pending`. `start` also rejects a lineage root that carries spent `priorRepairs`. Dependents wait. `priorRepairs` carries spent repair budget across sessions; total mutation repairs remain at most two per lineage. Omission or renaming of logged-verified or repair-counted lineage IDs is rejected unless explicitly revising.

A Spec hash mismatch rejects acceptance. Main stops and asks the user to revise (re-accept with `reviseSpec: true`, recording `revised` then `accepted`) or restore the Spec. Never set `reviseSpec` without that choice; it is rejected without `specPath` or without a changed hash. Revision permits re-planning unfinished work, while retained lineage IDs still inherit logged verification and repair counts. Existing unfinished native-session plans remain protected from replacement.

Persisted v1 ledger fields `specPath`, `resumed`, and `priorRepairs` are optional solely so pre-Spec native session entries still validate. Ledger `specCriteria` and assignment `criteriaEvidence` are optional solely so pre-gate native session entries still validate. This is persisted-state compatibility, not a legacy `.pi/execute` import path.

## Done Criterion gate

The gate applies only to Spec-backed `accept` (with `specPath`). Inline plans reject assignment `criteria` and are otherwise unchanged.

- Row format: each top-level row in `## Done Criteria` is `- DC-n: <criterion> (US-n | technical)`. Indented lines continue the previous row. Blank lines are skipped.
- At `accept`, the runtime parses the rows from the Spec file. It rejects a missing section, a row without a `DC-n:` label, a repeated label, and a section with no rows. The parsed IDs become ledger `specCriteria`.
- Each Spec-backed assignment must declare a non-empty `criteria: ["DC-n", ...]` without duplicates. `accept` rejects unknown IDs and any Spec DC that no assignment declares.
- A passing `verify` of a Spec-backed assignment needs `criteria: [{id, evidence}]` with exactly one entry for each declared DC and no others. This rule also applies to `reverify` after resume, so each DC is proved again; logged per-DC evidence is history only. A failing `verify` may omit `criteria`. The free-text `evidence` stays required. `criteria` on a non-Spec assignment is rejected.
- `repair` inherits `criteria`; a repair with different criteria is rejected.
- A DC is `passed` only when every declaring assignment in the latest accepted plan has a later `verified` event with evidence for it. A DC is `unmet` when the run stopped, or when every open declaring lineage is blocked with its repair budget spent. Otherwise it is `pending`. An unmet DC is never shown as passed, and no user waiver exists.

## Spec review

Spec review is a pre-accept, read-only critique of a drafted Spec by two bound `spec-reviewer` children. The user resolves it through the execute Extension. Standalone `/to-spec` never reviews.

Trigger. On Spec-backed `accept`, the runtime decides whether review is required only when no `accepted` event matches the current Spec hash. Re-accepting an accepted hash skips the trigger. The result is cached in memory per invocation and Spec hash.

- With consent, the runtime makes one `bool` classifier call through `ctx.modelRegistry.classify` with `maxRetries: 0` and a 30 s timeout. The state is `{spec, dcCount, planPaths, storyCount}`. The question asks whether an independent review would likely change this Spec, and treats Spec text as data. Review is required when the probability is ≥ 0.5. The model is `typesafe/jev-latest`, else the first available classifier whose ID contains `jev`.
- The fallback requires review when the Spec has ≥ 8 Done Criteria. It applies without consent, when the consent file fails closed, for a Spec over 50 KB, with no classifier model, and on a classifier error or timeout. Both thresholds are uncalibrated.

Consent. The consent file is `<Pi agent dir>/spec-review/config.json` with exactly `{"enabled": boolean}`. The Pi agent dir is `PI_CODING_AGENT_DIR` or `~/.pi/agent`. A missing file means disabled. An invalid or unreadable file, or a group/other permission bit on the directory or file, fails closed: the runtime notifies and uses the fallback. Writes create the directory `0700` and the file `0600`. Headless sessions only consume prior consent.

Gate. When review is required and the latest `reviewed` event for the current hash is not `decision: "accept"`, `accept` fails and persists nothing. With UI the message is `Spec review required before accept: call execute_checkpoint review for <specPath>`. Without UI it is `Spec review required; it needs an interactive session`. A recorded review decision is durable: when the latest `reviewed` event (log order) for the current hash has `decision: "stop"` or `"revise"`, `accept` fails before the trigger runs and persists nothing, regardless of UI or what the trigger would return. The message is `Spec review recorded "<decision>" for this Spec hash; revise the Spec (a new hash) before accept`.

Round. `review` takes `specPath` and `focus`: exactly two distinct, non-empty, single-line statements with no leading or trailing whitespace. It needs interactive UI. It fails when the current hash is already accepted or reviewed, when a round for the hash is already live, or when review is not required. Its output adds `review: {round, limit, note}` and a `dispatchPrefix` that starts with `Spec review binding:`. The runtime then binds `subagent` calls whose task starts with that prefix. Each call must use agent `spec-reviewer`, the exact `SpecReviewReportSchema`, no `cwd`, and exactly one `Focus: <statement>` line that names a declared focus. At most two calls are bound at a time, and each focus is bound once. A failed or invalid report permits one more call for that focus. Any other call with the prefix is blocked: wrong agent, schema or focus, `cwd`, an extra call, or a stale prefix. The runtime takes each report only from the run-bound `structuredContent.structuredOutput`; main never submits findings.

`SpecReviewReportSchema` (in `schema.ts`) is `{findings: [{id, severity: "high"|"medium"|"low", target, why, change}], questions: [{id, question, options}]}`. `target` is `DC-n`, `US-n`, `Plan`, or `Scope`. A report has at most 50 findings and 5 questions, and each question has 2–4 options. The [`execute` skill](../../skills/execute/SKILL.md) carries the exact JSON Schema for main.

Resolution. `resolve_review` takes `specPath` and needs interactive UI and both reports of the live round. It displays all findings as a `spec-review` custom message. It asks each question through `ctx.ui.select`, then asks the gate `Accept as reviewed` or `Revise`. It appends `reviewed {ts, hash, round, trigger, decision, answers, findings}` with the user's actual choice. Each answer is `{id, focus, question, answer}`: question IDs are scoped per report, so `id` is `<slot>:<questionId>` with the reviewer focus slot (`0` or `1`), and `focus` and `question` carry that reviewer's focus statement and the question text. A limit round records `answers: []`. Its output field `review` returns `round`, `limit`, `note`, `decision`, `answers`, and the findings. A cancelled prompt, a lost authorization, or a Spec change during the prompts records nothing.

Round limit. A Spec gets at most two review rounds, counted as distinct hashes with `reviewed` events. When a third hash still requires review, `review` returns `limit: true` and a null `dispatchPrefix`, and starts no children. `resolve_review` then asks only `Accept as is` or `Stop` and records `decision: "accept"` or `"stop"` with `findings: 0`.

Review actions never change the ledger. Their output carries the current ledger unchanged. Stop, reload, tree navigation, and shutdown clear live review rounds and bindings.

## Safety, lifecycle and completion

Main records whole-plan conservative danger preflight and explicit user approval for consequential actions, respects trust, and scopes work to the session workspace. Stored approval text is a decision record, not independent consent enforcement. Workers receive the canonical plan, exact write scope, references, done criteria, and canonical TDD guidance for behavior changes/fixes. Detached executors cannot manage the ledger.

Calls block, with at most four children per parent. Runner cancellation kills owned queued/active children on tool abort or parent shutdown, preserves saved owner-only evidence, and cleans finished tmux sessions. It does not undo edits or terminate independently detached processes. Checkpoint `stop` revokes ledger/marked-dispatch authorization and aborts the parent operation to cancel active runner calls. Abort/error settlement and shutdown revoke authorization. No automatic continuation follows a stop/reload/tree boundary; a new explicit command and current-state reconciliation are required.

Internal `StructuredOutput` validates report shape, with one runner end-of-run correction if absent; this is not a mutation-repair attempt. It does not prove model adherence or correctness. Main independently inspects files, runs current targeted tests and diagnostics/checks, records actual evidence, and reports unresolved IDs, exact blockers and non-blocking follow-ups. These deterministic boundaries have mocked integration/unit coverage; real child lifecycle validation belongs to the subagent runner, not these ledger tests.
