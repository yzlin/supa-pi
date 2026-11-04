# Foundational Thinking

Apply when: starting a feature, ordering phases, or choosing between structural and code-level options.

Structural decisions protect option value. Code-level decisions protect simplicity.

- **Data structures first.** Get the data shape right before logic. Define core types early, trace every access pattern, and pick structures that fit the dominant paths.
- **DRY the structure, not every line.** Types and data models should converge; three similar statements still beat a premature abstraction. Prefer explicit over clever.
- **Concurrency.** Before sharing state, ask what happens if another actor modifies it concurrently. If the answer is not "nothing", isolate it.
- **Scaffold first.** Do first what helps every later phase: CI, lint, test infrastructure, shared types. Setup before features, tests before fixes. Keep commits small and single-purpose.
- Each increment lands a coherent abstraction or deepens one. Do not spread a new capability across callers as special-case coordination.
- Subtraction comes before scaffolding, per [subtract-before-you-add](subtract-before-you-add.md).

---

Adapted from Lauren Tan's MIT-licensed [pstack `principle-foundational-thinking`](https://github.com/cursor/plugins/tree/main/pstack); see `LICENSE.upstream`. Rewritten for Pi.
