---
name: grill-me
description: Interview the user relentlessly about a plan, design, architecture, feature proposal, or technical decision until shared understanding is reached. Use when the user says "grill me", "stress-test this", "poke holes in this plan", "challenge my design", "interview me about this", or asks for adversarial design review.
---

# Grill Me

Interview the user relentlessly about every aspect of their plan or design until shared understanding is reached.

## Workflow

- Walk down each branch of the design tree.
- Resolve dependencies between decisions one by one.
- Ask exactly one question at a time.
- Use `questionnaire` for user answers when interactive UI is available.
- When using `questionnaire`, ask exactly one single-select question per call; do not use `multiSelect`.
- Add `preview` to every caller-supplied option; the injected custom answer row is the only no-preview exception.
- Each preview must explain the option's meaning, implication, and main risk or tradeoff. Do not merely repeat the label.
- For each `questionnaire` question, do not put the recommendation in the prompt or question description. Instead, prefix the recommended option label with `Recommend:`; if that option has a `preview`, prefix the preview with `Recommend:` too.
- If a question was already asked in plain text, accept the user's answer and move on; do not ask the same question again with `questionnaire`.
- Do not re-ask an answered question. Summarize the answer briefly, then continue to the next unresolved decision.
- If a question can be answered by exploring the codebase, explore the codebase instead of asking.
- Keep going until the plan is clear, risks are exposed, tradeoffs are explicit, and all major decisions have been resolved.

## Question Style

Be direct, specific, and demanding.

Prefer questions that expose:

- unclear goals
- hidden assumptions
- missing constraints
- edge cases
- failure modes
- migration concerns
- testing gaps
- operational risks
- security or privacy implications
- user-experience tradeoffs

Do not ask broad multi-part questions. Ask one high-leverage question at a time.

Start with the highest-leverage unresolved question.
