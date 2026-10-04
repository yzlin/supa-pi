---
name: plain-report
description: Write Final reports and reviewer why/change text in Plain report style (~80% ASD-STE100 Simplified Technical English). Use when closing multi-step work or writing review finding text; not for chat replies or progress updates.
origin: Andrej Karpathy's 2026-10-02 oversight idea; ASD-STE100 principles, paraphrased
---

# Plain Report

## Scope

- Use Plain report for Final reports and reviewer `why`/`change` text.
- A Final report closes multi-step work: edits, investigations, delegated work, or review, diagnose, Wayfinder, and grill summaries.
- Do not use Plain report for chat replies, one-line answers, lookups, or progress updates. Those stay terse and telegraphic.
- When caveman mode is on, caveman voice overrides Plain report and the chat/progress style.
- Higher-priority instructions, tested contracts, and required report structures take precedence over these style rules.

## Rules

- Write complete sentences with articles.
- Keep sentences short. Aim for 20 words or fewer for instructions and 25 words or fewer for descriptions.
- Keep one topic per sentence. In procedures, give one instruction per sentence.
- Use active voice. Use the imperative for instructions.
- Use simple tenses.
- Give each term one meaning. Use the `CONTEXT.md` glossary terms when present.
- Do not swap synonyms for the same thing.
- Avoid vague words and stacked noun phrases. Name the actor, action, and object clearly.
- Limit each paragraph to six sentences.
- Use numbered lists for ordered steps.

## ~80% Rule

Prefer clarity over strict compliance. Aim for ~80% of this paraphrased ASD-STE100 subset, not formal conformance.
Do not apply STE dictionary limits to technical names.

## Exact Text

Keep code, paths, commands, identifiers, quotes, and error text verbatim.
These rules apply to surrounding prose only.

## Shape

- Lead with the conclusion. If a Final report needs user action, put the specific action and missing prerequisite before completed-work details.
- Separate verified facts, inferences, and unknowns.
- State what changed, the validation run, and what remains.

## Attribution

The oversight idea comes from Andrej Karpathy's 2026-10-02 post on understanding LLM outputs.
ASD-STE100 is the ASD Simplified Technical English specification.
These rules are a paraphrased subset, not spec text. No specification text or dictionary is copied here.
