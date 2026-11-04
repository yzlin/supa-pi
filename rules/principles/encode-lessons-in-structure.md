# Encode Lessons in Structure

Apply when: writing the same instruction a second time, or seeing the same correction recur.

A repeated instruction is a symptom. Encode the rule where it cannot be skipped: a test, a lint, a schema, a runtime check, a tool refusal, or a script. Prose that the next session can ignore will be ignored again.

- Pin agent-facing prose that must not drift with a contract test, as `extensions/skills/*-contract.test.ts` does.
- When a fix makes the bad state impossible, ship only that fix. Do not also add an instruction about it.
- When the rule needs judgment and cannot be encoded, make the instruction prominent and add one example of the failure.
- Add the regression test in the same change as the fix.

---

Adapted from Lauren Tan's MIT-licensed [pstack `principle-encode-lessons-in-structure`](https://github.com/cursor/plugins/tree/main/pstack); see `LICENSE.upstream`. Rewritten for Pi.
