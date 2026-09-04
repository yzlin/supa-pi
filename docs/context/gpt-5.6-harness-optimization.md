---
summary: "Evidence-backed GPT-5.6 optimization opportunities for SupaPi model routing, prompts, caching, tools, and evals."
read_when:
  - "Changing default models, thinking levels, agent model routing, prompt size, prompt caching, tool exposure, structured model output, or model evals."
---

# GPT-5.6 harness optimization

Snapshot date: 2026-07-13.

This note compares current SupaPi behavior with OpenAI's GPT-5.6 guidance. OpenAI's published performance ranges are directional; validate every change against representative SupaPi tasks.

## Summary

The largest likely gains are:

1. Measure model quality, latency, tokens, and caching.
2. Test lower reasoning levels instead of defaulting to `high` or `xhigh`.
3. Remove repeated prompt instructions.
4. Keep tool and prompt prefixes focused and stable.
5. Use native structured output for machine-consumed agent results.

Do these before adding new orchestration features.

## Current strengths

- Agent routing already uses the GPT-5.6 family by workload:
  - `gpt-5.6-sol` for capability-first workers.
  - `gpt-5.6-terra` for cheaper document and E2E workers.
  - `gpt-5.6-luna` for exploration.
- The installed `openai-codex` provider already uses Responses-style requests with:
  - `text.verbosity: "low"`
  - `parallel_tool_calls: true`
  - a session-derived `prompt_cache_key`
  - `reasoning.encrypted_content`
- Subagents restrict their tools through agent frontmatter.
- `/review` combines parallel workers, a native `structured_output` tool, validation, and one typed repair attempt.
- RTK compacts large tool results, while `/context` reports token categories and offenders.

## Priority opportunities

### 1. Add a model eval and usage harness

The repository has unit tests but no live model-quality benchmark. Before tuning prompts or models, create a small fixed corpus covering:

- explanation
- focused bug fix
- multi-file implementation
- codebase exploration
- code review
- web research
- tool-heavy orchestration

Record at least:

- task success and test success
- answer completeness and evidence coverage
- input, output, reasoning, cache-read, and cache-write tokens
- end-to-end latency
- tool calls, turns, retries, and recovery behavior
- model, reasoning effort, and workflow route

Use the same tasks to compare one change at a time.

The repository now provides `bun run eval:prompts`. Its default prompt mode compares exact `HEAD` prompt bytes with working-tree prompt bytes. Reasoning mode uses `--thinking <baseline>` with `--candidate-thinking <candidate>` to compare identical working-tree prompt bytes at two effort levels. Service-tier mode uses `--compare-service-tier` to compare default versus priority with identical working-tree prompt bytes, model, effort, fixture, and tools. All modes run variants against fresh copies of a fixed fixture, apply deterministic task/test/evidence/quality checks, and record absolute per-arm usage plus candidate-minus-baseline deltas under `.pi/evals/`. Accepted prompt paths are limited to every `agents/*.md` prompt, `extensions/core-prompt/prompt.md`, `skills/diagnose/SKILL.md`, `skills/showing-me/SKILL.md`, and the canonical `skills/tdd-workflow/SKILL.md`; other skills are rejected. The committed corpus covers all seven workload classes, every core and agent prompt, the canonical TDD workflow, three Show Me cases for selecting a call tree or focused diff and avoiding unnecessary visuals, and seven Diagnose cases for exact anchoring with a named reproduction command, a blocked feedback-loop gate, incomplete diagnosis, flaky-loop planning, both supplied post-Proven ask responses, privacy-preserving visible candidate/probe design, and “fix it” non-approval. The low-level runner provides a deterministic `ask` tool for those gate cases and checks its exact single-select shape, tool ordering, scoped approval edit, stop behavior, and exact no-edit workspace snapshots. Its exact-anchor trajectory check rejects affirmative causal claims and concrete diagnostic probe proposals before the matching red reproduction without treating procedural or explicitly negative text as reasoning. New supported prompt files are discovered while untracked and compare against an empty, generic-subagent baseline only when the baseline tree confirms that the path is absent; deleted agent prompts have no candidate and are excluded, while existing candidate-path read failures remain errors. Runs snapshot selected prompt paths plus candidate existence, file type, and content hashes so tracked and untracked prompt mutations invalidate results. Repeat `--case` to evaluate a route-specific subset. See `evals/prompt-optimization/README.md` for commands, scoring semantics, cost warnings, and limitations.

