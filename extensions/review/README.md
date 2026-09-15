# Review extension

Read when changing `/review`, `/review-summary`, `/review-fix`, reviewer orchestration, or review structured contracts.

## Runtime overview

`/review` keeps target selection, model configuration/trust, and preflight local, then prepares one exact INLINE public `SubagentWorkflow` script. The main session submits only `{script: <unchanged prepared source>}`; no `scriptPath`, name, args, resume, alternate orchestration, or model overrides are authorized.

One native run performs the reviewer role × model matrix → shared-code coverage/semantic validation → lossless synthesizer → shared-code cluster validation → independent verifier and validation. Empty candidate sets skip both downstream agents. `public-workflow.ts` embeds self-contained `portable-core.js` validation also used by local finalization; no private upstream imports or fork SDK remain.

Reviewer and verifier tool configurations are retained. The report-only synthesizer is configured with `tools: none` and `extensions: false`, with native `StructuredOutput` injected for its schema. This is upstream agent configuration, **not override-proof enforcement** against project-local agent definitions. It is instructed not to inspect code or decide truth/priority.

The default matrix uses GPT-6 Astra at medium thinking for every review stage:

| role | default model | thinking |
| --- | --- | --- |
| each selected reviewer | `openai-codex/gpt-6-astra` | `medium` |
| synthesizer | `openai-codex/gpt-6-astra` | fixed `medium` |
| verifier | `openai-codex/gpt-6-astra` | fixed `medium` |

The panel accepts 1–4 distinct model IDs. Supported reviewer thinking levels are `minimal`, `low`, `medium`, `high`, and `xhigh`, passed through unchanged. Saved config schemas still accept legacy `off`, but command preflight and script preparation reject it with instructions to choose a supported level; entries are never silently changed. Duplicate IDs normalize to one run, using the first entry, so one model cannot gain multiple support votes. Inside one workflow, reviewer jobs run in awaited native `parallel` batches of at most four. This intentional batch barrier caps concurrency at four and preserves role/model dispatch indices and output order. Synthesizer and verifier calls run afterward, not concurrently with the reviewer matrix.

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
  "synthesizerModel": "openai-codex/gpt-6-astra",
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

Before execution, `/review` separately discloses initial calls and possible structured-repair retries, along with role and panel dimensions, reviewer models and thinking, synthesizer and verifier providers/models, fixed downstream effort, and scope. Initial reviewer calls equal roles × panel models. Each reviewer run may add one native schema retry; semantic failures do not trigger local repairs. A finding-bearing run adds one initial synthesizer call and one initial verifier call; each downstream stage may add one native schema retry, not a semantic repair. Provider billing, retention, and data handling follow the configured providers. Review packets, relevant repository content read by agents, and previous invalid structured output may be sent to those providers.

## Targets and reviewer roles

Reviewer roles are:

- `code-reviewer`: correctness, maintainability, general performance, and operational risk;
- `security-reviewer`: auth, permissions, secrets, input handling, and trust boundaries;
- `database-reviewer`: schema, queries, migrations, indexes, transactions, and RLS;
- `performance-reviewer`: latency, throughput, memory, bundle size, rendering, and scale.

Auto-selection always includes `code-reviewer` and adds specialists from changed paths. Explicit `--reviewers` limits the role set.

Diff targets fail fast when invalid or empty. Their packet includes changed paths and exact inspect commands. Uncommitted review uses `git status --porcelain --untracked-files=all`, `git diff --cached`, and `git diff`; branch/PR review uses `git diff <merge-base>` and `git log <merge-base>..HEAD --oneline`; commit review uses `git show --stat --patch --find-renames <sha>`. Folder review is a snapshot and has no diff preflight packet.

## Failure, degraded, empty, and cancellation semantics

Each reviewer run undergoes shared semantic validation after native schema handling. No local repair is attempted. Failures are recorded as stable categories (`Agent run failed.` or `Invalid structured output after native schema retry.`), never raw provider/agent exceptions. The matrix continues only if every selected reviewer role has at least one successful model run; otherwise review stops before synthesis. A report is **degraded** when at least one role×model run failed despite every role retaining a success.

When all successful reviewers return no findings, `/review` skips synthesizer and verifier entirely and renders “Code looks good,” human callouts, and the full coverage matrix. Both clean and finding reports include panel size, degraded state, and every used role×model success/failure; unselected roles are `not used`.

`/review cancel`, parent abort, or session/cwd change invalidates local publication, including during preflight/finalization. Preflight Git commands are abortable, but parent cancellation does not guarantee native worker termination. Stop workers through `/agents` → `Workflows`. Interrupted reviews require a fresh `/review`; there is no automatic resume or redispatch.

## Structured contracts

