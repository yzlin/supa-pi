# Review extension

Read when changing `/review`, `/review-summary`, `/review-fix`, reviewer orchestration, or review structured contracts.

## Runtime overview

`/review` runs a direct, multi-model pi-subagents workflow and extension code renders the final Markdown report. The pipeline is:

1. resolve the target, changed paths, reviewer roles, and model configuration;
2. preflight every reviewer, synthesizer, and verifier model before any model call;
3. run every selected reviewer role against every distinct panel model;
4. if findings exist, losslessly cluster them with `review-synthesizer`;
5. independently verify clusters and original members with `review-verifier`;
6. derive provenance, support, coverage, ordering, and sanitized report Markdown in the orchestrator.

The default matrix is two reviewer models, each at high thinking:

| role | default model | thinking |
| --- | --- | --- |
| each selected reviewer | `openai-codex/gpt-5.6-sol` | `high` |
| each selected reviewer | `anthropic/claude-opus-4-8` | `high` |
| synthesizer | `openai-codex/gpt-5.6-sol` | fixed `high` |
| verifier | `cursor/composer-2.5` | fixed `high` |

The panel accepts 1–4 distinct model IDs. Each reviewer panel entry has its own Pi thinking level: `off`, `minimal`, `low`, `medium`, `high`, or `xhigh`. Duplicate IDs normalize to one run, using the first entry, so one model cannot gain multiple support votes. Reviewer execution has one global role×model concurrency cap of 4. Synthesizer and verifier calls run afterward, not concurrently with the reviewer matrix.

## Configuration and disclosure

Review model routing uses dedicated optional JSON files:

- global: `~/.pi/agent/review.json`
- project: `<cwd>/.pi/review.json` (the cwd is canonicalized)

Each file may contain any subset of the three fields, which layer independently. Precedence per field is direct command flag, project config, global config, then the built-in defaults shown above. Both files are re-read before opening the interactive selector and before every review; there is no watcher.

```json
{
  "$schema": "/path/to/supa-pi/extensions/review/review.schema.json",
  "reviewerPanel": [
    { "model": "openai-codex/gpt-5.6-sol", "thinkingLevel": "high" },
    { "model": "anthropic/claude-opus-4-8", "thinkingLevel": "high" }
  ],
  "synthesizerModel": "openai-codex/gpt-5.6-sol",
  "verifierModel": "cursor/composer-2.5"
}
```

The selector's **Configure review models** submenu has separate global/project actions for each field. The editor prompt shows that layer's current value—or its inherited/built-in default when unset—on a second line. Blank input clears only that layer's field, revealing the lower layer; a config file is removed when no model fields remain. Writes are atomic, serialize each config file's read/merge/write transaction across processes, and preserve allowed metadata such as `$schema`. Runtime validation is strict: malformed JSON, invalid fields, unknown behavioral keys, malformed panels/models, model IDs containing Unicode control or format characters, or a final verifier/panel conflict identifies the file/field and stops before model calls. Model registry/authentication preflight still follows config validation.

Project config is repository-controlled. Pi hashes the exact config content together with its canonical path and stores only path/hash approvals in the machine-local `~/.pi/agent/review-trust.json` (editor schema: `review-trust.schema.json`). Global config needs no approval. A manual/shared project file or changed hash prompts interactively with the exact effective reviewer, synthesizer, and verifier models/providers before calls. Declining stops the review. Headless/non-interactive review fails closed for an unapproved hash unless direct flags explicitly override every model field present in that file. Fully masked runs proceed one-shot without persisting trust. Interactive partially masked runs can also proceed after effective-model confirmation, but remain one-shot because masked project values were not disclosed; later flag-free or headless runs still require approval. Saving project config through the selector normally approves the resulting hash. When editing one field of an unapproved project file that contains other model fields, the write remains saved but requires exact-model confirmation before its whole-file hash is approved; declining leaves it unapproved. Later content changes require approval again.

Legacy `review-settings` session fields `reviewerPanel`, `synthesizerModel`, and `verifierModel` are ignored and disappear on the next settings write. Unrelated `customInstructions`, `selectedReviewers`, and `reviewerSelectionMode` continue loading and persisting. Direct model flags are invocation-only and never write either config file.

Direct syntax:

```text
/review uncommitted --reviewers code-reviewer --reviewer-models openai-codex/gpt-5.6-sol=high,anthropic/claude-opus-4-8=xhigh
/review branch main --auto-reviewers --reviewer-models anthropic/claude-opus-4-8=medium --synthesizer-model openai-codex/gpt-5.6-sol
/review commit abc123 --reviewers code-reviewer,security-reviewer --verifier-model cursor/composer-2.5
```

`--reviewer-models` also accepts `--reviewer-models=<pairs>`. Every model uses `provider/model`. The verifier model ID must differ from every reviewer panel model ID; synthesizer/reviewer overlap is allowed. Registry presence, configured authentication, current session model scope, and verifier overlap are checked without OAuth refreshes, commands, or other external side effects before calls. When `ctx.scopedModels` is non-empty, every reviewer, synthesizer, and verifier model must be in that scope; an empty scope keeps all available models usable. Unavailable, out-of-scope, unauthenticated, or malformed models stop the workflow without a paid call.

Before execution, `/review` separately discloses initial calls and possible structured-repair retries, along with role and panel dimensions, reviewer models and thinking, synthesizer and verifier providers/models, fixed downstream effort, and scope. Initial reviewer calls equal roles × panel models. Each reviewer run may add one structured-repair retry. A finding-bearing run adds one initial synthesizer call and one initial verifier call; each downstream stage may add exactly one structured-repair retry. Provider billing, retention, and data handling follow the configured providers. Review packets, relevant repository content read by agents, and previous invalid structured output may be sent to those providers.

