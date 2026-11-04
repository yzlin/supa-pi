# Fix Root Causes

Apply when: debugging, fixing a defect, or tempted to add a guard, retry, or fallback where an error surfaced.

Fix the fault, not the place where it surfaced. The symptom is where a wrong state became visible. The root cause is the first place the system did something it should not, or failed to handle a state it should handle.

**Why:** A symptom fix hides the evidence and leaves the fault free to surface elsewhere. Every unnamed workaround makes the system harder to reason about.

- Reproduce first.
- Ask "why" at each step until the answer is a wrong decision in the code, not a consequence of an earlier one.
- When stuck, instrument. Read the actual error and the actual state. Do not guess.
- Ask whether the triggering state is legitimate. If it is, the code that broke on it is the root cause and handling the state there is the fix. If it should never exist, a check where it broke hides the bug; find what produced the state. Guards, retries, swallowed errors, clamped values, and discarded state are the usual ways to hide a bug.
- When something fails only after a restart, suspect persisted state first: config, caches, lock files, serialized sessions.
- Fix the pattern, not just the instance. Find every place with the same fault (`grep`) and fix them all.
- A workaround that needs a paragraph-long comment means the code is wrong. Fix the code.
- If the deciding fact took a deep dig, propose the cheap always-on signal that would have shown it at first look.

When two fixes on the same premise fail, stop and apply [attack-the-premise](attack-the-premise.md).

---

Adapted from Lauren Tan's MIT-licensed [pstack `principle-fix-root-causes`](https://github.com/cursor/plugins/tree/main/pstack); see `LICENSE.upstream`. Rewritten for Pi.
