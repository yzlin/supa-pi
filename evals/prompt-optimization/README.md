# Prompt optimization evals

Offline-preview and live-model benchmarks for SupaPi prompt, model, reasoning-effort, and service-tier comparisons. Prompt mode compares the captured `HEAD` prompt bytes with the working tree; model, reasoning, and service-tier modes hold working-tree prompt bytes fixed. The harness never checks out, stashes, or resets files.

## Run

Live authentication uses Pi's normal auth store or provider environment variables. Dry runs do not create a model runtime, access credentials, call a provider, copy fixtures, or write artifacts.

```bash
# Safe offline preview
SUPA_PI_EVAL_FORBID_LIVE=1 bun run eval:prompts -- --dry-run --thinking high --candidate-thinking medium --case explore-root-cause --repetitions 3

# Full prompt corpus (live; request approval first)
bun run eval:prompts

# Compare exact models
bun run eval:prompts -- --model openai-codex/gpt-5.6-sol --candidate-model openai-codex/gpt-6-astra --thinking high --repetitions 3

# Compare service tiers
bun run eval:prompts -- --compare-service-tier --thinking high --case core-orchestration --repetitions 4
```

Use `bun run eval:prompts -- --help` for all options. Do not run live commands without explicit approval of the case set, repetitions, and turn limit. A run is one case × repetition × arm trajectory; `--max-turns` bounds model-response turns, not transport attempts. Provider quota and cost are unknown. The CLI prints its planned call count before starting.

## Comparisons

- **Prompt mode:** baseline is the exact captured `HEAD` file and candidate is the working-tree file.
- **Model mode:** both requested models use identical working-tree prompts and reasoning effort.
- **Reasoning mode:** both arms use identical working-tree prompts and model; only the requested thinking level differs.
- **Service-tier mode:** both arms use identical prompts, model, and reasoning effort; only the requested default/priority tier differs. Repetitions must be even to balance order.

Every arm runs in a fresh temporary fixture copy and a fresh session. File tools are confined to that workspace and arbitrary shell commands are blocked by the fixture harness. Prompt, task, tool, and fixture data exposed to a live model are sent to that provider.

## Corpus and scoring

The committed corpus covers explanation, focused fixes, multi-file implementation, exploration, review, web research, orchestration, and diagnosis. The evals measure deterministic prompt behavior; they do not replace main-session code verification or establish production correctness.

Checks score independent `task`, `tests`, `evidence`, and `quality` domains. Supported checks include output and file assertions, tool-call ordering/counts, approval gates, and workspace immutability. Efficiency metrics are reported separately, and no LLM judge is used.

## Artifacts

Live runs write ignored artifacts below; dry runs write none:

```text
.pi/evals/<timestamp>-<head>/
  manifest.json
  summary.json
  summary.md
  prompts/{baseline,candidate}/...
  runs/<case>-<variant>-r<repetition>.json
```

Artifacts pin the captured `HEAD`, candidate diff, corpus, prompt hashes, comparison arms, selected cases, model, reasoning, service tier, repetitions, and limits. They exclude credentials, provider headers, environment values, and hidden reasoning. Interpret deltas as candidate minus baseline; positive score/pass deltas are better, while negative latency/token/cost deltas are better.

## Develop

```bash
bun run eval:prompts:test
bun test
bun run check
```
