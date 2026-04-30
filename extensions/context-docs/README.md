# context-docs extension

Adds deterministic commands for durable project context documentation:

- `/context-setup [target] [--dry-run] [--force] -- [instructions]`
- `/context-note [target] [--title <title>] [--tags a,b] -- <note>`
- `/adr [target] [--title <title>] [--status proposed|accepted|superseded|deprecated|rejected] -- <decision>`
- `/context-review [target] [--dry-run] [--scope current|all] -- [focus]`
- `/context-grill [target] [--topic <topic>] [--depth light|standard|deep] -- [goal]`

The extension is registered in `package.json -> pi.extensions` as `./extensions/context-docs`.

## Bundled workflow docs

The command prompt is bundled in `extensions/context-docs/prompt.md`. The matching skill documentation is bundled at `skills/context-docs/SKILL.md`.

The workflow targets Matt-compatible context files by default:

- `CONTEXT.md` — human-readable domain/product overview, glossary, constraints, and open questions.
- `CONTEXT-MAP.md` — map of real durable-context boundaries, ADR locations, and explicit guidance for which docs agents should read.
- `docs/adr/` — Architecture Decision Records for tradeoff decisions.
- `docs/context/` — optional longer notes when root context files would become too large.

`CONTEXT-MAP.md` should use pi-style explicit instructions such as “read `docs/auth.md` before changing authentication, sessions, or user identity.”

`/adr` uses ADRs with status, date, context, tradeoff decision, consequences, and alternatives. `/context-review` extracts only source-grounded durable context, routes agent conventions to managed `AGENTS.md`, and excludes secrets, pi-task state, generic advice, and transient progress. `/context-grill` asks one question at a time, includes a recommended answer, inspects code/docs when possible, and does not write docs unless explicitly asked.

Natural-language prefixes are intercepted only for clear forms and require confirmation before transforming input:

- `context setup: ...`
- `context note: ...`
- `adr: ...`
- `context review: ...`
- `context grill: ...`
- `Take note that ...`
- `Remember that ...`
- `Record that ...`
