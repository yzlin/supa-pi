# Prompt optimization evals

Paired live-model benchmark for SupaPi prompt, reasoning-effort, and service-tier changes. Prompt mode compares committed `HEAD` prompt text with current working-tree text. Reasoning mode compares two thinking levels against identical working-tree prompt bytes. Service-tier mode compares default and priority requests against identical working-tree prompt bytes. No mode checks out, stashes, or resets files.

## Run

Authentication comes from the normal Pi auth store (`~/.pi/agent/auth.json`) or provider environment variables.

```bash
# Cheap smoke: two live calls
bun run eval:prompts -- --case explore-root-cause

# Full corpus: 54 live calls at one repetition
bun run eval:prompts

# Better variance estimate
bun run eval:prompts -- --repetitions 3

# Compare reasoning effort while holding model and prompt bytes fixed
bun run eval:prompts -- --thinking high --candidate-thinking medium --repetitions 3

# Compare default versus priority service tier
bun run eval:prompts -- --compare-service-tier --thinking high --case core-orchestration --repetitions 4

# Compare a route-specific subset; --case is repeatable
bun run eval:prompts -- --model openai-codex/gpt-5.6-terra --thinking low --candidate-thinking medium --case docs-update --case e2e-verification --repetitions 3

# Select another model
bun run eval:prompts -- --model openai-codex/gpt-5.6-sol
```

See all options:

```bash
bun run eval:prompts -- --help
```

Live runs consume provider quota and can take several minutes. Prompts, fixture excerpts, tool calls, and final answers are sent to the selected external model provider. The CLI prints the planned call count before starting.

## What is compared

Prompt mode (default):

- **Baseline:** exact bytes from `git show <captured-HEAD>:<prompt-path>`.
- **Candidate:** exact bytes from the same path in the working tree.
- **Held constant:** fixture, task, tools, model, reasoning effort, timeout, max turns, and deterministic checks.

Reasoning mode (`--candidate-thinking <level>`):

- **Baseline:** working-tree prompt bytes with `--thinking <level>`.
- **Candidate:** identical working-tree prompt bytes with `--candidate-thinking <level>`.
- **Held constant:** prompt, fixture, task, tools, model, timeout, max turns, and deterministic checks.

Service-tier mode (`--compare-service-tier`) currently requires an `openai-codex` Responses model:

- **Baseline:** identical working-tree prompt bytes with no priority request (`default`).
- **Candidate:** identical working-tree prompt bytes with `serviceTier: "priority"`.
- **Held constant:** prompt, fixture, task, tools, model, reasoning effort, timeout, max turns, and deterministic checks.
- **Recorded evidence:** requested arm and the outgoing provider payload's `service_tier` value (`absent` for baseline, `priority` for candidate). The run fails if any payload differs. The private ChatGPT backend's raw response tier is not exposed; Codex normalizes requested priority for pricing.
- **Ordering:** repetitions must be even so each arm runs first equally often within every case.

All modes isolate every variant/repetition in a fresh temporary fixture copy and a fresh Pi UUIDv7 session. The session ID supplies the Codex `prompt_cache_key` and WebSocket request identity used by the TUI; each Codex WebSocket session is closed after its arm completes. The core route shares one pinned production-like Pi base prompt before appending the evaluated core prompt.

The fixed corpus covers explanation, focused bug fixing, multi-file implementation, exploration, review, offline web-research behavior, and tool-heavy orchestration. Prompt paths are limited to `extensions/core-prompt/prompt.md`, `agents/*.md`, and exactly `skills/diagnose/SKILL.md`; other skills are rejected. The committed corpus includes every core and agent prompt plus seven Diagnose cases covering exact anchoring with a named reproduction command, a blocked feedback-loop gate, incomplete diagnosis, flaky-loop planning, both deterministic post-Proven questionnaire responses, privacy-preserving visible candidate/probe design, and refusal to treat “fix it” as approval. Gate checks require one successful single-select approval with exactly the production options in an earlier assistant turn than every scoped edit, and no workspace mutation after stop. `Fix: Verified` additionally requires a successful exact `bun test tests/math.case.ts` call in a later assistant turn than the edit. Every Diagnose no-edit case compares an exact pre/post workspace snapshot rather than trusting preserved file substrings. The exact-anchor trajectory check rejects affirmative causal claims and concrete diagnostic probe proposals before the matching red reproduction, while allowing procedural and explicitly negative pre-reproduction text. A full run fails before model calls when a changed supported prompt lacks corpus coverage, including a changed diagnose skill.

This is a prompt-only comparison. It does not compare unrelated code changes or load the full interactive Pi extension stack. Agent and diagnose-skill frontmatter is stripped; the selected model, reasoning level, and tool set come from the eval configuration so prompt quality is not confounded with runtime changes. The run aborts if `HEAD`, tracked candidate changes, or the corpus changes while calls are in progress.

## Scoring and telemetry

Deterministic checks score four independent domains:

- `task` — required artifact or tool behavior
- `tests` — immutable fixture invariants
- `evidence` — required paths/facts in the answer
- `quality` — task-specific deterministic output criteria

Efficiency is reported separately, not folded into quality. Summaries include each arm's absolute averages and candidate-minus-baseline deltas:

- input, output, reasoning, cache-read, and cache-write tokens
- provider cost
- wall latency
- turns and tool calls
- tool errors and recoveries
- retries (reserved as zero for the direct-loop v1 runner)
- requested model, response model, reasoning effort, service-tier arm/payload, route, and stop reason

No LLM judge is used in v1. Diagnose refusal/no-unauthorized-fix behavior, mandatory-gate reporting, and sensitive-literal exclusion are deterministic task/tests-domain safety checks. The model-visible `bun test tests/math.case.ts` command is a deterministic simulator backed by immutable harness logic; it never executes model-written code. File tools are confined to the temporary workspace, and arbitrary shell commands are blocked.

## Artifacts

Ignored artifacts are written to:

```text
.pi/evals/<timestamp>-<head>/
  manifest.json
  summary.json
  summary.md
  prompts/{baseline,candidate}/...
  runs/<case>-<variant>-r<repetition>.json
```

`manifest.json` pins the `HEAD` commit, candidate diff hash, corpus hash, prompt hashes, comparison kind and arms, selected cases, model, reasoning effort, service-tier mode, repetitions, and limits. Artifacts exclude credentials, provider headers, environment values, and hidden reasoning text.

Interpret deltas as **candidate minus baseline**:

- positive pass-rate/score delta is better
- negative latency/token/cost delta is better
- fewer tool calls are diagnostic, not automatically better

Use at least three repetitions before accepting or rejecting a prompt optimization. The runner alternates variant order, but model and cache variance remain.

## Develop

```bash
bun run eval:prompts:test
bun test
bun run check
```
