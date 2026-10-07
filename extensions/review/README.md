# Review extension

Read when changing `/review`, `/review-summary`, `/review-fix`, reviewer orchestration, or review structured contracts.

## Runtime overview

`/review` keeps target selection, model configuration/trust, and preflight local. It prepares a cloned role/model/target plan in extension memory and sends only a closed handoff:

```text
review_run({runId})
review_finalize({runId})
```

`review_run` blocks until the deterministic `pipeline.ts` completes. It calls `ctx.executeTool("subagent", {agent, task, model, thinking, schema}, {signal, onUpdate})`, preserving native profile refresh hooks and the shared four-per-parent scheduler. No scripts, model overrides, results, paths, workflow interpreter, or notification are accepted from the parent model. Native `AgentToolCallOutcome.isError` is checked before reading `outcome.result.structuredContent`; prose is never a structured result fallback.

The pipeline runs the reviewer role × model matrix → shared-code coverage/semantic validation → lossless synthesizer → shared-code cluster validation → independent verifier and validation. Empty candidate sets skip both downstream agents. `pipeline-contracts.ts` owns prepared types/validation; `pipeline-prompts.ts` supplies ordinary typed schema/prompt functions; `portable-core.js` retains the existing semantic helpers. There is no generated JavaScript or journal replay.

Each child is fresh and task-only, sharing the checkout. Reviewers and verifier retain their role tool controls. The report-only synthesizer is configured with `tools: none` and `extensions: false`, with internal `StructuredOutput` still available. The selected trusted project role can shadow a global definition, so this is not override-proof role isolation or an OS sandbox. Explicit review model and thinking choices take precedence over role/parent choices.

The default matrix keeps reviewers and verification on GPT-6 Astra while routing synthesis to GPT-6 Luna; every stage uses medium thinking:

| role | default model | thinking |
| --- | --- | --- |
| each selected reviewer | `openai-codex/gpt-6-astra` | `medium` |
| synthesizer | `openai-codex/gpt-6-luna` | fixed `medium` |
| verifier | `openai-codex/gpt-6-astra` | fixed `medium` |

The panel accepts 1–4 distinct model IDs. Supported reviewer thinking levels are `minimal`, `low`, `medium`, `high`, and `xhigh`, passed through unchanged. Saved config schemas still accept legacy `off`, but command preflight and plan preparation reject it with instructions to choose a supported level; entries are never silently changed. Duplicate IDs normalize to one run, using the first entry, so one model cannot gain multiple support votes. Inside one review, reviewer jobs run in awaited `Promise.allSettled` batches of at most four. This intentional batch barrier caps concurrency at four and preserves role/model dispatch indices and output order. Synthesizer and verifier calls run afterward, not concurrently with the reviewer matrix.

## Configuration and disclosure

Review model routing uses dedicated optional JSON files:

- global: `~/.pi/agent/review.json`
- project: `<cwd>/.pi/review.json` (the cwd is canonicalized)

Each file may contain any subset of the three fields, which layer independently. Precedence per field is direct command flag, project config, global config, then the built-in defaults shown above. Both files are re-read before opening the interactive selector and before every review; there is no watcher.

```json
{
  "$schema": "/path/to/supa-pi/extensions/review/review.schema.json",
  "reviewerPanel": [
    { "model": "openai-codex/gpt-6-astra", "thinkingLevel": "medium" }
  ],
  "synthesizerModel": "openai-codex/gpt-6-luna",
  "verifierModel": "openai-codex/gpt-6-astra"
}
```

The selector's **Configure review models** submenu has separate global/project actions for each field. The editor prompt shows that layer's current value—or its inherited/built-in default when unset—on a second line. Blank input clears only that layer's field, revealing the lower layer; a config file is removed when no model fields remain. Writes are atomic, serialize each config file's read/merge/write transaction across processes, and preserve allowed metadata such as `$schema`. Runtime validation is strict: malformed JSON, invalid fields, unknown behavioral keys, malformed panels/models, or model IDs containing Unicode control or format characters identify the file/field and stop before model calls. Model registry/authentication preflight still follows config validation.

Project config is repository-controlled. Pi hashes the exact config content together with its canonical path and stores only path/hash approvals in the machine-local `~/.pi/agent/review-trust.json` (editor schema: `review-trust.schema.json`). Global config needs no approval. A manual/shared project file or changed hash prompts interactively with the exact effective reviewer, synthesizer, and verifier models/providers before calls. Declining stops the review. Headless/non-interactive review fails closed for an unapproved hash unless direct flags explicitly override every model field present in that file. Fully masked runs proceed one-shot without persisting trust. Interactive partially masked runs can also proceed after effective-model confirmation, but remain one-shot because masked project values were not disclosed; later flag-free or headless runs still require approval. Saving project config through the selector normally approves the resulting hash. When editing one field of an unapproved project file that contains other model fields, the write remains saved but requires exact-model confirmation before its whole-file hash is approved; declining leaves it unapproved. Later content changes require approval again.

