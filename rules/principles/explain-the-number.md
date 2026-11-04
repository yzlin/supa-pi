# Explain the Number

Apply when: reporting a benchmark, eval score, metric, or before/after comparison.

- **Write the decision before you run.** Name the result that would change a decision, and the noise floor. Stop when run-to-run spread exceeds the effect.
- **Ask "why not double?"** Name what bounds the result (a core, a lock, the disk, the network, the load generator) from a profile or counters taken during the run, then map it to source. A guess from reading code is not a limiter.
- **List what else the number could measure** and rule each out with evidence: errors, skipped or cached work, code that never ran, an untuned side, noise, a piece too small to matter end to end.
- **Keep the evidence with the number:** run count, spread, and limiter.

For performance work, follow the `performance-optimization` skill. Before you report any measured number, including an eval score or token count, run its benchmark checklist (`skills/performance-optimization/references/benchmark-checklist.md`). For an eval, ask whether every run did the task, whether the gap holds across trials and models, and whether the scenario matters. Distinct from [prove-it-works](prove-it-works.md), which checks that an output is real.

---

Adapted from Lauren Tan's MIT-licensed [pstack `principle-explain-the-number`](https://github.com/cursor/plugins/tree/main/pstack); see `LICENSE.upstream`. Rewritten for Pi.
