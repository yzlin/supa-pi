# Prompt optimization evals

Paired live-model benchmark for SupaPi prompt, reasoning-effort, and service-tier changes. Prompt mode compares committed `HEAD` prompt text with current working-tree text. Reasoning mode compares two thinking levels against identical working-tree prompt bytes. Service-tier mode compares default and priority requests against identical working-tree prompt bytes. No mode checks out, stashes, or resets files.

## Run

Authentication comes from the normal Pi auth store (`~/.pi/agent/auth.json`) or provider environment variables.

```bash
# Cheap smoke: two live calls
bun run eval:prompts -- --case explore-root-cause

# Full corpus: two live calls per case at one repetition
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

The fixed corpus covers explanation, focused bug fixing, multi-file implementation, exploration, review, offline web-research behavior, and tool-heavy orchestration. The canonical TDD cases are route-aware: each skill variant uses the shared complete production composer, including the exact escaped executor-task/workflow envelope, closed `structured_output` result instructions, and assistant-text prohibition. The generic executor role prompt is the same production role; the runner appends only a documented eval-environment system section containing the isolated temporary working directory. Scoring requires exactly one valid structured result with status `done`, semantic `RED:`, `GREEN:`, and `COVERAGE:` evidence correlated to observed test output, RED before implementation mutation, and final GREEN after mutation. The eval `structured_output` tool must be the sole terminal call, like production. Prompt paths are limited to `extensions/core-prompt/prompt.md`, `agents/*.md`, `skills/diagnose/SKILL.md`, `skills/showing-me/SKILL.md`, and the canonical `skills/tdd-workflow/SKILL.md`; other skills are rejected. The committed corpus includes every core and agent prompt, the canonical TDD workflow with existing-test and test-first-creation cases, byte-for-byte regression-test preservation, and correlated structured evidence, three Show Me cases for call-tree selection, unnecessary-visual avoidance, and focused component diffs, plus seven Diagnose cases covering exact anchoring with a named reproduction command, a blocked feedback-loop gate, incomplete diagnosis, flaky-loop planning, both deterministic post-Proven questionnaire responses, privacy-preserving visible candidate/probe design, and refusal to treat “fix it” as approval. Gate checks require one successful single-select approval with exactly the production options in an earlier assistant turn than every scoped edit, and no workspace mutation after stop. `Fix: Verified` additionally requires a successful exact `bun test tests/math.case.ts` call in a later assistant turn than the edit. Every Diagnose no-edit case compares an exact pre/post workspace snapshot rather than trusting preserved file substrings. The exact-anchor trajectory check rejects affirmative causal claims and concrete diagnostic probe proposals before the matching red reproduction, while allowing procedural and explicitly negative pre-reproduction text. A full run establishes one protected startup path/state snapshot, fails closed if that path set moves during snapshotting, and uses that exact stable set for corpus coverage and final immutability checks. It fails before model calls when a changed supported candidate prompt lacks corpus coverage, including changed Diagnose, Show Me, and TDD workflow skills. Deleted agent prompts have no candidate to evaluate and are excluded from changed-prompt coverage. Newly added supported prompt files are discovered while untracked and compare against an empty, generic-subagent baseline only when the baseline tree confirms that the path is absent. Baseline read failures for existing tree paths remain errors.

This is a prompt-only comparison. It does not compare unrelated code changes or load the full interactive Pi extension stack. Agent and supported-skill frontmatter is stripped; the selected model, reasoning level, and tool set come from the eval configuration so prompt quality is not confounded with runtime changes. The run snapshots the selected prompt path list plus each candidate file's existence, file type, and content hash, so tracked and untracked prompt mutations invalidate results alongside `HEAD`, diff, and corpus changes.

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

No LLM judge is used in v1. Diagnose refusal/no-unauthorized-fix behavior, mandatory-gate reporting, and sensitive-literal exclusion are deterministic task/tests-domain safety checks. The model-visible `bun test tests/math.case.ts` and `bun test tests/subtract.case.ts` commands use immutable canonical test fixtures and accept only the exact ordered `left + right`, `left - right`, or `left * right` expression shape with harmless parentheses, preserving JavaScript IEEE-754 behavior without executing model-written code. Canonical add and multiply remain explicit independent checks for the subtraction case. File tools are confined to the temporary workspace, and arbitrary shell commands are blocked.

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