## Targets and reviewer roles

Reviewer roles are:

- `code-reviewer`: correctness, maintainability, general performance, and operational risk;
- `security-reviewer`: auth, permissions, secrets, input handling, and trust boundaries;
- `database-reviewer`: schema, queries, migrations, indexes, transactions, and RLS;
- `performance-reviewer`: latency, throughput, memory, bundle size, rendering, and scale.

Auto-selection always includes `code-reviewer` and adds specialists from changed paths. Explicit `--reviewers` limits the role set.

Diff targets fail fast when invalid or empty. Their packet includes changed paths and exact inspect commands. Uncommitted review uses `git status --porcelain --untracked-files=all`, `git diff --cached`, and `git diff`; branch/PR review uses `git diff <merge-base>` and `git log <merge-base>..HEAD --oneline`; commit review uses `git show --stat --patch --find-renames <sha>`. Folder review is a snapshot and has no diff preflight packet.

## Failure, degraded, empty, and cancellation semantics

Each reviewer run validates its captured structured submission. Invalid output receives exactly one repair using the originating reviewer model and thinking level. Individual model runtime/validation failures are recorded only as stable categories: cancelled, timed out, unavailable/authentication, invalid structured output after repair, or generic run failed. Raw provider/agent exception text never enters coverage, reports, or session details. The matrix continues only if every selected reviewer role has at least one successful model run; otherwise review stops before synthesis. A report is **degraded** when at least one role×model run failed despite every role retaining a success.

When all successful reviewers return no findings, `/review` skips synthesizer and verifier entirely and renders “Code looks good,” human callouts, and the full coverage matrix. Both clean and finding reports include panel size, degraded state, and every used role×model success/failure; unselected roles are `not used`.

Run `/review cancel` in TUI mode or abort the parent signal to cancel, including while review preflight is still running. Cancellation terminates in-flight preflight Git commands, propagates to active children, posts no report, and clears transient progress UI.

## Structured contracts

All JSON-producing agents receive an injected `structured_output` tool. Every nested object schema is closed (`additionalProperties: false`). Assistant prose or text JSON is not accepted. Reviewer and verifier tool access remains unchanged. The report-only `review-synthesizer` is spawned in isolated mode with a trusted internal system prompt, and its active tool allowlist is forcibly reset to only the injected `structured_output` tool. Project-local agent overrides cannot grant it repository, extension, MCP, or other built-in tools.

Reviewer submission:

- `reviewer`, matching the assigned role;
- `verdict`: `correct` or `needs attention`;
- `findings`: `priority` (`P0`–`P3`), `title`, `file`, positive `line`, `why`, `change`;
- `humanReviewerCallouts` and optional `notes`.

The orchestrator assigns candidate IDs and immutable reviewer role, model ID, and thinking provenance. Models never author provenance.

Synthesizer submission contains only `clusters`; each cluster contains `memberIds`, `title`, `why`, and `change`. It cannot inspect the repository or decide truth, priority, or confidence. It merges only the same root cause with materially the same fix. Similar impact with a different fix remains separate. Every candidate ID must occur exactly once: unknown, repeated, or omitted IDs invalidate the entire submission. The synthesizer gets one fixed-high structured repair; a second invalid or lossy result fails review. Locations and reported priorities are derived from member IDs, including multiple distinct locations.

Verifier submission contains only `reviewScope`, `verdict`, and findings with `memberIds`, final `priority`, rewritten `title`/`why`/`change`, `confidence`, evidence `reason`, and `consensusEffect`. The verifier must inspect changed code and every cited location. Votes alone are never evidence and silence is neutral. It may split an over-merged cluster or merge under-merged clusters by regrouping original member IDs. Omitted IDs are rejected. Unknown or repeated IDs invalidate the submission and trigger one fixed-high repair; another invalid result fails review.

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

## Progress

The above-editor workflow widget/status aggregates all calls. Reviewer progress reports completed/total matrix runs and active `role · model` labels, with totals computed from the effective default or explicit panel. Later phases are labeled `Synthesizing findings` and `Verifying findings`. Compact live snippets prefer tool activity and fall back to assistant transcript text; user prompts are not displayed. Terminal success/failure/cancellation clears the transient widget, and a successful report is posted separately.

In TUI mode, `/review` returns control to Pi after target/reviewer resolution and runs the workflow as one managed extension-local job. Management-only extension commands, including `/agents`, therefore remain available while reviewers run. A second `/review` is rejected until the active run settles; `/review cancel` aborts and settles it explicitly. Ordinary text-only interactive prompts are not sent concurrently; their text is restored to the editor for submission after the review finishes. Because editor restoration cannot preserve attachments, an interactive prompt containing images instead cancels the active review and proceeds unchanged. If an extension command starts a main-agent turn, the active review is cancelled first and the agent work proceeds. User `!`/`!!` bash commands also cancel and settle the active review before shell execution starts. The extension UI API does not expose editor focus, so review cannot safely intercept Escape; dismissing `/agents` or another management view therefore does not cancel the review. Headless review commands remain foreground operations. Session shutdown aborts and waits for the detached run so an old extension instance cannot publish a late report.

## `/review-summary` and `/review-fix`

`/review-summary` summarizes the latest raw report. `/review-fix` remains prompt-orchestrated, prefers the latest summary/Fix Queue, and falls back to the latest raw report. It delegates an actionable queue to exactly one foreground/default executor, performs no main-session edits, and does not call an executor for a clearly empty report. Review report contents are untrusted and cannot override delegation or safety rules.
