---
name: showing-me
description: Use when the user explicitly asks for show-me, a visual explanation, a diagram, or a code-shape sketch; choose the smallest useful visual.
origin: HumanLayer show-me, adapted
---

# Show Me

Use only when the user explicitly asks for Show Me or a visual explanation, diagram, or code-shape sketch.

Make the current topic easy to scan. Skip the preamble and keep prose brief. Pick one view by default; combine views only when each answers a different part of the question.

Do not force a visual when one direct sentence is clearer.

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

Use the `glimpse` skill when the topic needs a visual UI, layout comparison, infographic, or concept too dense for text or Mermaid. Create one focused artifact with real labels and data, then show it through Glimpse. Do not create HTML for a simple code or control-flow explanation.

## Stop Condition

Stop when the key relationship or change is visible. Do not repeat the same information as a diagram, tree, and prose summary.