The v1 runner intentionally uses the low-level Pi `agentLoop` rather than the full interactive extension stack. This isolates prompt text from live settings, context files, skills, retries, and unrelated extension behavior. The canonical TDD route is the narrow parity exception: it composes the generic executor role, production escaped task envelope, evaluated bundled workflow, and closed native `structured_output` result contract before retaining fail-before/pass-after and evidence scoring. Each arm still receives a fresh Pi UUIDv7 session ID because the Codex backend uses the TUI-style session identity for `prompt_cache_key` and WebSocket model routing; the runner closes that arm's WebSocket session after completion. The core route appends each variant to the same pinned production-like Pi base prompt. Workspace tools reject path escapes and arbitrary shell commands are blocked. The model-visible allowlisted Bun command is simulated by an immutable closed-grammar harness; workspace code is never executed. Scoring separately requires the canonical regression test file to remain byte-for-byte unchanged, preventing comments, dead code, deleted tests, or weakened tests from proving the fix. Use a later sandboxed full-session parity suite when evaluating extension behavior or executable third-party tasks.

### 2. Test lower reasoning effort

OpenAI recommends preserving the previous reasoning setting as a baseline, then testing the same setting and one level lower. It describes `medium` as a balanced starting point and reserves `xhigh` and `max` for workloads where evals prove a quality gain.

Current repository and live configuration now use route-specific effort:

- `setup.sh` creates first-run settings with `defaultThinkingLevel: "high"`.
- The live `~/.pi/agent/settings.json` uses `defaultThinkingLevel: "high"` after the main-session benchmark below.
- `agents/build-error-resolver.md`, `agents/executor.md`, and `agents/refactor-cleaner.md` select `thinking: medium` after route-specific benchmarks.
- TDD behavior changes and bug fixes route through the generic `executor` using `execute_tasks` with `tdd: true`; the runtime injects only the canonical `skills/tdd-workflow/SKILL.md` content from its fixed bundled path.
- `agents/doc-updater.md`, `agents/e2e-runner.md`, and `agents/explorer.md` select `thinking: low`; higher-risk Sol agents remain at `high`.

Candidate evaluation matrix:

| Workload | Candidate baseline |
| --- | --- |
| Normal main session | Sol `high`, then compare `medium` |
| Exploration | Luna `low` |
| Documentation and repetitive work | Terra `low` or `medium` |
| Execution and build fixes | Sol or Terra `medium` |
| Planning and architecture | Sol `high` |
| Security, database, and code review | Sol `high` |
| Explicit quality-first run | Sol `xhigh`, `max`, or Pro mode only after measured gain |

### Initial reasoning benchmark

A route-aware three-repetition benchmark ran on 2026-07-11 with identical working-tree prompt hashes in both arms:

- **Sol, `high` versus `medium`** — `core-orchestration`, `executor-fix`, and `build-fix` remained at 100% pass rate and 1.000 deterministic score. Medium used 872 fewer input tokens (12%), 94 fewer output tokens (19%), 55 fewer reasoning tokens (49%), 2.5 seconds less latency (11%), and $0.0072 less per-run average cost (14%). Local artifact: `.pi/evals/2026-07-11T12-48-11-221Z-29cca1e8/`.
- **Terra, `low` versus `medium`** — `docs-update` and `e2e-verification` remained at 100% pass rate and 1.000 deterministic score. Medium used 965 more input tokens (24%), 31 more reasoning tokens (23%), and $0.0032 more per-run average cost (18%) while saving 1.0 second latency (4%). `doc-updater` and `e2e-runner` therefore use low. Local artifact: `.pi/evals/2026-07-11T12-52-53-824Z-29cca1e8/`.
- **Luna, `low` versus `medium`** — `explore-root-cause` remained at 100% pass rate and 1.000 deterministic score. Medium used 279 fewer input tokens (8%), 13 fewer output tokens (4%), 18 more reasoning tokens (113%), 2.3 seconds less latency (23%), and $0.0004 less per-run average cost (8%). The first run was invalid because the low-level runner omitted the TUI's UUIDv7 session identity; Luna rejected requests without that routing contract. Local valid artifact: `.pi/evals/2026-07-11T14-56-53-424Z-29cca1e8/`.

