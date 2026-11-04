# Prove It Works

Apply when: claiming any task, check, or subagent result is done.

Verify output by checking the real thing directly. Do not infer from proxies, self-reports, or "it compiles". Prefer the narrowest sufficient proof; use end-to-end verification where boundaries need it. If blocked, say what is missing.

**Why:** Unverified work has unknown correctness. Indirect signals (file mtimes, cached output, a child's report, an old screenshot) feel cheaper than observation, but acting on a wrong inference costs more than checking.

- Check liveness, values, and output directly with `bash` or `read`, not through derived state.
- A `subagent` report is a claim. Re-run or re-read before you report it as done.
- When verification fails, suspect the observation method before the system.
- When a check passes too easily, suspect the check.
- Prefer a deterministic script that re-runs the comparison over a one-time look. Keep its output where the user can re-run it.
- Report a check you could not run as not verified, never as passing.

---

Adapted from Lauren Tan's MIT-licensed [pstack `principle-prove-it-works`](https://github.com/cursor/plugins/tree/main/pstack); see `LICENSE.upstream`. Rewritten for Pi.
