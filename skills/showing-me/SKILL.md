---
name: showing-me
description: Use when the user explicitly asks for show-me, a visual explanation, a diagram, or a code-shape sketch, or when a Playbook step calls it; choose the smallest useful visual.
origin: HumanLayer show-me, adapted
---

# Show Me

Use only when the user explicitly asks for Show Me or a visual explanation, diagram, or code-shape sketch, or when a Playbook or skill step calls it.

Make the current topic easy to scan. Skip the preamble and keep prose brief. Pick one view by default; combine views only when each answers a different part of the question.

Do not force a visual when one direct sentence is clearer.

## Depth

Pick the depth before the rung: `/show-me [teach|quick] [text|diagram|html] [topic]`.

- First argument `teach`: follow the `teach` skill for the rest of the topic.
- First argument `quick`: skip the `teach` skill; read only what the view itself needs.
- Otherwise, on the `/show-me` command, follow the `teach` skill when this session has not read the topic's code, or when the request asks how or why something works or asks to understand it. Else stay quick.
- When you pick the depth yourself, open the reply with two lines before any tool call: `Understood: <the question in your words>` and `Path: teach|quick — <the reason>`. A forced `teach` or `quick` skips these lines.
- When another skill or Playbook step applies this skill, never escalate.
- A depth word with no topic applies that depth to the latest result in this session.

## Explainer Ladder

If the first argument after any depth word is `text`, `diagram`, or `html`, render at that Explainer rung.
Otherwise, keep the existing smallest-useful choice.
If no topic follows, re-render the latest result in this session.

- `text`: Plain report prose per the `plain-report` skill; the same rung as `/wait-what`.
- `diagram`: Use the existing views table for trees, pseudocode, focused diffs, or Mermaid via `architecture-diagrams`; do not choose HTML at this rung.
- `html`: Use the `glimpse` skill to create one discardable Glimpse explainer under `$TMPDIR/supa-pi-show-me/`, never in the repository.

Video is not a rung; it is deferred.

## Choose the View

| Need | Default view |
| --- | --- |
| Logic or an algorithm | pseudocode |
| Runtime control flow | call tree |
| UI ownership, state, or module boundaries | component tree |
| File ownership or refactor scope | shallow file tree |
| Service interaction, state, or data flow | focused Mermaid diagram |
| Change to an existing shape | focused diff |
| Mostly new, copyable target shape | complete code or pseudocode block |
| Dense UI, layout, or comparison | one focused Glimpse HTML artifact |

## Shape Rules

- Keep only the calls, files, props, states, and boundaries needed for the current question.
- Use real names and paths when verified. Label unknown or inferred parts.
- Put each visual beside the short text it supports.
- Prefer a text tree or pseudocode over Mermaid when both communicate the point equally well.
- Use a focused diff when unchanged context matters; use a complete block when omission would hide ownership or order.
- For architecture work, load `architecture-diagrams` and select only the diagram types that answer the question.

## Rich Visuals

Use the `glimpse` skill when the topic needs a visual UI, layout comparison, infographic, or concept too dense for text or Mermaid.
Create one focused artifact with real labels and data, then show it through Glimpse.
Write HTML explainers under `$TMPDIR/supa-pi-show-me/`, never in the repository.

Do not create HTML for a simple code or control-flow explanation.
An explicit `html` request overrides this default.

## Stop Condition

Stop when the key relationship or change is visible. Do not repeat the same information as a diagram, tree, and prose summary.
When the `teach` skill applies this skill, its diagram series overrides "Pick one view by default" and this stop rule.
