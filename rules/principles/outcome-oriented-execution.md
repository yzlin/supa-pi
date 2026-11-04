# Outcome-Oriented Execution

Apply when: planning a phased rewrite or migration.

Optimize for the intended, verifiable end state, not for smooth intermediate states.

**Why:** Keeping every intermediate step fully stable often creates temporary compatibility code that becomes long-lived debt.

- Prioritize end-state integrity over transitional stability.
- Intermediate breakage is acceptable only when it is planned, scoped, reversible, and declared up front.
- Validate each intermediate phase at its declared boundary; keep high-signal checks on touched areas while migrating.
- Require full static and runtime verification at the end. The final requested outcome must be usable.

---

Adapted from Lauren Tan's MIT-licensed [pstack `principle-outcome-oriented-execution`](https://github.com/cursor/plugins/tree/main/pstack); see `LICENSE.upstream`. Rewritten for Pi.