A second route-aware three-repetition benchmark ran on 2026-07-11:

- **Sol, `xhigh` versus `high`** — `core-orchestration` remained at 100% pass rate and 1.000 deterministic score. High used 913 fewer input tokens (15%), 115 fewer output tokens (13%), 94 fewer reasoning tokens (28%), 2.2 seconds less latency (9%), and $0.0078 less per-run average cost (14%). The live main-session default moved from `xhigh` to `high`; the repository setup default was already `high`. Local artifact: `.pi/evals/2026-07-11T15-05-17-108Z-a1d57cf9/`.
- **Historical/retired route: Sol, `high` versus `medium`** — `remove-dead-code` and `tdd-fix` remained at 100% pass rate and 1.000 deterministic score. Medium saved 1.6 and 2.7 seconds respectively; TDD also used 62 fewer reasoning tokens and cost $0.0018 less per run. `simplify-code` was inconclusive because both arms frequently missed one deterministic completion invariant, so `code-simplifier` stayed at high. This benchmark moved `refactor-cleaner` and the now-retired `tdd-guide` agent to medium; it is historical evidence, not current routing guidance. Current TDD work uses the generic `executor` with `tdd: true` and canonical skill injection. Local artifact: `.pi/evals/2026-07-11T15-11-21-183Z-a1d57cf9/`.

Together with the initial `executor-fix` and `build-fix` results, these fixtures historically justified medium for four deterministic worker routes. Three remain standalone agents; current TDD work shares the medium-thinking generic `executor` route. They still do not justify a global `medium` default or lower effort for planning, architecture, research, security, database, or review routes.

Continue comparing one route cohort at a time; do not change all workers at once.

### 3. Reduce repeated prompt instructions

Before the first prompt-diet pass, `extensions/core-prompt/prompt.md` was 6,621 bytes, 1,022 words, and 181 lines. It repeated concepts also present in `AGENTS.md`, rule packs, tool instructions, and agent prompts: inspect first, make the smallest change, ask on ambiguity, validate, and delegate specialized work.

The first pass reduced it to 2,435 bytes, 328 words, and 38 lines while retaining compact identity, autonomy, routing, verification, and output-priority contracts. That is a 63% byte, 68% word, and 79% line reduction.

A second pass reduced the 16 files under `agents/` from 74,517 to 39,488 bytes, 10,574 to 5,231 words, and 2,179 to 584 lines. That is a 47% byte, 51% word, and 73% line reduction. Role boundaries, frontmatter, read-only constraints, and machine-consumed output contracts were retained. Repository contract tests validate the review-agent structured-output fallback, but live model quality, latency, token, and cache effects remain unmeasured.

OpenAI reports that leaner prompts improved internal coding-agent eval scores by roughly 10–15% while reducing total tokens by 41–66% and cost by 33–67%. These ranges are directional, not SupaPi measurements.

A prompt diet should state the desired result and acceptance criteria, include only context, output needs, and critical boundaries that materially change the result, and leave the implementation approach open unless the process itself matters. It should retain:

- one compact autonomy and approval policy
- one routing policy
- one verification and done contract
- product-specific behavior that corrects a measured gap

Remove duplicate workflow narration and generic reminders. After a later agent addition, `agents/` contains 17 Markdown files and 609 total lines as of 2026-07-13. Continue evaluating agent prompt changes one section at a time.

