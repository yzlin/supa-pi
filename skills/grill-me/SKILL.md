---
name: grill-me
description: Explicit /grill-me wrapper. Use only when the user invokes /grill-me; grills the supplied plan while preparing canonical context docs.
---

# `/grill-me`

For an explicit `/grill-me <plan>` invocation:

- Load and follow the `grilling` skill as the canonical interview primitive.
- Load and follow the `context-docs` skill as the canonical durable-context contract.
- Pass the complete supplied plan through and apply the docs-specific behavior below.

## Docs-Specific Behavior

- Start with a docs-first preflight: read `CONTEXT.md`, `CONTEXT-MAP.md`, and relevant ADRs when present.
- Inspect code only for targeted verification or resolvable facts that materially affect the interview.
- If multiple contexts could apply and the target is ambiguous, ask exactly one target-selection question before grilling.
- Draft durable content during the interview, but do not write any file before the user chooses the final `Lock plan, stop here` option.
- If the user chooses `Keep grilling`, continue the interview. After the user chooses `Lock plan, stop here`, immediately write any qualifying drafted content.

## Allowed Writes

Write only:

- `CONTEXT.md`
- `CONTEXT-MAP.md`
- qualifying ADRs

This narrow allowed-write list overrides the broader destinations available in normal `context-docs` workflows.

- Do not write other durable artifacts.
- Continue to follow all other `context-docs` requirements, including its context and ADR semantics.
- `CONTEXT.md` may contain domain or product facts, canonical language, constraints, and open questions.
- Create or update an ADR only when the decision is hard to reverse, surprising without context, and records a real tradeoff.
- If the interview produces no durable content, write nothing and explain why.
