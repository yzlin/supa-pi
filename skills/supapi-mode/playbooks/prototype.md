# Prototype

You own the decision, not the code. The prototype is a throwaway instrument; the real build follows `feature`.

1. Name the decision the prototype exists to make: which layout, interaction, behavior, timing, or approach. No decision means no prototype.
2. Build throwaway code in a scratch directory outside production source, under `$TMPDIR` unless the user names a path. Use the lightest stack that exercises the question. No tests or abstractions.
3. When comparing alternatives, label each variant and make them easy to switch between.
4. Observe the thing you are deciding: screenshot each variant (the `web-browser` or `glimpse` skill), or log the timing or output. The observation is the evidence.
5. Present the variants, evidence, tradeoffs, and a recommendation.

Use this Playbook instead of asking the user when a fork is a fact a run can settle. Ask only about product or preference calls.

**Principles:** `never-block-on-the-human`, `explain-the-number`, `subtract-before-you-add`, `build-the-lever`.

**Reply:** the variants, the evidence, tradeoffs, the recommendation, and the scratch path. Say plainly that the prototype is throwaway.