A three-repetition paired `core-orchestration` benchmark on 2026-07-13 compared the previous intent sentence with a shorter result-first contract covering acceptance criteria, relevant context, output needs, critical boundaries, and process flexibility. Both arms retained a 100% pass rate and 1.000 deterministic score. The candidate used 316 fewer input tokens, 116 fewer output tokens, 54 fewer reasoning tokens, and $0.0056 less per run on average; latency increased by 44 milliseconds. Keep the candidate. Local artifact: `.pi/evals/2026-07-13T11-37-00-048Z-ce333a32/`.

### 4. Measure prompt-cache economics

GPT-5.6 cache writes cost 1.25 times uncached input; reads remain discounted. The installed Codex provider already sends a session-derived cache key, but SupaPi does not aggregate cache effectiveness by workflow.

Likely shapes to measure:

- Long main sessions may benefit from repeated prefixes.
- One-shot workers may pay for writes they never read.
- Dynamic Obsidian context can reduce the reusable portion of a prefix when selected context changes.
- `/btw`, `session-query`, and handoff serialize large conversation histories into auxiliary calls.
- Changing tools between requests also changes the cacheable prefix.

Track at least `cacheRead`, `cacheWrite`, input tokens, and latency by agent and command. `/btw` already captures these counters, providing a local pattern to reuse.

Do not blindly set `PI_CACHE_RETENTION=long`: the active provider is `openai-codex`, while the inspected long-retention implementation belongs to the direct `openai-responses` path. GPT-5.6 explicit cache breakpoints are also not exposed by the pinned Codex request builder.

### 5. Narrow tool exposure where safe

OpenAI recommends exposing only task-relevant tools and keeping descriptions concise. SupaPi registers many extensions in `package.json`, and installed global packages further broaden the main-session tool set.

Subagents already use frontmatter allowlists. Candidate next steps:

- define command- or workflow-specific main-session tool profiles
- keep orchestration and common file tools active for normal work
- activate specialized tools only when needed
- split oversized skills into focused skills instead of eagerly loading large instruction files
- keep tool definitions stable across calls that should share a prompt cache

Pi exposes `getActiveTools()` and `setActiveTools()`. Automatic intent-based pruning remains risky: omitting one required tool can cost more than the saved tokens. Evaluate explicit workflow profiles first.

### 6. Extend native structured output

`extensions/review/workflow.ts` provides the strongest local pattern: a closed TypeBox schema, a dedicated `structured_output` tool, validation, and one repair attempt.

`/execute` now dispatches executor work through `extensions/execute/executor-workflow.ts`. Its `execute_tasks` tool uses the pi-subagents workflow runtime to inject a closed native schema, rejects assistant-text JSON, limits each round to four tasks, preserves settled sibling outcomes, and makes exactly one report-only repair with the tool-less `executor-output-repair` agent after a missing structured submission. `needs_verification` covers both repaired reports (`repaired: true`) and trustworthy TDD strategy deviations (`repaired: false` with a bounded warning); both require independent orchestrator checks before task completion. Malformed, unsafe, fabricated, uncorrelated, or currently failing evidence remains a hard failure. Hard per-agent deadlines and bounded cleanup limit retained work. The main session continues to own pi-task and checkpoint state. `/goal` still asks workers for strict JSON text, so it remains the next machine-consumed contract to evaluate.

### 7. Align model and transport documentation

Current durable and generated defaults mostly agree:

- `setup.sh` and live settings use GPT-5.6 Sol, `high`, and `transport: "auto"`.
- Agent definitions use GPT-5.6 with route-specific thinking levels.
- `rules/common/performance.md` documents the measured GPT-5.6 routing strategy.
- `extensions/fast` recognizes the current Codex Fast-capable models exposed by Pi, including the GPT-5.6 Luna, Sol, and Terra variants; the persisted enabled state controls whether supported requests use the priority tier.

Pi documents `auto` as its transport default. Preserve `auto` unless an SSE or WebSocket benchmark demonstrates a better choice.

The installed Codex adapter serializes `service_tier: "priority"` for GPT-5.6 Sol. On 2026-07-11, an authenticated ChatGPT-backend probe completed successfully with that field enabled through the config allowlist, proving request-contract acceptance.

