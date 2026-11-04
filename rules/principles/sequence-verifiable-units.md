# Sequence Verifiable Units

Apply when: planning multi-step work, sweeps, migrations, or a commit/PR stack.

Order work as small units that each end in a checkable state. Do not advance until the current unit is green.

**Why:** A break caught at the unit that caused it is cheap to localize. A break found after a batch is buried under work built on a broken base.

- **Execution:** each unit is a bracket: known-good state, one change, run the check, proceed. In a sweep of similar edits, verify each before the next.
- **Delivery:** stack commits in the order that proves the work: failing test, then fix; subtraction before reshape; baseline before treatment; scaffold before feature. Each commit lands on its own.

Complements [prove-it-works](prove-it-works.md), which keeps each check real.

---

Adapted from Lauren Tan's MIT-licensed [pstack `principle-sequence-verifiable-units`](https://github.com/cursor/plugins/tree/main/pstack); see `LICENSE.upstream`. Rewritten for Pi.