Legacy `review-settings` session fields `reviewerPanel`, `synthesizerModel`, and `verifierModel` are ignored and disappear on the next settings write. Unrelated `customInstructions`, `selectedReviewers`, and `reviewerSelectionMode` continue loading and persisting. Direct model flags are invocation-only and never write either config file.

Direct syntax:

```text
/review uncommitted --reviewers code-reviewer --reviewer-models openai-codex/gpt-5.6-sol=high,anthropic/claude-opus-4-8=xhigh
/review branch main --auto-reviewers --reviewer-models anthropic/claude-opus-4-8=medium --synthesizer-model openai-codex/gpt-5.6-sol
/review commit abc123 --reviewers code-reviewer,security-reviewer --verifier-model cursor/composer-2.5
```

`--reviewer-models` also accepts `--reviewer-models=<pairs>`. Every model uses `provider/model`. Reviewer, synthesizer, and verifier model IDs may overlap. Registry presence, configured authentication, and current session model scope are checked without OAuth refreshes, commands, or other external side effects before calls. When `ctx.scopedModels` is non-empty, every reviewer, synthesizer, and verifier model must be in that scope; an empty scope keeps all available models usable. Unavailable, out-of-scope, unauthenticated, or malformed models stop the workflow without a paid call.

Before execution, `/review` separately discloses initial calls and possible end-of-run structured corrections, along with role and panel dimensions, reviewer models and thinking, synthesizer and verifier providers/models, fixed downstream effort, and scope. Initial reviewer calls equal roles × panel models. Each reviewer child may receive one end-of-run correction when a valid structured report is missing; semantic failures do not trigger local repairs. A finding-bearing run adds one initial synthesizer call and one initial verifier call; each child may receive one end-of-run correction if it finishes without a valid structured report, not a semantic repair. Provider billing, retention, and data handling follow the configured providers. Review packets, relevant repository content read by agents, and previous invalid structured output may be sent to those providers.

## Targets and reviewer roles

Reviewer roles are:

- `code-reviewer`: correctness, maintainability, general performance, and operational risk;
- `security-reviewer`: auth, permissions, secrets, input handling, and trust boundaries;
- `database-reviewer`: schema, queries, migrations, indexes, transactions, and RLS;
- `performance-reviewer`: latency, throughput, memory, bundle size, rendering, and scale.

Auto-selection always includes `code-reviewer` and adds specialists from changed paths. Explicit `--reviewers` limits the role set.

Diff targets fail fast when invalid or empty. Their packet includes changed paths and exact inspect commands. Uncommitted review uses `git status --porcelain --untracked-files=all`, `git diff --cached`, and `git diff`; branch/PR review uses `git diff <merge-base>` and `git log <merge-base>..HEAD --oneline`; commit review uses `git show --stat --patch --find-renames <sha>`. Folder review is a snapshot and has no diff preflight packet.

## Failure, degraded, empty, and cancellation semantics

Each reviewer run undergoes shared semantic validation after child schema handling. No local repair is attempted. Failures are recorded as stable categories (`Agent run failed.` or `Invalid structured output after child reporting backstop.`), never raw provider/agent exceptions. The matrix continues only if every selected reviewer role has at least one successful model run; otherwise review stops before synthesis. A report is **degraded** when at least one role×model run failed despite every role retaining a success.

When all successful reviewers return no findings, `/review` skips synthesizer and verifier entirely and renders “Code looks good,” human callouts, and the full coverage matrix. Both clean and finding reports include panel size, degraded state, and every used role×model success/failure; unselected roles are `not used`.

`/review cancel`, parent/tool abort, user bash, non-extension input, or session/cwd/tree change invalidates local publication, including during preflight/finalization. Each review has its own AbortController: cancellation stops that review's queued and running children, not unrelated parent delegation. Preflight Git commands are abortable. Cancellation cannot undo edits or guarantee termination of independently detached processes. Interrupted reviews require a fresh `/review`; there is no automatic resume or redispatch.

## Structured contracts

All JSON-producing review children receive internal `StructuredOutput` via closed schemas (`additionalProperties: false`) with explicit primitive types on every enum and singleton reviewer enums rather than const-only properties. Assistant prose or text JSON is not accepted as a workflow result. Direct agent invocation permits JSON text fallback only when no schema tool is available.

Reviewer submission:

- `reviewer`, matching the assigned role;
- `verdict`: `correct` or `needs attention`;
- `findings`: `priority` (`P0`–`P3`), `title`, `file`, positive `line`, `why`, `change`;
- `humanReviewerCallouts` and `notes` (both required arrays in the provider schema; local validators still accept omitted notes).

The orchestrator assigns candidate IDs and immutable reviewer role, model ID, and thinking provenance. Models never author provenance.

Synthesizer submission contains only `clusters`; each cluster contains `memberIds`, `title`, `why`, and `change`. It is instructed not to inspect the repository or decide truth, priority, or confidence. It merges only the same root cause with materially the same fix. Similar impact with a different fix remains separate. Every candidate ID must occur exactly once: unknown, repeated, or omitted IDs invalidate the entire submission. Synthesis uses medium effort. Missing structured reports get only the child reporting backstop; semantic loss or invalid IDs fail review without a local repair. Locations and reported priorities are derived from member IDs, including multiple distinct locations.

