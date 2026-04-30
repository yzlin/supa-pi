---
name: context-docs
description: "Use for durable project context workflows: /context-setup, /context-note, /adr, /context-review, /context-grill, CONTEXT.md, CONTEXT-MAP.md, ADRs, context extraction, or turning session knowledge into persistent docs. Do not use for pi-task management."
---

# Context Docs

Use this skill when creating, reviewing, or clarifying durable context documentation for a project.

## Commands

- `/context-setup [target] [--dry-run] [--force] -- [instructions]`
- `/context-note [target] [--title <title>] [--tags a,b] -- <note>`
- `/adr [target] [--title <title>] [--status proposed|accepted|superseded|deprecated|rejected] -- <decision>`
- `/context-review [target] [--dry-run] [--scope current|all] -- [focus]`
- `/context-grill [target] [--topic <topic>] [--depth light|standard|deep] -- [goal]`

## Durable files

Prefer Matt-compatible root context files:

- `CONTEXT.md` — human-readable domain/product overview, glossary, constraints, and open questions.
- `CONTEXT-MAP.md` — map of real context boundaries, ADR locations, and explicit guidance for which docs agents should read.
- `docs/adr/` — Architecture Decision Records for tradeoff decisions.
- `docs/context/` — optional longer durable notes.

Preserve existing conventions if the target already has them.

Use pi-style explicit instructions in `CONTEXT-MAP.md` or `AGENTS.md`, such as “read `docs/auth.md` before changing authentication, sessions, or user identity.”

## ADR minimum

Every ADR should include:

- title
- status
- date
- context
- decision
- consequences
- alternatives considered, if known

Ask one focused question if the tradeoff decision or rationale is missing.

## Review extraction

Extract only source-grounded durable context:

- domain terms
- module boundaries
- tradeoff architecture decisions
- project-specific conventions, routed to managed `AGENTS.md` when they are agent conventions
- integration contracts
- stale or contradictory docs
- open questions that block future work

Do not extract secrets, raw private data, pi-task status, generic advice, or transient progress updates.

## Grill behavior

For `/context-grill`:

- Ask exactly one question at a time.
- Provide your recommended answer before asking the user.
- Inspect code/docs instead of asking when possible.
- Stop when the context is clear enough to document.
- Do not write docs unless explicitly asked.

## Done criteria

Summarize files read, files changed, decisions captured, open questions, and validation performed.
