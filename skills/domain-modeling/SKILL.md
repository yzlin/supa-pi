---
name: domain-modeling
description: "Canonical semantic primitive for sharpening domain vocabulary, testing it with scenarios, finding contradictions, reasoning about boundaries, and qualifying ADR candidates. Use standalone for explicit domain-modeling work or when delegated by another skill; it is not always-on."
---

# Domain Modeling

This skill is the canonical semantic primitive for domain analysis. Activate it standalone when the user explicitly asks to model a domain, resolve terminology, test domain claims, or assess boundaries or decisions. It may also be activated when delegated by another skill. It is explicitly not always-on: ordinary implementation and documentation work does not automatically invoke it.

Own vocabulary sharpening. Do not leave fuzzy synonyms, overloaded labels, or implementation names posing as domain concepts. Every glossary entry is strict and has this form: `**<canonical term>** — <concise definition>. _Avoid_: <alias 1>, <alias 2>.` Include aliases only after `_Avoid_`; if none are known, write `_Avoid_: none known.` Do not invent certainty—mark unresolved meanings as unknown and explain what evidence would resolve them.

Test each important claim with at least one concrete scenario that names a real actor, action, boundary, and observable outcome. Prefer examples and counterexamples over abstract restatement. Inspect targeted evidence needed to test the claim, such as the relevant code path, schema, API contract, durable docs, tests, or ownership configuration; do not perform an untargeted repository sweep. Compare code and durable docs. When they disagree, surface the contradiction with both sources and impact rather than silently choosing one as truth.

Reason about real boundaries, not directory shapes alone. Identify operational ownership, integration contracts and failure behavior, entity or data lifecycle, and each trust boundary where authority, validation, privacy, or control changes. Distinguish evidence from inference and label unknowns. Never expose, copy, or persist secrets, credentials, tokens, or raw private data. Redact sensitive values and report only the minimum structural fact needed for the model.

Assess every plausible ADR candidate with exactly three independent results:

- `hard to reverse: yes | no | unknown`
- `surprising without context: yes | no | unknown`
- `real tradeoff: yes | no | unknown`

All three must be `yes` for the item to qualify. Any `no` or `unknown` means it is not currently an ADR candidate; preserve the individual results and briefly state the missing evidence or failed criterion.

Domain-modeling does not directly write durable docs. If a direct request asks for persistence, first finish a completed packet internally in the required format below, then delegate it to `context-docs` for classification and writing. If invoked by `context-docs`, return analysis only and never delegate back; this prevents a delegation loop and leaves persistence ownership with `context-docs`.

Adapted from Matt Pocock's MIT-licensed `domain-modeling` skill at immutable commit [`84fdeffd12f2ee307994d1eb6feb48173b6e0502`](https://github.com/mattpocock/skills/blob/84fdeffd12f2ee307994d1eb6feb48173b6e0502/skills/engineering/domain-modeling/SKILL.md).

The exact five-section format below governs the final user-facing response only for standalone domain-modeling runs that do not hand off persistence. When another skill invokes domain-modeling, or when a persistence request is handed to `context-docs`, complete the same five-section packet for internal caller consumption but do not emit it as the final response; the caller skill governs interaction, writes, and final user-facing output. In standalone responses, use the sections in this order, with no preface, epilogue, or additional Markdown headings. Keep entries concise, evidence-linked when applicable, and safe to hand off as a completed packet. Use the concise empty state shown for a section with no findings.

## Resolved terms

List strict glossary entries in the required canonical format. Empty: `None.`

## Scenarios

List concrete `Actor / Action / Boundary / Outcome` cases and whether each supports, refutes, or leaves a claim unknown. Empty: `None.`

## Contradictions

List conflicting code/docs evidence, source locations, impact, and the focused question or evidence needed to resolve it. Empty: `None found.`

## Boundaries

List evidence-backed ownership, integration, lifecycle, and trust boundary findings; label inference and unknowns. Empty: `None identified.`

## ADR candidacy

For each candidate, list all three yes/no/unknown results and `Qualifies: yes | no`; qualification is yes only when all three results are yes. Empty: `None.`
