# Attack the Premise

Apply when: two or more fixes that share one assumption have failed the same check.

Suspect the premise, not the fixes. Each failed fix is evidence against the belief it assumed.

1. **Write the premise down** as the one sentence every failed fix assumed.
2. **Test it before the next fix.** Find an observation that would differ if the premise were false, and make it. Look at how failures are distributed, not only how large they are. Make the check re-runnable.
3. **Follow the evidence.** If it contradicts the premise, the cause is elsewhere: look for what the failures share that the premise did not predict. If it confirms the premise, ask the next "why" per [fix-root-causes](fix-root-causes.md).
4. **Remove the condition instead of compensating for it**, per [laziness-protocol](laziness-protocol.md). A cleanup mechanism leaves the cause in place and adds work on every run.

**Stop:** no next fix before the premise is written down and tested.

---

Adapted from Lauren Tan's MIT-licensed [pstack `principle-attack-the-premise`](https://github.com/cursor/plugins/tree/main/pstack); see `LICENSE.upstream`. Rewritten for Pi.
