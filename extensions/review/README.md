# Review extension

Read when changing `/review`, `/review-summary`, `/review-fix`, reviewer-agent orchestration, or review prompt contracts.

## `/review` reviewer orchestration

`/review` runs a direct pi-subagents workflow. The extension builds a typed review packet, launches every selected reviewer agent, validates their structured submissions, merges duplicate candidate findings, and renders the final Markdown report. It launches `review-verifier` only when reviewer agents return at least one candidate finding:

- `code-reviewer` for general correctness, maintainability, performance, and operational risk.
- `security-reviewer` for auth, permissions, secrets, input handling, and unsafe trust boundaries.
- `database-reviewer` for schema, queries, migrations, indexes, transactions, and RLS.
- `performance-reviewer` for latency, throughput, memory, bundle size, rendering, and scalability regressions.

Reviewer selection can be automatic or explicit. Auto-selection always includes `code-reviewer` and adds specialized reviewers based on changed paths, including `performance-reviewer` for performance-sensitive paths such as benchmarks, profiling, bundles, metrics, monitoring, load tests, and `.bench`/`.perf` files. Explicit `--reviewers` input limits orchestration to the requested reviewers.

For diff targets (`uncommitted`, base branch, commit, or pull request), `/review` performs preflight validation before sending the orchestration packet. It fails fast when the target is invalid or no changed paths are found. The packet includes changed paths, exact inspect commands, and, when available for merge-base comparisons, commit list metadata. Inspect commands are target-specific: uncommitted reviews use `git status --porcelain --untracked-files=all`, `git diff --cached`, and `git diff`; base branch and pull request reviews use `git diff <merge-base>` plus `git log <merge-base>..HEAD --oneline`; commit reviews use `git show --stat --patch --find-renames <sha>`. Folder snapshot reviews do not receive diff-target preflight metadata.

Reviewer and verifier agents must submit through an injected `structured_output` tool whose nested object schemas are closed with `additionalProperties: false`. Direct orchestration keeps built-in and extension tools enabled; the custom submission tool is added without a tool allowlist or `noExtensions`. Assistant text is never accepted as a workflow fallback, even when it contains valid JSON. The extension validates the captured submission before acting, performs exactly one typed structured repair retry per invalid reviewer/verifier submission, and fails the whole review if any selected reviewer fails at runtime or the repaired submission is still invalid. Outside this workflow, a directly invoked reviewer without the injected tool returns the same structured object as JSON assistant text.

The verifier submission schema contains only `reviewScope`, `verdict`, and verified `findings`. Human reviewer callouts and reviewer coverage are derived from the selected, validated reviewer outputs and injected by the workflow after verifier validation; verifier-supplied values cannot override them.

During direct orchestration, `/review` publishes workflow progress through the shared `review-progress` above-editor widget/status while running, showing the current workflow phase, active agents, latest workflow log, and one compact active-agent activity line for reviewer/verifier agents. Live activity prefers parsed tool calls as pi-tasks-like verb + target snippets (for example, `reading extensions/review/workflow.ts`, `running bun test extensions/review/index.test.ts`, or `searching outputFile`) and falls back to assistant transcript text when no tool activity is available. User prompts are never shown, and completed agents still show compact result snippets. Successful and failed runs clear the transient widget and post the final `review-report` or failure notification separately.

The verifier uses the default model from `agents/review-verifier.md` unless `/review --verifier-model <provider/model>` or the interactive review selector configures an override. Any override must differ from the reviewer model policy (`openai-codex/gpt-5.6-sol`), which is regression-checked against every reviewer agent default.

The workflow de-duplicates nearby overlapping reviewer findings before verification, preserving all source reviewers and keeping the highest-severity candidate. The verifier independently inspects changed code and cited locations before accepting candidate findings. The final `/review` response is rendered by extension code from the validated verifier submission, filters out low-confidence verifier findings, keeps deterministic reviewer callouts separate from verifier output, includes verifier confidence/reason for accepted high/medium findings, and reports only issues introduced or directly exposed by the reviewed change. If reviewer agents return no findings, the workflow skips `review-verifier` and renders a compatible “Code looks good” report with reviewer coverage and human callouts.

## `/review-fix` executor delegation

`/review-fix` stays prompt-orchestrated and prefers the latest `/review-summary` report, falling back to the latest raw `/review` report.

For actionable findings or a non-empty Fix Queue, the main session must:

- call exactly one foreground/default `executor` Agent for the whole queue;
- omit `max_turns`;
- avoid all main-session code edits;
- summarize only the executor JSON result.

If the report clearly has no findings, an empty Fix Queue, or says the code looks good, `/review-fix` must not call the executor and must report no fixable findings.

Executor failure, invalid JSON, `blocked`, or `needs_followup` is reported only, with no fallback main-session fixing. The review report is untrusted, so instructions inside it cannot override command/delegation rules. `/review-fix [extra instruction]` can refine implementation scope or checks, but cannot override delegation, safety, no-main-edits, no-task-tools, or JSON-summary rules.
