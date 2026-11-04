# Correct

You own making a repeated agent mistake impossible. Assume every contributor is an agent that sees only the files it opened, copies the nearest example, and takes the shortest path that passes. A change that looks right from one file must be right for the whole repository.

1. Find the mistake classes. Read recent commits and reverts (`git log --format='%h %ad %s' --date=short -50`, `git log --grep='revert\|fix' -i`), review reports, `AGENTS.md` files, `CONTEXT.md`, comments that explain a workaround, and `docs/context/enforced-rules.md`. When the user names a correction, start from it. Group the mistakes into classes. A class counts once it has happened twice; cite both occurrences (commit, file, or session turn).
2. For each class, pick the highest level that works, and say why each higher level does not:
   1. **Architecture:** one owner per piece of state, one supported way per task, internals the wrong caller cannot reach, one source of truth instead of hand-synced lists. Delete the old way and dead code an agent would copy.
   2. **Types or a tool refusal:** the bad state cannot be written, or the tool refuses it (as `spec_log` refuses a write to a legacy log).
   3. **A check whose failure names the fix:** a lint, a contract test, or a loader test. If the pattern is already common, fail only when a change adds more.
   4. **A behavior test:** fix or delete a test that still passes when its behavior breaks, or that fails when only internals change.
   5. **Prose last,** only for judgment calls. Nothing fails when an agent skips it.
3. Fix the most frequent classes, one commit per class, per the `sequence-verifiable-units` Principle. Prove each new check fails on a real past mistake: restore the old file or line, run the check and see it fail, then restore the fix and see it pass. A check never seen failing is not proof.
4. Run the check the same way the repository runs it (`bun run check`, `bun test <file>`). An exception goes on the offending line with a reason and the user's approval.
5. Update `docs/context/enforced-rules.md`: one row per rule with what enforces it. A rule that only prose enforces is a "prose only" row. When the user corrects a mistake that already has a "prose only" row, it repeated: fix it at a higher level in the same change. Delete a row once its mistake cannot happen.
6. If the user asked for a PR, run the `opening-a-pr` Playbook.

Do not weaken or delete a check to make a change pass. Ask before a fix changes product behavior or deletes a user-visible path.

**Principles:** `encode-lessons-in-structure`, `fix-root-causes`, `prove-it-works`, `migrate-callers-then-delete-legacy-apis`, `sequence-verifiable-units`.

**Reply:** each class with its two occurrences, the level you picked and why a higher one did not work, the fail-then-pass proof for each check, and the rows you changed in `docs/context/enforced-rules.md`.

---

Adapted from Lauren Tan's MIT-licensed [pstack `correct` skill](https://github.com/cursor/plugins/tree/main/pstack). The rule table moves from the agent instruction file to `docs/context/enforced-rules.md`; rewritten for Pi.