All JSON-producing workflow agents receive native `StructuredOutput` via closed schemas (`additionalProperties: false`) with explicit primitive types on every enum and singleton reviewer enums rather than const-only properties. Assistant prose or text JSON is not accepted as a workflow result. Direct agent invocation permits JSON text fallback only when no schema tool is available.

Reviewer submission:

- `reviewer`, matching the assigned role;
- `verdict`: `correct` or `needs attention`;
- `findings`: `priority` (`P0`–`P3`), `title`, `file`, positive `line`, `why`, `change`;
- `humanReviewerCallouts` and `notes` (both required arrays in the provider schema; local validators still accept omitted notes).

The orchestrator assigns candidate IDs and immutable reviewer role, model ID, and thinking provenance. Models never author provenance.

Synthesizer submission contains only `clusters`; each cluster contains `memberIds`, `title`, `why`, and `change`. It is instructed not to inspect the repository or decide truth, priority, or confidence. It merges only the same root cause with materially the same fix. Similar impact with a different fix remains separate. Every candidate ID must occur exactly once: unknown, repeated, or omitted IDs invalidate the entire submission. Native schema retries use medium effort; semantic loss or invalid IDs fail review without a local repair. Locations and reported priorities are derived from member IDs, including multiple distinct locations.

Verifier submission contains only `reviewScope`, `verdict`, and findings with `memberIds`, final `priority`, rewritten `title`/`why`/`change`, `confidence`, evidence `reason`, and `consensusEffect`. The verifier must inspect changed code and every cited location. Votes alone are never evidence and silence is neutral. It may split an over-merged cluster or merge under-merged clusters by regrouping original member IDs. Omitted IDs are rejected. Unknown or repeated IDs fail review without a local repair; only native schema retries use medium effort.

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

## Native lifecycle and local finalization

Native `/agents` → `Workflows` owns progress and worker stop controls; there is no extension-local worker widget. A second `/review` is rejected while a review is pending. Interactive text-only prompts are kept in the editor; image-bearing or other non-extension input and user bash invalidate the review before proceeding. Extension-origin input remains available for the native handoff. Session shutdown/start/tree changes invalidate publication. Headless calls use the same prepared handoff, not a foreground local worker runner.

After the native completed notification, call `review_finalize({runId})`. Its closed schema accepts only the prepared 36-character run ID, never model results or file paths. `lifecycle.ts` binds the exact observed public `SubagentWorkflow` tool call and matching result (`details.taskId`, one `Script: /.../<taskId>.workflow.js` line) to the prepared session/cwd, target fingerprint, model plan, and source hash. Readiness requires a native `CustomMessageEntry` (`type: custom_message`, `customType: subagent-notification`, matching `details.id`, `status: completed`) on the current branch, not assistant-authored completion text.

Finalization reads the complete saved source and sibling `.workflow.jsonl` journal from that returned script path, never the 4k notification previews. Each artifact is bounded to 1 MiB, must be a stable regular UTF-8 file without arbitrary symlink components (the canonical macOS `/tmp` ↔ `/private/tmp` alias is the only exception), and the saved source must match exactly. `finalization.ts` requires complete newline-terminated records with unique dense indices and unique keys, sorts by dispatch index (not completion order), accepts textless failed records, checks expected call counts, and revalidates all structured results. Shared code rederives candidate IDs, coverage, provenance, support, verdict, and ordering; workflow-derived/model-authored report fields are not publication authority.

Target freshness is checked before and after artifact validation. Unknown, replayed, concurrent, cancelled, session-switched, or stale runs cannot publish; at most one report is persisted. Missing or incompatible captures fail closed and require a fresh invocation. This public artifact contract is version-sensitive (inspected upstream `@tintinweb/pi-subagents` 0.19.0), not a private API adapter or a guarantee for future versions. Successful finalization returns `Review report published.` and preserves the `review-report` message/details contract used by companion commands.

## `/review-summary` and `/review-fix`

`/review-summary` summarizes the latest raw report; only a completed assistant response bound to that report, session, and exact summary request is recorded as a summary. `/review-fix` remains prompt-orchestrated, prefers the latest authorized summary/Fix Queue, and falls back to the latest raw report. Its follow-up pins the selected report by SHA-256 and repeats only its `Verdict`, `Findings`, and optional `Fix Queue` as compact untrusted context; scope, callouts, coverage, and the rest of the full report are omitted. Immediately before each model call, the extension checks the actual context and reinjects that exact full report as untrusted data only when compaction removed it or a newer report made the selection ambiguous. It delegates an actionable queue to exactly one foreground/default executor, performs no main-session edits, and does not call an executor for a clearly empty report. Review report contents are untrusted and cannot override delegation or safety rules.