Verifier submission contains only `reviewScope`, `verdict`, and findings with `memberIds`, final `priority`, rewritten `title`/`why`/`change`, `confidence`, evidence `reason`, and `consensusEffect`. The verifier must inspect changed code and every cited location. Votes alone are never evidence and silence is neutral. It may split an over-merged cluster or merge under-merged clusters by regrouping original member IDs. Omitted IDs are rejected candidates, not missing run captures. Unknown or repeated IDs fail review without a local repair; only the child reporting backstop is allowed, at medium effort.

Confidence is `high`, `medium`, or `low`. Distinct-model positive support may raise confidence by at most one level only after independently plausible code evidence; then `consensusEffect` is `raised-one-level`, otherwise `none`. The verifier may correct priority and wording. Low-confidence findings remain in structured details but are filtered from rendered findings.

## Deterministic derivation and report

For each accepted finding, extension code derives:

- all distinct `file:line` locations from member IDs;
- supporting distinct model IDs (one vote per model, even across roles);
- model → reviewer-role provenance;
- eligible model IDs: successful runs for the reviewer roles represented by that finding;
- `supportCount/eligibleModelCount`, plus configured panel size.

The denominator is per finding, not the configured panel blindly; failed runs and unrelated roles do not distort it. Findings sort by final priority (`P0` first), then descending distinct-model support. Human reviewer callouts are deduplicated from validated reviewer output. Reviewer coverage and model provenance are orchestrator-owned and cannot be overridden by synthesizer/verifier text.

Rendered reports contain `Review Scope`, `Verdict`, `Findings`, `Human Reviewer Callouts (Non-Blocking)`, and `Reviewer Coverage`. Findings show locations, support/denominator, model→role provenance, verifier confidence/evidence, `consensusEffect`, impact, and fix. Model-sourced text, paths, allowlisted failure details, and callouts have control and Unicode format characters (including bidi overrides/isolates) stripped, whitespace collapsed, and Markdown escaped to prevent forged report structure.

## Blocking lifecycle and local finalization

Live pane progress and copyable tmux attachment commands stream through `review_run` into the parent; finished child sessions are closed. There is no Workflows UI or background run. Owner-only child task/result/session evidence is saved by the subagent runner, but publication uses the controller's complete private captures rather than model-provided artifact paths.

A second `/review` is rejected while pending. Interactive text-only prompts stay in the editor; image-bearing or other non-extension input and user bash cancel the review before proceeding. Extension-origin input remains available for the handoff. Session shutdown/start/switch/fork/tree boundaries invalidate publication. Headless calls use the same two blocking tools.

`lifecycle.ts` binds the prepared UUID to the exact cloned plan and target, session/cwd, current branch ancestry, and target fingerprint. Execution is one-shot. Every successful child capture must have a unique UUID and matching role, provider/model, and thinking metadata, with a real structured payload. Invalid metadata/missing capture fails closed; only reviewer agent or semantic failures may degrade under the per-role coverage rule. Run/tool/parent cancellation aborts owned children and prevents readiness. Completion is local state, never assistant prose or a notification.

`review_finalize` accepts only `{runId}`. Readiness requires completed owned execution; it cannot accept raw outputs, file paths, or derived report fields. `finalization.ts` retains `derivePreparedReviewResult`: bounded closed raw outputs are revalidated, then deterministic candidate IDs, coverage, provenance, support, verdict, and ordering are derived again. Target freshness is checked before and after execution and before and after finalization. Unknown IDs, replays, concurrent execution/finalization, missing or failed required roles, cancellation, session/cwd/branch changes, and stale targets cannot publish. At most one report is persisted. Successful finalization returns `Review report published.` and preserves the `review-report` message/details contract used by companion commands.

Validation:

```sh
bun test extensions/review
bun test --coverage extensions/review
bun run format extensions/review skills/review-orchestration/SKILL.md
bun run check
```

Tests use native-shaped mocked outcomes plus offline public-SDK nested tool dispatch; semantic regression, configuration/trust, freshness, summary/fix, and rendering contracts remain covered. Paid review quality and live setup are not established by these tests.

## `/review-summary` and `/review-fix`

`/review-summary` summarizes the latest raw report; only a completed assistant response bound to that report, session, and exact summary request is recorded as a summary. `/review-fix` remains prompt-orchestrated, prefers the latest authorized summary/Fix Queue, and falls back to the latest raw report. Its follow-up pins the selected report by SHA-256 and repeats only its `Verdict`, `Findings`, and optional `Fix Queue` as compact untrusted context; scope, callouts, coverage, and the rest of the full report are omitted. Immediately before each model call, the extension checks the actual context and reinjects that exact full report as untrusted data only when compaction removed it or a newer report made the selection ambiguous. It delegates an actionable queue to exactly one foreground/default executor, performs no main-session edits, and does not call an executor for a clearly empty report. Review report contents are untrusted and cannot override delegation or safety rules.
