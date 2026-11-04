# Build the Lever

Apply when: a check, analysis, or repeated mechanical step is not trivial, or when you hand a recipe to several subagents.

Build the small tool that does or proves the work, instead of doing it by hand. A script runs the same way each time, and a reviewer can rerun it. Work done by hand can only be checked by doing it again.

- For verification: a rerunnable check, equivalence diff, or eval scorer, per [Prove It Works](prove-it-works.md).
- For analysis: a query or script over the data, with its output kept where the user can rerun it.
- For delegation: write the recipe, the verification contract, and the do-not-touch fences once, in a file outside the children's write scope, and point every child at it.
- For source edits: use the `edit` tool. Do not edit files with Python or other ad-hoc scripts. A generator is acceptable only for files that are generated output by design.
- Do the first unit by hand to learn the recipe; then run the tool on that unit and compare.
- Make the tool safe to rerun, per [Make Operations Idempotent](make-operations-idempotent.md). Commit it when the work outlives the session.

Build the smallest script that does the job, never a framework, per [Laziness Protocol](laziness-protocol.md). If you cite this Principle, the change includes the script, check, or recipe file.

---

Adapted from Lauren Tan's MIT-licensed [pstack `principle-build-the-lever`](https://github.com/cursor/plugins/tree/main/pstack); see `LICENSE.upstream`. Rewritten for Pi.
