# Context Docs Workflow

Use this workflow to create, update, review, or clarify durable project context.

## Core rules

- The resolved command input is authoritative.
- Keep work scoped to the target root.
- Do not create, modify, schedule, or manage pi-tasks.
- Preserve existing docs, style, filenames, numbering, and frontmatter when present.
- Prefer small Markdown edits over broad rewrites.
- Ask only when missing information materially changes the durable record.
- Never write secrets, credentials, private keys, tokens, or raw sensitive logs into context docs.

## Durable files

Prefer Matt-compatible root context files unless the target already has stronger conventions:

- `CONTEXT.md`: the human-readable domain/product context entrypoint.
- `CONTEXT-MAP.md`: the map of real durable-context boundaries, relevant files, and when agents should read them.
- `docs/adr/`: ADRs for tradeoff decisions.
- `docs/context/`: optional longer notes when root context files would become too large.

Use pi-style explicit instructions in `CONTEXT-MAP.md` or `AGENTS.md`:

```markdown
- `docs/auth.md` — read before changing authentication, sessions, or user identity.
```

## Output

When done, summarize:

- files read
- files changed
- decisions captured
- open questions
- validation performed
