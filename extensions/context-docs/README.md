# context-docs extension

Adds deterministic commands for durable project context documentation:

- `/context-setup [target] [--dry-run] [--force] -- [instructions]`
- `/context-note [target] [--title <title>] [--tags a,b] -- <note>`
- `/adr [target] [--title <title>] [--status proposed|accepted|superseded|deprecated|rejected] -- <decision>`
- `/context-review [target] [--dry-run] [--scope current|all] -- [focus]`

The extension is registered in `package.json -> pi.extensions` as `./extensions/context-docs`.

## Workflow ownership

`skills/context-docs/SKILL.md` is the canonical source for shared and command-specific workflow behavior. `extensions/context-docs/prompt.md` and the runtime handoff in `extensions/context-docs/index.ts` contain only the execution envelope and direct the agent to that skill.

The workflows preserve Matt-compatible files while keeping SupaPi's broad `CONTEXT.md` semantics:

- `CONTEXT.md` — human-readable product purpose, domain model and glossary, constraints, open questions, and context-map pointer.
- `CONTEXT-MAP.md` — real durable-context boundaries, ADR locations, and explicit guidance for which docs agents should read.
- `docs/adr/` — full Architecture Decision Records for tradeoff decisions.
- `docs/context/` — optional longer durable notes.
- managed `AGENTS.md` sections — agent-specific conventions.

Natural-language prefixes are intercepted only for clear forms and require confirmation before transforming input:

- `context setup: ...`
- `context note: ...`
- `adr: ...`
- `context review: ...`
- `Take note that ...`
- `Remember that ...`
- `Record that ...`

The parser confines targets to the current project root, command and natural-language handoffs refuse likely secrets, idle commands dispatch immediately, and busy commands queue a follow-up. Managed block helpers fail fast on malformed marker pairs instead of appending duplicate sections.
