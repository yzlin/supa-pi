---
description: Stress-test a plan while drafting durable context docs only after lock
argument-hint: "-- <plan>"
---

Use the `grill-me` skill behavior as canonical.
Also use the `context-docs` skill behavior for durable project context.

Command syntax: `/grill-with-docs -- <plan>`

Plan/design to grill:
$@

Workflow:
- Docs-first preflight: read existing context docs before grilling, including `CONTEXT.md`, `CONTEXT-MAP.md`, and relevant ADRs when present.
- Inspect code only for targeted verification or resolvable questions that materially affect the interview.
- If multiple contexts could apply and the target is ambiguous, ask one target-selection question before grilling.
- Ask one question at a time.
- Use questionnaire rules inherited from `grill-me`.
- Draft durable docs during the interview, but do not write files before the final lock.
- The only final gate options are exactly `Lock plan, stop here` and `Keep grilling`.
- The final gate must not ask to implement, proceed, or start coding.
- If the user chooses `Keep grilling`, continue the interview one question at a time.
- If the user chooses `Lock plan, stop here`, write the drafted docs immediately.

Allowed artifacts:
- `CONTEXT.md`
- `CONTEXT-MAP.md`
- ADRs

Artifact rules:
- Do not write any other durable artifacts.
- `CONTEXT.md` may contain domain/product facts, canonical language, constraints, and open questions.
- Create or update an ADR only when all are true: the decision is hard to reverse, surprising without context, and records a real tradeoff.
- If there is no durable content, write nothing and explain why.
