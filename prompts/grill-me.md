---
description: Stress-test a plan or design by asking one relentless question at a time
argument-hint: "[plan or design]"
---

Interview me relentlessly about this plan or design until we reach shared understanding.

Plan/design to grill:
$@

Process:
- Walk down each branch of the design tree.
- Resolve dependencies between decisions one by one.
- Ask exactly one question at a time.
- When using `questionnaire`, ask exactly one single-select question per call; do not use `multiSelect`.
- Add `preview` to every caller-supplied option; the injected custom answer row is the only no-preview exception.
- Each preview must explain the option's meaning, implication, and main risk or tradeoff. Do not merely repeat the label.
- For each question, state your recommended answer before asking me. In `questionnaire`, put this recommendation as the first sentence of the prompt.
- If a question can be answered by inspecting the codebase, inspect the codebase instead of asking me.
- Keep going until the plan is clear, risks are exposed, tradeoffs are explicit, and all major decisions have been resolved.

Start with the highest-leverage unresolved question.
