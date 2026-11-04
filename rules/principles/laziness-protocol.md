# Laziness Protocol

Apply when: sizing a diff, refactoring, or tempted to thread a signal or decision through several places.

- **Minimize the diff.** Make the smallest complete change requested; every changed line must serve that scope. Explicitly requested broad refactors are allowed; unrelated or drive-by refactors are not.
- **Consolidate decisions.** Do not repeat one choice in several places. Put it behind one source of truth and pass the result as a simple value.
- Fewer lines beat elegant boilerplate.

Pairs with [subtract-before-you-add](subtract-before-you-add.md).

---

Adapted from Lauren Tan's MIT-licensed [pstack `principle-laziness-protocol`](https://github.com/cursor/plugins/tree/main/pstack); see `LICENSE.upstream`. Rewritten for Pi.
