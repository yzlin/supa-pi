# Test Behavior, Not Implementation

Apply when: writing, reviewing, or deleting tests.

A test claims what the code does for its users: a caller, an end user, or another service. Behavior is what they observe through their interface: return values, errors, readable state, and external effects. Implementation is what they cannot see: private helpers, call order, intermediate data.

Judge each test against two imagined edits:

- **Break the behavior** (wrong value, skipped or doubled effect). If the test still passes, it proves nothing. Usual causes: an assertion looser than the contract, an expected value computed by the code under test, a restated constant or prompt string that never runs the code that reads it, or an assertion on data the test built itself.
- **Change the internals** with every observable result kept. If the test fails, it is pinned to the implementation.

Keep tests that catch the first edit and survive the second; rewrite or delete the rest. Drive the code through its users' interface with a concrete input, derive the expected value from the requirement, and assert what the contract promises, no less and no more.

The contract decides. A mocked external service's payload is behavior; a call to an internal helper is not. An exact error message pins wording no caller reads; the error type callers branch on is the contract. An invariant (a key present in two tables, a compile-time check) is behavior.

Contract tests on prompt or skill text prove wiring only, not model adherence; say so when you report them. Method lives in the `tdd-workflow` skill.

---

Adapted from Lauren Tan's MIT-licensed [pstack `principle-test-behavior-not-implementation`](https://github.com/cursor/plugins/tree/main/pstack); see `LICENSE.upstream`. Rewritten for Pi.