A paired, order-balanced four-repetition benchmark on 2026-07-12 held model, prompt bytes, reasoning, fixtures, and tools constant. All retained arms passed at score 1.000, and every candidate payload recorded `service_tier: "priority"`. Priority was 36.5% faster for core orchestration at high effort but 15.6% slower for executor fixing at medium effort, while costing 81% and 100% more. A clean low-effort exploration rerun was 19.6% faster at 98% higher cost, but production exploration routes use Luna rather than Sol. An earlier balanced exploration cohort was excluded after one priority WebSocket closed normally before its answer completed. Result: the latency benefit is route-dependent, regresses the executor route, and nearly doubles cost. This evidence governs whether Fast Mode should be enabled, not whether a backend-supported model is recognized. Keep Fast Mode user-controlled and benchmark it for each workload.

Retained artifacts: `.pi/evals/2026-07-12T13-42-50-849Z-aec2ddaf/`, `.pi/evals/2026-07-12T13-45-15-679Z-aec2ddaf/`, and `.pi/evals/2026-07-12T13-48-37-962Z-aec2ddaf/`. Excluded transport-failure cohort: `.pi/evals/2026-07-12T13-47-04-519Z-aec2ddaf/`.

### 8. Tune verbosity by workflow

The installed Codex provider defaults to `text.verbosity: "low"`, while SupaPi also applies concise and Caveman-style prompt instructions. OpenAI warns that GPT-5.6 is already concise and broad brevity instructions can remove required content.

Prefer an output-priority contract:

> Lead with the conclusion. Preserve required evidence, caveats, decisions, and the next action. Remove repetition and optional background first.

Keep low verbosity for routine execution. Evaluate medium verbosity for research, architecture, and review reports.

## Later or upstream-dependent features

The latest guide also introduces persisted reasoning, Pro mode, `max` effort, explicit cache breakpoints, Programmatic Tool Calling, and OpenAI Multi-agent beta.

These are not immediate repository-only wins:

- The pinned Codex request builder does not expose persisted-reasoning context, Pro mode, or explicit cache options.
- Programmatic Tool Calling requires parsing and continuing `program`, nested function-call, `caller`, and `program_output` items; adding only a request field is insufficient.
- Programmatic Tool Calling fits bounded filtering, joining, ranking, deduplication, aggregation, and validation. It does not fit adaptive repository exploration where every result may change the next decision.
- SupaPi's local `workflow` and subagent layers already cover much of the multi-agent use case with explicit tool and approval control.

Treat these as upstream `pi-ai` integration work after eval, effort, prompt, and structured-output improvements.

The active provider is `openai-codex` through the ChatGPT backend. Do not assume every API-key Responses feature has identical support without a request-contract test.

## Recommended order

Items 1-3 are implemented for the measured routes. Sections 4-5 remain the next repository-level experiments. Continue with:

1. Evaluate explicit tool profiles.
2. Measure prompt-cache economics by workflow.
3. Evaluate native structured output for `/goal`.
4. Consider upstream persisted reasoning, cache controls, Pro mode, or Programmatic Tool Calling.

## Sources

Official OpenAI documentation, accessed 2026-07-11 through 2026-07-13:

- [Prompting](https://learn.chatgpt.com/docs/prompting)
- [Using GPT-5.6](https://developers.openai.com/api/docs/guides/latest-model)
- [Reasoning models](https://developers.openai.com/api/docs/guides/reasoning)
- [Prompt caching](https://developers.openai.com/api/docs/guides/prompt-caching)
- [Priority processing](https://openai.com/api-priority-processing/)
- [Programmatic Tool Calling](https://developers.openai.com/api/docs/guides/tools-programmatic-tool-calling)

Relevant repository evidence:

- `setup.sh`
- `package.json`
- `extensions/core-prompt/prompt.md`
- `extensions/fast/`
- `extensions/review/workflow.ts`
- `extensions/btw/subagent.ts`
- `extensions/session-query.ts`
- `extensions/handoff.ts`
- `extensions/rtk/`
- `extensions/context/`
- `agents/`
- `rules/common/performance.md`
