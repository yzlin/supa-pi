# Subtract Before You Add

Apply when: adding code, abstractions, configuration, options, prompts, or docs to an existing system.

Remove complexity first, then build. Leave the design simpler and more capable behind the same or smaller surface.

- Do not add abstractions, configuration, flexibility, or future-proofing unless the requested change needs them.
- Sequence removal before construction: delete dead code and one-caller wrappers before laying the new shape.
- Cut before you polish. Reach the minimum before investing in quality.
- Design for observed usage, not speculative edge cases. No validators, parsers, or guards beyond what the requirement demands.
- Simplify prompts and skills: remove redundant instructions and excess templates.
- When a reference has no novel content, delete it instead of leaving a stub.

---

Adapted from Lauren Tan's MIT-licensed [pstack `principle-subtract-before-you-add`](https://github.com/cursor/plugins/tree/main/pstack); see `LICENSE.upstream`. Rewritten for Pi.
