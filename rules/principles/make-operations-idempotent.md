# Make Operations Idempotent

Apply when: writing commands, setup steps, resume paths, logs, or loops that can crash, restart, or run twice.

An operation must reach the same correct end state however many times it runs and wherever the last run stopped. Ask of every state change: "What if this runs twice? What if the last run died halfway?"

**Why:** Setup scripts, session resume, Spec logs, and child runs restart as a matter of course. If leftover state changes the next outcome, every restart becomes a debugging session.

- Derive each step from the state that exists, not from what the last run meant to do. Read the current state, compare it with the goal, and apply only the difference.
- Anything a run leaves behind (a lock, a temp file, a half-written record, a claimed job) must be recognizable as stale by the next run, wherever the last run stopped.
- Write to a temporary path and rename into place. Compare by content, not by creation order.
- Prefer append-only records that a reader can replay over in-place edits.

**The test:** run it twice; kill it at each step and run it again. If the end state "depends on what was left behind", add a reconciliation step.

---

Adapted from Lauren Tan's MIT-licensed [pstack `principle-make-operations-idempotent`](https://github.com/cursor/plugins/tree/main/pstack); see `LICENSE.upstream`. Rewritten for Pi.
