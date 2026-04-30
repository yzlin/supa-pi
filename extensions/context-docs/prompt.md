# Context Docs Workflow

Use this workflow to create, update, review, or clarify durable project context.

## Commands

- `/context-setup`: create or refresh the target project's context-doc scaffold.
- `/context-note`: add a dated domain, product, boundary, implementation, or convention note.
- `/adr`: create or update an Architecture Decision Record for a tradeoff decision.
- `/context-review`: inspect context docs and extract durable context from evidence.
- `/context-grill`: interview the user with focused questions until important context is clear.

## Core rules

- The resolved command input is authoritative.
- Keep work scoped to the target root.
- Do not create, modify, schedule, or manage pi-tasks.
- Preserve existing docs, style, filenames, numbering, and frontmatter when present.
- Prefer small Markdown edits over broad rewrites.
- Ask only when missing information materially changes the durable record.
- Never write secrets, credentials, private keys, tokens, or raw sensitive logs into context docs.

## Matt-compatible scaffold

`/context-setup` should make the target root compatible with Matt-style project context files:

- `CONTEXT.md`: the human-readable domain/product context entrypoint.
- `CONTEXT-MAP.md`: the map of real durable-context boundaries, relevant files, and when agents should read them.
- `docs/adr/`: ADRs for tradeoff decisions.
- `docs/context/`: optional longer notes when `CONTEXT.md` would become too large.

If `CONTEXT.md` exists, update it in place. If absent, create a concise file with these sections:

```markdown
# CONTEXT

## Product purpose

## Domain model

## Domain glossary

## Product constraints

## Open questions

## Context map

See `CONTEXT-MAP.md`.
```

If `CONTEXT-MAP.md` exists, update it in place. If absent, create a concise file with these sections:

```markdown
# CONTEXT-MAP

## Read first

- `CONTEXT.md` — domain/product overview, glossary, constraints, and open questions.

## Architecture decisions

- `docs/adr/` — accepted, proposed, superseded, deprecated, rejected tradeoff decisions.

## Context notes

- `docs/context/` — longer durable notes that should not live in chat only.

## Maintenance rules

- List cross-cutting docs in `CONTEXT-MAP.md` with plain-language guidance for when agents should read them.
- Keep entries stable, source-grounded, and small.
```

Use pi-style explicit instructions in `CONTEXT-MAP.md` or `AGENTS.md`:

```markdown
- `docs/auth.md` — read before changing authentication, sessions, or user identity.
```

## Context note guidance

`/context-note` records durable context only. Good notes include:

- domain vocabulary that future agents must use correctly
- product or implementation conventions that affect implementation choices
- agent conventions, written to the managed `AGENTS.md`, not `CONTEXT.md`
- real module boundaries or ownership, reflected in `CONTEXT-MAP.md`
- workflow rules specific to this target root
- resolved implementation details likely to matter later
- unresolved questions with clear owner or next trigger

Reject or challenge notes that are only:

- transient progress updates
- generic advice not specific to the project
- raw logs without a durable takeaway
- secrets or sensitive data
- task-management instructions

Prefer appending domain/product language to `CONTEXT.md`, agent conventions to the managed `AGENTS.md`, or longer notes to a targeted file under `docs/context/`. Update `CONTEXT-MAP.md` only for real durable-context boundaries or new cross-cutting files.

## ADR guidance

`/adr` creates or updates an Architecture Decision Record for a tradeoff decision under `docs/adr/` unless the target already has an ADR convention.

Use stable lowercase hyphenated filenames. If the target has no numbering convention, prefer:

```text
docs/adr/YYYY-MM-DD-short-title.md
```

Use this ADR shape:

```markdown
# ADR: <title>

- Status: proposed | accepted | superseded | deprecated | rejected
- Date: YYYY-MM-DD
- Deciders: unknown unless provided
- Supersedes: none unless known
- Superseded by: none unless known

## Context

## Decision

## Consequences

## Alternatives considered
```

Rules:

- Capture the tradeoff decision and rationale, not a generic essay.
- Mark unknowns explicitly instead of inventing facts.
- If a decision replaces an older ADR, update both records when safe.
- If rationale is missing, ask one focused question before writing an accepted ADR.
- Default status is `proposed` unless the command or evidence says otherwise.

## /context-review extraction rules

`/context-review` is an extraction and drift-detection workflow.

Read, at minimum when present:

- `CONTEXT.md`
- `CONTEXT-MAP.md`
- `AGENTS.md`
- docs referenced by `CONTEXT-MAP.md`
- ADRs in `docs/adr/`
- relevant README files for the requested scope

Extract only durable, source-grounded context:

- product purpose and constraints
- real architecture boundaries and ownership
- domain terms and definitions
- accepted or proposed tradeoff decisions with rationale
- conventions that change future implementation behavior, routed to `AGENTS.md` when they are agent conventions
- integration contracts and external dependencies
- stale, contradictory, or missing docs
- open questions that block accurate documentation

Do not extract:

- secrets, credentials, keys, tokens, or raw private data
- pi-task creation, status, scheduling, or progress data
- temporary debugging output without a durable lesson
- unverified claims from memory
- code snippets that will become stale unless necessary

Behavior:

- With `--dry-run`, report findings and proposed edits only.
- With `--scope current`, prefer the current context-doc set and directly referenced docs.
- With `--scope all`, also scan broader repo docs that may contradict or supplement context.
- Report contradictions before editing them.
- When editing, make the smallest doc changes that preserve existing structure.

## /context-grill behavior

`/context-grill` clarifies missing context before docs are written.

- Ask exactly one high-leverage question at a time.
- Include your recommended answer before asking for the user's answer.
- If code or docs can answer the question, inspect them instead of asking.
- Focus on goals, boundaries, assumptions, failure modes, tradeoffs, tests, security, migration, and ownership.
- Stop when the missing context is clear enough to document safely.
- End with a short summary of captured decisions, remaining open questions, and suggested doc updates.
- Do not write docs during the grill unless the user explicitly asks.

Depth:

- `light`: ask only the highest-risk missing question.
- `standard`: cover major assumptions and tradeoffs.
- `deep`: continue until architecture, risks, tests, and migration implications are explicit.

## Output

When done, summarize:

- files read
- files changed
- decisions captured
- open questions
- validation performed
