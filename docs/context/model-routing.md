---
summary: "Repository model-routing snapshot and source-of-truth pointers; not live settings or model-quality evidence."
read_when:
  - "Checking current first-run, agent, review, eval, or Fast Mode model routes."
---

# Model routing in this repository

These are repository defaults, not the effective settings of a running Pi session. `setup.sh` creates settings only when absent; existing live settings, per-invocation choices, and saved review configuration may differ. Follow the linked source when a route changes.

| Route | Repository default | Source |
| --- | --- | --- |
| First-run main session | `openai-codex/gpt-6.1-sol`, `high` | [`setup.sh`](../../setup.sh) |
| Direct executor agent | `openai-codex/gpt-6.1-sol`, `high` | [`agents/executor.md`](../../agents/executor.md) |
| Direct explorer agent | `openai-codex/gpt-6.1-sol`, `low` | [`agents/explorer.md`](../../agents/explorer.md) |
| Direct review-synthesizer agent | `openai-codex/gpt-6-luna`, `low` | [`agents/review-synthesizer.md`](../../agents/review-synthesizer.md) |
| `/review` built-in reviewer panel / verifier | `openai-codex/gpt-6-astra`, `medium` | [`workflow.ts`](../../extensions/review/workflow.ts), [`pipeline-contracts.ts`](../../extensions/review/pipeline-contracts.ts), [`pipeline.ts`](../../extensions/review/pipeline.ts) |
| `/review` built-in synthesizer | `openai-codex/gpt-6-luna`, `medium` | [`workflow.ts`](../../extensions/review/workflow.ts), [`pipeline-contracts.ts`](../../extensions/review/pipeline-contracts.ts), [`pipeline.ts`](../../extensions/review/pipeline.ts) |
| Prompt-eval CLI | `openai-codex/gpt-6-sol`, `high` | [`cli.ts`](../../evals/prompt-optimization/cli.ts) |

Other direct agent defaults live in their [`agents/` frontmatter](../../agents/). `/review` layers invocation flags, project config, global config, then built-in defaults **per field**; see [review configuration](../../extensions/review/README.md#configuration-and-disclosure).

[Fast Mode](../../extensions/fast/README.md) recognizes GPT-6 Sol, Luna, Astra, and GPT-6.1 Sol through its [built-in allowlist](../../extensions/fast/index.ts), but remains a separate user-enabled choice. Successful priority-injected Sol/Luna requests did not expose the actual response tier in Pi CLI JSON; allowlisting does not prove Fast-tier fulfillment.

The [GPT-5.6 optimization note](gpt-5.6-harness-optimization.md) preserves dated reasoning and service-tier benchmarks; the [GPT-6 Astra readiness note](gpt-6-astra-harness-readiness.md) preserves its historical approvals and comparison evidence. Neither establishes comparative performance for these GPT-6 Sol/Luna routes.
