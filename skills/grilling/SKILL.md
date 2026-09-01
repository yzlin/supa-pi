---
name: grilling
description: Interview users about plans, decisions, ideas, designs, architectures, and proposals. Use for natural requests such as "grill me", "stress-test this", "poke holes in this plan", "challenge my design", "interview me about this", or adversarial review.
---

# Grilling

Use this as the single canonical interview primitive for plans, decisions, and ideas.

## Ownership

- Walk the user through the decision tree, resolving dependencies between decisions one branch at a time.
- Discover facts from the environment instead of asking the user. Inspect available code, documentation, configuration, and other evidence when they can answer a question.
- The user owns every decision. Give clear recommendations and tradeoffs, but never silently decide for them.
- Do not act on the plan or make implementation changes before the user confirms the final lock.

## Domain Modeling Composition

Load and follow `domain-modeling` only when the interview exposes explicit domain signals: fuzzy or disputed terms, domain claims that need scenario testing, code and durable docs conflict, ownership, integration, lifecycle, or trust boundaries are unclear, or there is possible ADR candidacy. Do not load it for every interview.

Use its completed packet to guide subsequent interview questions while preserving the canonical interview contract and final lock behavior below. Do not persist the packet; when durable writing is requested, hand it to `context-docs`.

## Interview Contract

- Ask exactly one question at a time.
- Use `questionnaire` for user answers when interactive UI is available.
- When using `questionnaire`, ask exactly one single-select question per call; do not use `multiSelect`.
- Add `preview` to every caller-supplied option; the injected custom answer row is the only no-preview exception.
- Keep every preview concise and decision-ready. Format it with compact, explicit `Meaning:`, `Outcome:`, and `Tradeoff:` parts; do not merely repeat the label.
- Do not put a recommendation in the questionnaire prompt or question description. Prefix the recommended option label with `Recommend:` and its preview with `Recommend:`. Add a `Why recommended:` part tied to known goals or constraints rather than personal preference.
- When a decision involves flows, boundaries, states, hierarchies, or comparisons, include a compact unfenced plain-text diagram. Simple choices need no decorative diagram.
- Never re-ask an answered question. If it was asked in plain text, accept the answer without repeating it with `questionnaire`; briefly summarize it, then move to the next unresolved decision.
- Start with the highest-leverage unresolved question. Continue in descending leverage until the plan is clear, risks are exposed, tradeoffs are explicit, and all major decisions are resolved.

## Risk Taxonomy

Probe the applicable risks in this order of leverage:

- unclear goals and success criteria
- hidden assumptions and missing constraints
- architecture and dependency choices
- edge cases and failure modes
- security and privacy implications
- migration, compatibility, and reversibility
- operational and performance risks
- testing and observability gaps
- user-experience tradeoffs

Ask direct, specific questions. Do not ask broad or multi-part questions.

## Final Confirmation

Once all major decisions are resolved, ask one final `questionnaire` gate with exactly two caller-supplied options: `Lock plan, stop here` and `Keep grilling`. Rely on the injected custom row for `Type something.`; do not supply it yourself.

The final gate must not ask whether to proceed to implementation and must not include any implement/proceed/start-coding wording or option. If the user chooses `Keep grilling`, continue one question at a time. Treat only `Lock plan, stop here` as confirmation that the interview is complete.
